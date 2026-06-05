/**
 * Shared PnL math for any single-sided SOL position (VP or live).
 *
 * Single source of truth for position PnL. Replaces the previous pair of
 * parallel code paths: the old `computeVirtualPnl` in `manage-virtual.js` and
 * the cached-field math in `merge-virtual-positions.js`. Paper trading
 * (VPs) and live positions will both call this function (live support
 * is a future extension; currently the function is VP-shaped).
 *
 * Step 2 of meridian-wie (P1 cache-free refactor). See design in
 * `bd show meridian-wie`.
 */

import BN from "bn.js";
import { config } from "../config.js";

// Q64.64 scale factor and swap function from SDK.
// Pre-loaded at module init (dlmm.js always imports the SDK before any
// computePositionPnl code runs, so these resolve instantly).
let _PRICE_SCALE = null;
let _swapExactInQuoteAtBin = null;
import("@meteora-ag/dlmm").then(mod => {
  _PRICE_SCALE = BigInt(mod.SCALE.toString());
  _swapExactInQuoteAtBin = mod.swapExactInQuoteAtBin;
});
import { log } from "../logger.js";

const ZERO = new BN(0);
const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * Fixed-point multiply-then-downshift (Q64.64 arithmetic).
 * Equivalent to the SDK's internal mulShr(a, b, 64, Down) for positive BN values.
 */
function mulShr(a, b, shift) {
  return a.mul(b).shrn(shift);
}

/**
 * Given a position's deploy-time bin_shares and current bin state, compute
 * position value, unclaimed fees, and PnL using the SDK's exact per-bin
 * withdrawal math.
 *
 * Per-bin formulas (verified against Meteora DLMM docs):
 *   ourX  = shares * bin.xAmount / bin.supply      (withdrawal pro-rata)
 *   ourY  = shares * bin.yAmount / bin.supply
 *   unclaimedFeeX = shares * (currentStored - deployStored) / 2^64
 *
 * Token X value & fees are converted to Y (SOL) lamports via Q64.64 price:
 *   ourXInY = ourX * priceBN >> 64
 *   feeXInY  = unclaimedFeeX * priceBN >> 64
 *
 * @param {object}   position  Position metadata (currently VP-shaped)
 *                              Required: bin_shares, lower_bin, amount_sol,
 *                                        initial_value_usd
 *                              Optional: deploy_gas_sol, close_gas_sol,
 *                                        gas_cost_sol (legacy), id, pair
 * @param {object[]} binData   Current bin state from getBinsInRange
 * @param {number}   solPrice  Current SOL/USD price (0 = skip USD calcs)
 * @param {object}   [opts]
 * @param {number|null} [opts.closeGasSolOverride]  Fresh close-gas estimate
 *                                                   (bypasses vp.close_gas_sol)
 * @param {number|null} [opts.activeBinId]          Active bin (required for
 *                                                   real-depth slippage)
 * @returns {{ positionValueSol, unclaimedFeesSol, unclaimedFeesUsd, pnlUsd, pnlPct,
 *             currentValueUsd, initialValueUsd, perBin, ... }}
 */
