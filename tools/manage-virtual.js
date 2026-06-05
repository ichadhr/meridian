import BN from "bn.js";
import { getBinsInRange, getConnection } from "./dlmm.js";
import {
  listVirtualPositions,
  updateVirtualPosition,
  closeVirtualPosition,
} from "./dry-run-state.js";
import { fetchSolPrice } from "./wallet.js";
import { recordPoolDeploy } from "../pool-memory.js";
import { config } from "../config.js";
import { log } from "../logger.js";
import { estimateCloseGasSol, samplePriorityFee } from "./gas-estimator.js";
import { getVirtualCloseRule } from "./virtual-close-rule.js";

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
 * Given the deploy-time bin_shares and current bin state, compute position
 * value and unclaimed fees using the SDK's exact per-bin withdrawal math.
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
 * @param {object}   vp       Virtual position from dry-run-state
 * @param {object[]} binData  Current bin state from getBinsInRange
 * @param {number}   solPrice Current SOL/USD price (0 = skip USD calcs)
 * @returns {{ positionValueSol, unclaimedFeesSol, unclaimedFeesUsd, pnlUsd, pnlPct, currentValueUsd, initialValueUsd, perBin }}
 */
export function computeVirtualPnl(vp, binData, solPrice, opts = {}) {
  // Optional override for close gas (in SOL). Pass in to re-estimate close
  // gas at the current priority fee. If omitted, uses vp.close_gas_sol.
  // activeBinId is required for the new real-depth slippage algorithm
  // (see estimateSlippageLamports below). Pass it from getBinsInRange's
  // `{activeBin, bins}` result.
  const { closeGasSolOverride = null, activeBinId = null } = opts;
  const shareMap = new Map();
  for (const s of vp.bin_shares || []) {
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
  //   - Deploy gas: frozen at deploy time (vp.deploy_gas_sol) — represents
  //     the actual cost paid to put the position on-chain.
  //   - Close gas: re-estimated at close time using current priority fee,
  //     passed in via closeGasSolOverride. Falls back to vp.close_gas_sol
  //     (initial deploy-time estimate) when not provided.
  //   - Slippage: real on-chain X→Y swap simulation (estimateSlippageLamports).
  //     Walks bins below the active price, summing Y reserves, and compares
  //     actual output to the theoretical no-slippage output. Falls back to
  //     config.management.vpSlippagePctUnreliable (default 2.0%) when the
  //     estimator returns null (data insufficient).
  // Migration: VPs deployed under the previous version have only
  // vp.gas_cost_sol (a single total). Split it by CU ratio to approximate
  // the real deploy vs. close cost (1.38M deploy CU + 300k close CU = 1.68M).
  const configFallback = config.management.vpGasCostSol ?? 0.0002;
  // CU ratio: deploy is 82% of total, close is 18% (see tools/gas-estimator.js)
  const DEPLOY_CU = 1_380_000;
  const CLOSE_CU = 300_000;
  const DEPLOY_RATIO = DEPLOY_CU / (DEPLOY_CU + CLOSE_CU); // 0.8214
  let deployGasSol, closeGasSol;
  if (vp.deploy_gas_sol != null || vp.close_gas_sol != null) {
    // New schema: deploy + close tracked separately
    deployGasSol = vp.deploy_gas_sol != null ? vp.deploy_gas_sol : configFallback * DEPLOY_RATIO;
    closeGasSol = closeGasSolOverride != null
      ? closeGasSolOverride
      : (vp.close_gas_sol != null ? vp.close_gas_sol : configFallback * (1 - DEPLOY_RATIO));
  } else if (vp.gas_cost_sol != null) {
    // Legacy: single total field — split by CU ratio (82/18)
    deployGasSol = vp.gas_cost_sol * DEPLOY_RATIO;
    closeGasSol = closeGasSolOverride != null ? closeGasSolOverride : vp.gas_cost_sol * (1 - DEPLOY_RATIO);
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
  const slippageLamports = estimateSlippageLamports(perBin, binData, activeBinId, { lowerBin: vp.lower_bin });
  if (slippageLamports === null) {
    // Data insufficient — apply the unreliable-data safety premium.
    // vp_warn gives pool memory a signal to flag thin pools.
    log("vp_warn", `VP ${vp.id} (${vp.pair}) slippage data insufficient — using ${unreliablePct}% safety premium`);
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
  const initialSol = vp.amount_sol || 0;
  const rawPnlSol = rawPositionValueSol - initialSol;          // mark-to-market PnL before fees/costs (not pure IL)
  const totalCostSol = gasCostSol + slippageSol;           // simulated costs
  const netPnlSol = positionValueSol + unclaimedFeesSol - initialSol;  // net PnL in SOL

  const unclaimedFeesUsd = unclaimedFeesSol * solPrice;
  const currentValueUsd = positionValueSol * solPrice + unclaimedFeesUsd;
  const initialValueUsd = vp.initial_value_usd || 0;
  const pnlUsd = currentValueUsd - initialValueUsd;
  const pnlPct = initialValueUsd > 0 ? (pnlUsd / initialValueUsd) * 100 : 0;

  // Log anomaly when PnL is absurd (> 1,000,000%) — likely a price conversion issue
  if (pnlPct > 1_000_000) {
    log("vp_anomaly", `Virtual ${vp.id} absurd PnL ${pnlPct.toExponential(4)}%. initialUSD=${initialValueUsd}, currentUSD=${currentValueUsd}, posSol=${positionValueSol}`);
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
 * @param {Object[]} perBin     Per-bin ourX/ourY from computeVirtualPnl
 * @param {Object[]} binData    Current bin state from getBinsInRange (or wider)
 * @param {number}   activeBinId  Pool's current active bin
 * @param {Object}   [opts]
 * @param {number}   [opts.lowerBin]  Position's lower bin (for pre-check)
 * @returns {bigint|null}  Y-lamports shortfall, or null if data insufficient.
 *                          - bigint >= 0: real shortfall (0n is valid: no slippage)
 *                          - null: data insufficient, caller applies fallback
 */
export function estimateSlippageLamports(perBin, binData, activeBinId, opts = {}) {
  const PRICE_SCALE = 1n << 64n;

  // ── Guard: missing active bin → null (fallback premium in caller) ───
  // Without this, `pb.binId > null` is always false → remainingX stays 0n
  // → function returns 0n → caller treats as legitimate zero slippage,
  // silently disabling the unreliable-data fallback.
  if (activeBinId == null) return null;

  // ── Pre-check: do we have enough data below the position? ──────────
  const lowerBin = opts.lowerBin;
  if (lowerBin != null && binData.length > 0) {
    const minBinInData = Math.min(...binData.map(b => b.binId));
    if (minBinInData > lowerBin - 10) {
      // binData doesn't extend 10 bins below position — pre-check fails
      return null;  // caller logs warning with vp.id
    }
  }

  // 1. Sum X to swap (only from bins > active; Y from bins ≤ active needs no swap)
  let remainingX = 0n;
  for (const pb of perBin) {
    if (pb.binId > activeBinId) {
      // ourX is a stringified BN — guard against missing/null values
      remainingX += BigInt(pb.ourX ?? "0");
    }
  }
  if (remainingX === 0n) return 0n;  // no X to swap = no slippage (legitimate 0)

  // 2. Find the active bin's price (theoretical "no slippage" price)
  const activeBin = binData.find(b => b.binId === activeBinId);
  if (!activeBin) {
    // Active bin is outside our binData (price moved below our range).
    return null;  // caller logs warning
  }
  // priceQ64 may be null/0 if SDK returns a partial/corrupted response
  const activePriceBN = BigInt(activeBin.priceQ64 ?? "0");
  if (activePriceBN === 0n) {
    // Pathological: price is zero but X > 0. Impossible swap.
    return null;  // caller logs warning
  }

  // 3. Theoretical Y output at no-slippage: X × activePrice
  const theoreticalY = (remainingX * activePriceBN) / PRICE_SCALE;

  // 4. Walk bins ≤ active in price-DESCENDING order (best price first).
  //    BigInt comparator (NOT Number conversion — Q64.64 values can exceed 2^53)
  const binsBelowActive = binData
    .filter(b => b.binId <= activeBinId)
    .sort((a, b) => {
      const aP = BigInt(a.priceQ64 ?? "0"), bP = BigInt(b.priceQ64 ?? "0");
      return bP > aP ? 1 : bP < aP ? -1 : 0;
    });

  let totalYReceived = 0n;
  for (const bin of binsBelowActive) {
    if (remainingX <= 0n) break;
    const yAvailable = BigInt(bin.yAmount ?? "0");
    const priceBN = BigInt(bin.priceQ64 ?? "0");
    if (yAvailable === 0n || priceBN === 0n) continue;

    // max X this bin can absorb: yAvailable × SCALE / price
    const maxXCanSwap = (yAvailable * PRICE_SCALE) / priceBN;
    const xToSwap = remainingX < maxXCanSwap ? remainingX : maxXCanSwap;

    // Y received = X × price / SCALE
    const yReceived = (xToSwap * priceBN) / PRICE_SCALE;
    totalYReceived += yReceived;
    remainingX -= xToSwap;
  }

  // ── Post-check: did we finish the swap within our data? ──────────
  if (remainingX > 0n) {
    // Pool exhausted within fetched range — couldn't complete swap
    return null;  // caller logs warning
  }

  // 5. Shortfall = theoretical - actual (always >= 0)
  return theoreticalY > totalYReceived ? theoreticalY - totalYReceived : 0n;
}

/**
 * Re-estimate close gas with a FRESH priority fee sample (bypass cache) so
 * the close PnL reflects the real network state at close time. Falls back
 * to the cycle value on RPC failure (logs a warning).
 *
 * Used by both close-rule and trailing-TP close paths in
 * runVirtualManagementCycle.
 *
 * @param {number} cycleCloseGasSol  the cached value from the start of the cycle
 * @param {string} vpId              for logging
 * @returns {Promise<number>}        close gas in SOL
 */
async function getFreshCloseGasSol(cycleCloseGasSol, vpId) {
  try {
    const freshPf = await samplePriorityFee(getConnection(), { fresh: true });
    return await estimateCloseGasSol(getConnection(), freshPf);
  } catch (e) {
    log("vp", `Fresh close gas estimate failed for ${vpId}: ${e.message} — using cycle value`);
    return cycleCloseGasSol;
  }
}

/**
 * Run one management cycle for all open virtual positions.
 * Fetches live bin state, computes PnL, updates state, auto-closes on exit conditions.
 *
 * @returns {object[]} Result array with { id, pair, action, ... } for each VP
 */
export async function runVirtualManagementCycle() {
  const vpList = listVirtualPositions("open");
  if (vpList.length === 0) return [];

  const solPrice = await fetchSolPrice();
  if (solPrice == null) {
    log("vp", "Management cycle skipped: could not fetch valid SOL price");
    return [];
  }

  // Re-estimate close gas once per cycle (cache-deduped — same value used for
  // all VPs in this cycle). Falls back to 0 on RPC failure (logs warning).
  let cycleCloseGasSol = null;
  try {
    cycleCloseGasSol = await estimateCloseGasSol(getConnection());
  } catch (e) {
    log("vp", `Failed to estimate close gas: ${e.message} — using stored vp.close_gas_sol`);
  }

  const mgmtConfig = config.management || {};
  const results = [];

  // Per-cycle in-flight Promise dedup (complements the 30s dlmm.js cache).
  // Coalesces concurrent fetches for the same range within ONE cycle —
  // the dlmm.js cache handles across-cycle dedup via its 30s TTL.
  const binCache = new Map();

  /**
   * Record VP close to pool memory (not lessons/evolution — see NOTES.md).
   * Populates pool-memory.json so the SCREENER can skip pools with past losses.
   */
  function recordVpDeployToPoolMemory(vp, pnl, closeReason) {
    const minutesHeld = vp.deployed_at
      ? Math.floor((Date.now() - new Date(vp.deployed_at).getTime()) / 60000)
      : 0;
    const minutesOOR = vp._oor_minutes || 0;
    const rangeEfficiency = minutesHeld > 0
      ? Math.max(0, (minutesHeld - minutesOOR) / minutesHeld * 100)
      : 0;

    try {
      recordPoolDeploy(vp.pool, {
        pool_name: vp.pool_name || vp.pair,
        base_mint: vp.base_mint ?? null,
        deployed_at: vp.deployed_at,
        closed_at: new Date().toISOString(),
        pnl_pct: pnl.pnlPct,
        pnl_usd: pnl.pnlUsd,
        range_efficiency: rangeEfficiency,
        minutes_held: minutesHeld,
        fees_earned_usd: pnl.unclaimedFeesUsd,
        fees_earned_sol: pnl.unclaimedFeesSol,
        fee_earned_pct: vp.initial_value_usd > 0
          ? ((pnl.unclaimedFeesUsd || 0) / vp.initial_value_usd) * 100
          : null,
        close_reason: closeReason,
        strategy: vp.strategy,
        volatility: null,
      });
    } catch (e) {
      log("vp", `Failed to record VP deploy to pool memory: ${e.message}`);
    }
  }

  for (const vp of vpList) {
    try {
      // ── Fetch bin state (cache key includes range) ─────────────────
      const cacheKey = `${vp.pool}:${vp.lower_bin}:${vp.upper_bin}`;
      if (!binCache.has(cacheKey)) {
        binCache.set(
          cacheKey,
          getBinsInRange({
            pool_address: vp.pool,
            lower_bin: vp.lower_bin,
            upper_bin: vp.upper_bin,
          }).catch((err) => {
            log("vp", `Bin fetch failed for ${vp.id}: ${err.message}`);
            return null;
          }),
        );
      }
      const binResult = await binCache.get(cacheKey);
      if (!binResult || !binResult.bins) {
        log("vp", `Skipping ${vp.id}: no bin data available`);
        continue;
      }

      // ── Compute PnL ───────────────────────────────────────────────
      // Pass cycleCloseGasSol so close gas reflects current priority fee
      // (re-estimated once per cycle for all VPs). Pass activeBin so the
      // real-depth slippage algorithm knows where the price is.
      const activeBin = binResult.activeBin;
      const pnl = computeVirtualPnl(vp, binResult.bins, solPrice, {
        closeGasSolOverride: cycleCloseGasSol,
        activeBinId: activeBin,
      });
      const now = Date.now();
      const isOOR = activeBin > vp.upper_bin;

      // ── OOR tracking (compute BEFORE close rule check) ─────────────
      let effectiveOorMinutes = vp._oor_minutes ?? 0;
      let oorSince = vp._oor_since;
      if (isOOR) {
        if (!oorSince) {
          oorSince = new Date().toISOString();
          effectiveOorMinutes = 0;
        } else {
          const oorTs = new Date(oorSince).getTime();
          effectiveOorMinutes = Number.isFinite(oorTs) ? Math.floor((now - oorTs) / 60000) : 0;
        }
      } else {
        oorSince = null;
        effectiveOorMinutes = 0;
      }

      // ── Accumulated fees (delta since last successful sync) ────────
      const prevUnclaimed = vp._last_unclaimed_fees_usd || 0;
      const newlyAccruedFeesUsd = Math.max(0, pnl.unclaimedFeesUsd - prevUnclaimed);
      const prevUnclaimedSol = vp._last_unclaimed_fees_sol || 0;
      const newlyAccruedFeesSol = Math.max(0, pnl.unclaimedFeesSol - prevUnclaimedSol);

      const updates = {
        current_value_usd: pnl.currentValueUsd,
        total_fees_earned_usd: (vp.total_fees_earned_usd || 0) + newlyAccruedFeesUsd,
        _last_unclaimed_fees_usd: pnl.unclaimedFeesUsd,
        // Native SOL fields — kept in sync with computeVirtualPnl output so
        // the polymorphic _usd display (solMode=true) stays accurate.
        value_sol: pnl.positionValueSol,
        total_fees_earned_sol: (vp.total_fees_earned_sol || 0) + newlyAccruedFeesSol,
        _last_unclaimed_fees_sol: pnl.unclaimedFeesSol,
        pnl_sol: pnl.netPnlSol,
        pnl_sol_pct: pnl.pnlSolPct,
        _peak_pnl_pct: Math.max(vp._peak_pnl_pct || 0, pnl.pnlPct),
        _peak_pnl_sol_pct: Math.max(vp._peak_pnl_sol_pct || 0, pnl.pnlSolPct),
        _oor_since: oorSince,
        _oor_minutes: effectiveOorMinutes,
        _trailing_active: vp._trailing_active || false,
        _trailing_pending: vp._trailing_pending || false,
        _trailing_pending_since: vp._trailing_pending_since || null,
        last_sync_at: new Date().toISOString(),
      };

      // ── Trailing TP state machine (2-cycle confirmation) ──────────
      let trailingActive = updates._trailing_active;
      let trailingPending = updates._trailing_pending;
      let trailingCloseReason = null;

      // Trailing TP decisions must use the same unit as the close rule
      // (matches the display unit). Track both USD and SOL peaks; read the
      // one matching solMode for activation + dropFromPeak comparison.
      const trailingIsSol = !!mgmtConfig.solMode;
      const trailingPeakField = trailingIsSol ? "_peak_pnl_sol_pct" : "_peak_pnl_pct";
      const trailingPeak = updates[trailingPeakField] || 0;
      const trailingCurrentPnl = trailingIsSol ? pnl.pnlSolPct : pnl.pnlPct;

      if (mgmtConfig.trailingTakeProfit && !trailingActive && trailingPeak >= (mgmtConfig.trailingTriggerPct ?? 6)) {
        trailingActive = true;
      }

      if (mgmtConfig.trailingTakeProfit && trailingActive) {
        const dropFromPeak = trailingPeak - trailingCurrentPnl;
        const effectiveDropPct = mgmtConfig.trailingDropPct ?? 2.5;
        if (dropFromPeak >= effectiveDropPct && trailingCurrentPnl >= 0) {
          if (trailingPending) {
            trailingCloseReason = `trailing TP: peak ${trailingPeak.toFixed(2)}% → current ${trailingCurrentPnl.toFixed(2)}% (dropped ${dropFromPeak.toFixed(2)}% ≥ ${effectiveDropPct}%)`;
          } else {
            trailingPending = true;
            updates._trailing_pending_since = new Date().toISOString();
          }
        } else {
          trailingPending = false;
          updates._trailing_pending_since = null;
        }
      }

      updates._trailing_active = trailingActive;
      updates._trailing_pending = trailingPending;

      // ── Snapshots ──────────────────────────────────────────────────
      const snapshots = vp.snapshots || [];
      snapshots.push({
        at: new Date().toISOString(),
        pnl_pct: pnl.pnlPct,
        pnl_sol_pct: pnl.pnlSolPct,
        value_usd: pnl.currentValueUsd,
        value_sol: pnl.positionValueSol,
        unclaimed_fees_usd: pnl.unclaimedFeesUsd,
        sol_price: solPrice,
        active_bin: activeBin,
        oor_minutes: effectiveOorMinutes,
      });
      if (snapshots.length > 100) snapshots.splice(0, snapshots.length - 100);
      updates.snapshots = snapshots;

      // ── Exit rules (build polymorphic position, call new signature) ─
      // The caller selects the unit once (SOL when solMode, USD otherwise)
      // and the function reads pre-computed polymorphic values. This mirrors
      // the live getDeterministicCloseRule(position, mgmtConfig) shape in
      // index.js, which sees position.pnl_pct from getMyPositions — already
      // polymorphic via mergeVirtualPositions. Without this branching the
      // rule would always check USD PnL while Telegram shows SOL PnL, so
      // TP/SL/trailing-TP decisions would diverge from the display.
      const exitIsSol = !!mgmtConfig.solMode;
      const posForRule = {
        ...vp,
        ...updates,
        pnl_pct: exitIsSol ? pnl.pnlSolPct : pnl.pnlPct,
        total_value_usd: exitIsSol ? pnl.positionValueSol : pnl.currentValueUsd,
        unclaimed_fees_usd: exitIsSol ? pnl.unclaimedFeesSol : pnl.unclaimedFeesUsd,
        // Use the FRESH post-update totals so Rule 5 (low yield) sees this
        // cycle's accrued fees, not the stale pre-update values. For old VPs
        // (no `total_fees_earned_sol` field), `updates.total_fees_earned_sol`
        // still starts at 0 and grows from `newlyAccruedFeesSol` each cycle,
        // bounded by the transition period.
        total_fees_earned_usd: exitIsSol
          ? (updates.total_fees_earned_sol || 0)
          : (updates.total_fees_earned_usd || 0),
        active_bin: activeBin,
      };
      const vpAgeMinutes = vp.deployed_at
        ? Math.floor((Date.now() - new Date(vp.deployed_at).getTime()) / 60000)
        : 0;
      const closeRule = getVirtualCloseRule(posForRule, mgmtConfig, effectiveOorMinutes);
      if (closeRule) {
        // Persist final state BEFORE closing (preserves snapshot, peak, OOR)
        updateVirtualPosition(vp.id, updates);

        // Recompute PnL with a FRESH close-gas estimate (bypasses 60s cache)
        const finalCloseGasSol = await getFreshCloseGasSol(cycleCloseGasSol, vp.id);
        const finalPnl = computeVirtualPnl(vp, binResult.bins, solPrice, {
          closeGasSolOverride: finalCloseGasSol,
          activeBinId: activeBin,
        });

        const closed = closeVirtualPosition(vp.id, closeRule.reason, finalPnl.pnlPct, finalPnl.pnlUsd, {
          close_pnl_sol_pct: finalPnl.pnlSolPct,
          close_pnl_sol: finalPnl.netPnlSol,
          close_il_sol: finalPnl.rawPnlSol,
          close_fees_sol: finalPnl.feesSol,
          close_cost_sol: finalPnl.totalCostSol,
          close_il_usd: finalPnl.ilUsd,
          close_fees_usd: finalPnl.feesUsd,
          close_cost_usd: finalPnl.totalCostUsd,
        });
        if (!closed) {
          log("vp", `VP ${vp.id} (${vp.pair}) close ABORTED — archive write failed, retrying next cycle`);
          continue;
        }
        recordVpDeployToPoolMemory(vp, finalPnl, closeRule.reason);
        results.push({
          id: vp.id, pair: vp.pair, action: "CLOSED", reason: closeRule.reason,
          age_minutes: vpAgeMinutes,
          pnl_pct: finalPnl.pnlPct, pnl_usd: finalPnl.pnlUsd,
          pnl_sol_pct: finalPnl.pnlSolPct, pnl_sol: finalPnl.netPnlSol,
          il_sol: finalPnl.rawPnlSol, unclaimed_fees_sol: finalPnl.feesSol,
          cost_sol: finalPnl.totalCostSol, il_usd: finalPnl.ilUsd,
          unclaimed_fees_usd: finalPnl.feesUsd, cost_usd: finalPnl.totalCostUsd,
        });
        log("vp", `VP ${vp.id} (${vp.pair}) CLOSED: ${closeRule.reason} PnL=${finalPnl.pnlPct.toFixed(2)}% (SOL: ${finalPnl.pnlSolPct.toFixed(2)}%) deployGas=${finalPnl.deployGasSol.toFixed(6)} closeGas=${finalPnl.closeGasSol.toFixed(6)}`);
        continue;
      }

      // ── Trailing TP close (2-cycle confirmed) ──────────────────────
      if (trailingCloseReason) {
        updateVirtualPosition(vp.id, updates);

        // Fresh re-estimate of close gas (same helper as rule-based close)
        const trailingCloseGasSol = await getFreshCloseGasSol(cycleCloseGasSol, vp.id);
        const trailingFinalPnl = computeVirtualPnl(vp, binResult.bins, solPrice, {
          closeGasSolOverride: trailingCloseGasSol,
          activeBinId: activeBin,
        });

        const closed = closeVirtualPosition(vp.id, trailingCloseReason, trailingFinalPnl.pnlPct, trailingFinalPnl.pnlUsd, {
          close_pnl_sol_pct: trailingFinalPnl.pnlSolPct,
          close_pnl_sol: trailingFinalPnl.netPnlSol,
          close_il_sol: trailingFinalPnl.rawPnlSol,
          close_fees_sol: trailingFinalPnl.feesSol,
          close_cost_sol: trailingFinalPnl.totalCostSol,
          close_il_usd: trailingFinalPnl.ilUsd,
          close_fees_usd: trailingFinalPnl.feesUsd,
          close_cost_usd: trailingFinalPnl.totalCostUsd,
        });
        if (!closed) {
          log("vp", `VP ${vp.id} (${vp.pair}) close ABORTED — archive write failed, retrying next cycle`);
          continue;
        }
        recordVpDeployToPoolMemory(vp, trailingFinalPnl, trailingCloseReason);
        results.push({
          id: vp.id, pair: vp.pair, action: "CLOSED", reason: trailingCloseReason,
          age_minutes: vpAgeMinutes,
          pnl_pct: trailingFinalPnl.pnlPct, pnl_usd: trailingFinalPnl.pnlUsd,
          pnl_sol_pct: trailingFinalPnl.pnlSolPct, pnl_sol: trailingFinalPnl.netPnlSol,
          il_sol: trailingFinalPnl.rawPnlSol, unclaimed_fees_sol: trailingFinalPnl.feesSol,
          cost_sol: trailingFinalPnl.totalCostSol, il_usd: trailingFinalPnl.ilUsd,
          unclaimed_fees_usd: trailingFinalPnl.feesUsd, cost_usd: trailingFinalPnl.totalCostUsd,
        });
        log("vp", `VP ${vp.id} (${vp.pair}) CLOSED: ${trailingCloseReason}`);
        continue;
      }

      updateVirtualPosition(vp.id, updates);

      const oorLabel = isOOR ? `OOR ${effectiveOorMinutes}m` : "IN";
      results.push({
        id: vp.id,
        pair: vp.pair,
        action: "STAY",
        age_minutes: vpAgeMinutes,
        pnl_pct: pnl.pnlPct,
        pnl_usd: pnl.pnlUsd,
        pnl_sol: pnl.netPnlSol,
        pnl_sol_pct: pnl.pnlSolPct,
        value_sol: pnl.positionValueSol,
        value_usd: pnl.currentValueUsd,
        unclaimed_fees_usd: pnl.feesUsd,
        unclaimed_fees_sol: pnl.feesSol,
        il_sol: pnl.rawPnlSol,
        cost_sol: pnl.totalCostSol,
        il_usd: pnl.ilUsd,
        cost_usd: pnl.totalCostUsd,
        oor: oorLabel,
      });
    } catch (e) {
      log("vp_error", `VP ${vp.id} management failed: ${e.message}`);
    }
  }

  return results;
}