export function computePositionPnl(position, binData, solPrice, opts = {}) {
  const { closeGasSolOverride = null, activeBinId = null } = opts;
  const shareMap = new Map();
  for (const s of position.bin_shares || []) {
    shareMap.set(s.binId, s);
  }

  let totalValueYLamports = ZERO;
  let totalFeeYLamports = ZERO;
  const perBin = [];

  // Iterate shareMap so missing bins in binData are handled (default to 0)
  for (const [binId, share] of shareMap) {
    const b = binData.find((x) => x.binId === binId);

    const shares = new BN(share.shares);
    const supply = b ? new BN(b.supply ?? "0") : ZERO;
    const priceBN = b ? new BN(b.priceQ64) : ZERO;

    // If bin missing from RPC or has no supply → 0 value, 0 fees
    const xAmount = b ? new BN(b.xAmount ?? "0") : ZERO;
    const yAmount = b ? new BN(b.yAmount ?? "0") : ZERO;

    // VP shares are computed as if we deposited (inLiquidity * supply / binLiquidity),
    // but the on-chain supply never includes our virtual deposit. We must add our
    // shares to supply to simulate the deposit — otherwise for bins that were empty
    // at deploy time (shares = depositY * 2^64, supply = 0 → later non-zero),
    // the withdrawal ratio shares/supply is inflated by ~2^64 ≈ 1.84×10¹⁹.
    //
    // Trade-off: as real LPs deposit/withdraw, on-chain supply changes but our
    // shares stay fixed — the VP's simulated share fraction shifts over time.
    // This models dilution realistically in direction, but has a second-order gap:
    // real subsequent depositors' shares would be computed against a supply that
    // includes ours, so their share count would differ slightly. For typical deploy
    // sizes (< 5% of bin liquidity) this is negligible.
    const effectiveSupply = supply.add(shares);
    const ourX = effectiveSupply.isZero() ? ZERO : shares.mul(xAmount).div(effectiveSupply);
    const ourY = effectiveSupply.isZero() ? ZERO : shares.mul(yAmount).div(effectiveSupply);

    // Convert X lamports to Y (SOL) lamports: ourX * price / 2^64
    const ourXInYLamports = mulShr(ourX, priceBN, 64);
    const binValueYLamports = ourY.add(ourXInYLamports);

    // Unclaimed fees = shares * (currentFeePerToken - storedFeePerToken) / 2^64
    const storedFeeX = new BN(share.feeXPerTokenComplete ?? "0");
    const storedFeeY = new BN(share.feeYPerTokenComplete ?? "0");
    const currentFeeX = b ? new BN(b.feeAmountXPerTokenStored ?? "0") : storedFeeX;
    const currentFeeY = b ? new BN(b.feeAmountYPerTokenStored ?? "0") : storedFeeY;
    const feeXDelta = BN.max(currentFeeX.sub(storedFeeX), ZERO);
    const feeYDelta = BN.max(currentFeeY.sub(storedFeeY), ZERO);

    // Fee = shares × feeDelta / 2^128
    // shares carry 2^64 from SDK liquidity math; feePerToken carries another 2^64.
    // Multiplying first then shifting by 128 avoids precision loss for small positions
    // (the old shares.shrn(64) approach truncated to zero when shares < 2^64).
    const unclaimedFeeX = mulShr(shares, feeXDelta, 128); // in X lamports
    const unclaimedFeeY = mulShr(shares, feeYDelta, 128); // in Y lamports
    // Convert X fee lamports to Y (SOL) lamports using the same Q64.64 price
    const unclaimedFeeXInYLamports = mulShr(unclaimedFeeX, priceBN, 64);

    totalValueYLamports = totalValueYLamports.add(binValueYLamports);
    totalFeeYLamports = totalFeeYLamports.add(unclaimedFeeXInYLamports).add(unclaimedFeeY);

    perBin.push({
      binId,
      ourX: ourX.toString(10),
      ourY: ourY.toString(10),
      binValueYLamports: binValueYLamports.toString(10),
      unclaimedFeeX: unclaimedFeeX.toString(10),
      unclaimedFeeY: unclaimedFeeY.toString(10),
    });
  }

  const rawPositionValueSol = Number(totalValueYLamports) / LAMPORTS_PER_SOL;
  const unclaimedFeesSol = Number(totalFeeYLamports) / LAMPORTS_PER_SOL;

  // Deduct simulated transaction costs for realistic VP PnL:
  //   - Deploy gas: frozen at deploy time (position.deploy_gas_sol) — represents
  //     the actual cost paid to put the position on-chain.
  //   - Close gas: re-estimated at close time using current priority fee,
  //     passed in via closeGasSolOverride. Falls back to position.close_gas_sol
  //     (initial deploy-time estimate) when not provided.
  //   - Slippage: real on-chain X→Y swap simulation (estimateSlippageLamports).
  //     Walks bins below the active price, summing Y reserves, and compares
  //     actual output to the theoretical no-slippage output. Falls back to
  //     config.management.vpSlippagePctUnreliable (default 2.0%) when the
  //     estimator returns null (data insufficient).
  // Migration: VPs deployed under the previous version have only
  // position.gas_cost_sol (a single total). Split it by CU ratio to approximate
  // the real deploy vs. close cost (1.38M deploy CU + 300k close CU = 1.68M).
  const configFallback = config.management.vpGasCostSol ?? 0.0002;
  // CU ratio: deploy is 82% of total, close is 18% (see tools/gas-estimator.js)
  const DEPLOY_CU = 1_380_000;
  const CLOSE_CU = 300_000;
  const DEPLOY_RATIO = DEPLOY_CU / (DEPLOY_CU + CLOSE_CU); // 0.8214
  let deployGasSol, closeGasSol;
  if (position.deploy_gas_sol != null || position.close_gas_sol != null) {
    // New schema: deploy + close tracked separately
    deployGasSol = position.deploy_gas_sol != null ? position.deploy_gas_sol : configFallback * DEPLOY_RATIO;
    closeGasSol = closeGasSolOverride != null
      ? closeGasSolOverride
      : (position.close_gas_sol != null ? position.close_gas_sol : configFallback * (1 - DEPLOY_RATIO));
  } else if (position.gas_cost_sol != null) {
    // Legacy: single total field — split by CU ratio (82/18)
    deployGasSol = position.gas_cost_sol * DEPLOY_RATIO;
    closeGasSol = closeGasSolOverride != null ? closeGasSolOverride : position.gas_cost_sol * (1 - DEPLOY_RATIO);
  } else {
    // No gas data — use config fallback (split by CU ratio)
    deployGasSol = configFallback * DEPLOY_RATIO;
    closeGasSol = closeGasSolOverride != null ? closeGasSolOverride : configFallback * (1 - DEPLOY_RATIO);
  }
  const gasCostSol = deployGasSol + closeGasSol;
  // Real slippage from on-chain X→Y swap simulation. Returns bigint|null.
  //   - bigint: Y-lamports shortfall (0n is legitimate: no slippage)
  //   - null:   data insufficient (pre-check or post-check failed)
  // The caller applies a 1-tier unreliable-data fallback premium.
  const unreliablePct = config.management.vpSlippagePctUnreliable ?? 2.0;
  let slippagePct;
  const slippageLamports = estimateSlippageLamports(perBin, binData, activeBinId, {
    lowerBin: position.lower_bin,
    poolParams: opts.poolParams,
  });
  if (slippageLamports === null) {
    // Data insufficient — apply the unreliable-data safety premium.
    // vp_warn gives pool memory a signal to flag thin pools.
    if (position.id && position.pair) {
      log("vp_warn", `VP ${position.id} (${position.pair}) slippage data insufficient — using ${unreliablePct}% safety premium`);
    }
    slippagePct = unreliablePct;
  } else {
    // Express shortfall as % of total position value (X-component loss is
    // already captured in the shortfall; this denominator keeps the %
    // comparable to position size).
    const shortfallSol = Number(slippageLamports) / LAMPORTS_PER_SOL;
    slippagePct = rawPositionValueSol > 0
      ? (shortfallSol / rawPositionValueSol) * 100
      : 0;
  }
  const slippageSol = rawPositionValueSol * (slippagePct / 100);
  const positionValueSol = Math.max(0, rawPositionValueSol - gasCostSol - slippageSol);

  // ── PnL breakdown (SOL-denominated for consistency) ─────────────
  const initialSol = position.amount_sol || 0;
  const rawPnlSol = rawPositionValueSol - initialSol;          // mark-to-market PnL before fees/costs (not pure IL)
  const totalCostSol = gasCostSol + slippageSol;           // simulated costs
  const netPnlSol = positionValueSol + unclaimedFeesSol - initialSol;  // net PnL in SOL

  const unclaimedFeesUsd = unclaimedFeesSol * solPrice;
  const currentValueUsd = positionValueSol * solPrice + unclaimedFeesUsd;
  const initialValueUsd = position.initial_value_usd || 0;
  const pnlUsd = currentValueUsd - initialValueUsd;
  const pnlPct = initialValueUsd > 0 ? (pnlUsd / initialValueUsd) * 100 : 0;

  // Log anomaly when PnL is absurd (> 1,000,000%) — likely a price conversion issue
  if (pnlPct > 1_000_000) {
    log("vp_anomaly", `Virtual ${position.id} absurd PnL ${pnlPct.toExponential(4)}%. initialUSD=${initialValueUsd}, currentUSD=${currentValueUsd}, posSol=${positionValueSol}`);
    for (const pb of perBin) {
      const b = binData.find((x) => x.binId === pb.binId);
      log("vp_anomaly", `  bin ${pb.binId}: price=${b?.price}, ourX=${pb.ourX}, ourY=${pb.ourY}, valYLamports=${pb.binValueYLamports}`);
    }
  }

  const pnlSolPct = initialSol > 0 ? (netPnlSol / initialSol) * 100 : 0;
  const ilUsd = rawPnlSol * solPrice;
  const totalCostUsd = totalCostSol * solPrice;
  const feesUsd = unclaimedFeesUsd;

  return {
    positionValueSol,
    unclaimedFeesSol,
    unclaimedFeesUsd,
    pnlUsd,
    pnlPct,
    currentValueUsd,
    initialValueUsd,
    // PnL breakdown (SOL)
    rawPnlSol,                  // mark-to-market PnL before fees/costs
    feesSol: unclaimedFeesSol,
    deployGasSol,               // frozen at deploy time
    closeGasSol,                // re-estimated on each cycle / at close
    gasCostSol,                 // = deploy + close
    slippageSol,
    totalCostSol,
    netPnlSol,              // net PnL in SOL (after IL + fees - costs)
    pnlSolPct,              // SOL PnL %
    // PnL breakdown (USD)
    ilUsd,
    feesUsd,
    gasCostUsd: gasCostSol * solPrice,
    slippageCostUsd: slippageSol * solPrice,
    totalCostUsd,
    perBin,
  };
}

/**
 * Estimate slippage for closing a single-sided SOL (Y-only) LP position.
 *
 * For a Y-only position:
 *   - Bins ≤ active bin: we hold Y (no swap needed to extract)
 *   - Bins > active bin: we hold X (must swap to Y to flatten)
 *
 * To flatten, we swap our X through bins ≤ active (consuming their Y reserves).
 * Real slippage = how much Y we lose vs the theoretical no-slippage output.
 *
 * This is a LOWER-BOUND ESTIMATOR. The algorithm assumes the swap path stays
 * within `binData` (which is fetched for the position's range, typically 35-69
 * bins). For the median Meridian deploy (position size from computeDeployAmount,
 * 80-125 bin step), this holds in practice. See docs/vp-slippage-plan.md.
 *
 * Hybrid safety check (returns null on data insufficient):
 *   - Pre-check: if minBin in binData > opts.lowerBin - 10, log + return null
 *   - Post-check: if swap walk exits with remainingX > 0n, log + return null
 *
 * @param {Object[]} perBin     Per-bin ourX/ourY from computePositionPnl
 * @param {Object[]} binData    Current bin state from getBinsInRange (or wider)
 * @param {number}   activeBinId  Pool's current active bin
 * @param {Object}   [opts]
 * @param {number}   [opts.lowerBin]  Position's lower bin (for pre-check)
 * @returns {bigint|null}  Y-lamports shortfall, or null if data insufficient.
 *                          - bigint >= 0: real shortfall (0n is valid: no slippage)
 *                          - null: data insufficient, caller applies fallback
 */
export function estimateSlippageLamports(perBin, binData, activeBinId, opts = {}) {
  const PRICE_SCALE = _PRICE_SCALE;
  const swapFn = _swapExactInQuoteAtBin;
  const { poolParams } = opts;

  // ── Guard: missing active bin → null ──────────────────────────
  if (activeBinId == null) return null;

  // 1. Sum X to swap (only from bins > active)
  let remainingX = 0n;
  for (const pb of perBin) {
    if (pb.binId > activeBinId) {
      remainingX += BigInt(pb.ourX ?? "0");
    }
  }
  if (remainingX === 0n) return 0n;

  // 2. Find the active bin's price (theoretical "no slippage" price)
  const activeBin = binData.find(b => b.binId === activeBinId);
  if (!activeBin) return null;
  const activePriceBN = BigInt(activeBin.priceQ64 ?? "0");
  if (activePriceBN === 0n) return null;

  // 3. Theoretical Y at no-slippage: X × activePrice / SCALE
  const theoreticalY = (remainingX * activePriceBN) / PRICE_SCALE;

  // 4. Walk bins ≤ active in price-DESCENDING order.
  const binsBelowActive = binData
    .filter(b => b.binId <= activeBinId)
    .sort((a, b) => {
      const aP = BigInt(a.priceQ64 ?? "0"), bP = BigInt(b.priceQ64 ?? "0");
      return bP > aP ? 1 : bP < aP ? -1 : 0;
    });

  if (swapFn && poolParams && poolParams.binStep != null && poolParams.sParameter != null && poolParams.vParameter != null) {
    // ── SDK path: use swapExactInQuoteAtBin for exact on-chain parity ──
    // Each swap step properly accounts for the pool's base + variable fee
    // via the SDK's sParameter / vParameter. Fees are deducted from inAmount;
    // amountOut is what the swapper receives.
    const { binStep, sParameter, vParameter } = poolParams;
    let totalYReceived = 0n;

    for (const bin of binsBelowActive) {
      if (remainingX <= 0n) break;
      if (!bin.yAmount || !bin.priceQ64) continue;

      // Convert bin data to SDK Bin shape (requires BN for amounts)
      const sdkBin = {
        binId: bin.binId,
        xAmount: new BN(bin.xAmount ?? "0"),
        yAmount: new BN(bin.yAmount ?? "0"),
        supply: new BN(bin.supply ?? "0"),
        price: bin.price,
        priceQ64: bin.priceQ64,
      };

      // inAmount includes fee — SDK splits it into fee + actual swap
      const inAmount = new BN(remainingX.toString());
      const { amountIn, amountOut } = swapFn(
        sdkBin, binStep, sParameter, vParameter, inAmount, false, // swapForY=false (X→Y)
      );

      totalYReceived += BigInt(amountOut.toString());
      remainingX -= BigInt(amountIn.toString());
    }

    if (remainingX > 0n) return null; // couldn't complete
    return theoreticalY > totalYReceived ? theoreticalY - totalYReceived : 0n;
  }

  // ── Manual path: simple price-based walk (fallback when poolParams absent) ──
  let totalYReceived = 0n;
  for (const bin of binsBelowActive) {
    if (remainingX <= 0n) break;
    const yAvailable = BigInt(bin.yAmount ?? "0");
    const priceBN = BigInt(bin.priceQ64 ?? "0");
    if (yAvailable === 0n || priceBN === 0n) continue;

    const maxXCanSwap = (yAvailable * PRICE_SCALE) / priceBN;
    const xToSwap = remainingX < maxXCanSwap ? remainingX : maxXCanSwap;
    const yReceived = (xToSwap * priceBN) / PRICE_SCALE;
    totalYReceived += yReceived;
    remainingX -= xToSwap;
  }

  if (remainingX > 0n) return null;
  return theoreticalY > totalYReceived ? theoreticalY - totalYReceived : 0n;
}
