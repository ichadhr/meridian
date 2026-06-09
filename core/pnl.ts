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
import { config } from "../config/index.js";
import { log } from "../utils/logger.js";

// Q64.64 scale factor and swap function from SDK.
// Pre-loaded at module init (dlmm.js always imports the SDK before any
// computePositionPnl code runs, so these resolve instantly).
let _PRICE_SCALE: bigint | null = null;
let _swapExactInQuoteAtBin: ((...args: unknown[]) => { amountIn: BN; amountOut: BN }) | null = null;
import("@meteora-ag/dlmm").then((mod) => {
  _PRICE_SCALE = BigInt(mod.SCALE.toString());
  _swapExactInQuoteAtBin = mod.swapExactInQuoteAtBin as typeof _swapExactInQuoteAtBin;
});

const ZERO = new BN(0);
const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * Fixed-point multiply-then-downshift (Q64.64 arithmetic).
 * Equivalent to the SDK's internal mulShr(a, b, 64, Down) for positive BN values.
 */
function mulShr(a: BN, b: BN, shift: number): BN {
  return a.mul(b).shrn(shift);
}

export interface BinShare {
  binId: number;
  shares: string;
  feeXPerTokenComplete?: string;
  feeYPerTokenComplete?: string;
}

export interface BinData {
  binId: number;
  xAmount?: string;
  yAmount?: string;
  supply?: string;
  priceQ64?: string;
  price?: string;
  feeAmountXPerTokenStored?: string;
  feeAmountYPerTokenStored?: string;
  [key: string]: unknown;
}

export interface PositionPnlInput {
  bin_shares?: BinShare[];
  lower_bin?: number;
  amount_sol?: number;
  initial_value_usd?: number;
  deploy_gas_sol?: number;
  close_gas_sol?: number;
  gas_cost_sol?: number;
  id?: string;
  pair?: string;
  [key: string]: unknown;
}

export interface PerBinResult {
  binId: number;
  ourX: string;
  ourY: string;
  binValueYLamports: string;
  unclaimedFeeX: string;
  unclaimedFeeY: string;
}

export interface PositionPnlResult {
  positionValueSol: number;
  unclaimedFeesSol: number;
  unclaimedFeesUsd: number;
  pnlUsd: number;
  pnlPct: number;
  currentValueUsd: number;
  initialValueUsd: number;
  rawPnlSol: number;
  feesSol: number;
  deployGasSol: number;
  closeGasSol: number;
  gasCostSol: number;
  slippageSol: number;
  totalCostSol: number;
  netPnlSol: number;
  pnlSolPct: number;
  ilUsd: number;
  feesUsd: number;
  gasCostUsd: number;
  slippageCostUsd: number;
  totalCostUsd: number;
  perBin: PerBinResult[];
}

export interface ComputePnlOpts {
  closeGasSolOverride?: number | null;
  activeBinId?: number | null;
  poolParams?: {
    binStep?: number;
    sParameter?: unknown;
    vParameter?: unknown;
  };
}

/**
 * Given a position's deploy-time bin_shares and current bin state, compute
 * position value, unclaimed fees, and PnL using the SDK's exact per-bin
 * withdrawal math.
 */
export function computePositionPnl(
  position: PositionPnlInput,
  binData: BinData[],
  solPrice: number,
  opts: ComputePnlOpts = {}
): PositionPnlResult {
  const { closeGasSolOverride = null, activeBinId = null } = opts;
  const shareMap = new Map<number, BinShare>();
  for (const s of position.bin_shares || []) {
    shareMap.set(s.binId, s);
  }

  let totalValueYLamports = ZERO;
  let totalFeeYLamports = ZERO;
  const perBin: PerBinResult[] = [];

  // Iterate shareMap so missing bins in binData are handled (default to 0)
  for (const [binId, share] of shareMap) {
    const b = binData.find((x) => x.binId === binId);

    const shares = new BN(share.shares);
    const supply = b ? new BN(b.supply ?? "0") : ZERO;
    const priceQ64 = b?.priceQ64;
    if (b && priceQ64 == null) log("vp_warn", `bin ${binId} missing priceQ64`);
    const priceBN = priceQ64 != null ? new BN(priceQ64) : ZERO;

    // If bin missing from RPC or has no supply → 0 value, 0 fees
    const xAmount = b ? new BN(b.xAmount ?? "0") : ZERO;
    const yAmount = b ? new BN(b.yAmount ?? "0") : ZERO;

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

    const unclaimedFeeX = mulShr(shares, feeXDelta, 128);
    const unclaimedFeeY = mulShr(shares, feeYDelta, 128);
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

  // Deduct simulated transaction costs for realistic VP PnL
  const configFallback = config.management.vpGasCostSol ?? 0.0002;
  const DEPLOY_CU = 1_380_000;
  const CLOSE_CU = 300_000;
  const DEPLOY_RATIO = DEPLOY_CU / (DEPLOY_CU + CLOSE_CU);
  let deployGasSol: number, closeGasSol: number;
  if (position.deploy_gas_sol != null || position.close_gas_sol != null) {
    deployGasSol = position.deploy_gas_sol != null ? position.deploy_gas_sol : configFallback * DEPLOY_RATIO;
    closeGasSol = closeGasSolOverride != null
      ? closeGasSolOverride
      : (position.close_gas_sol != null ? position.close_gas_sol : configFallback * (1 - DEPLOY_RATIO));
  } else if (position.gas_cost_sol != null) {
    deployGasSol = position.gas_cost_sol * DEPLOY_RATIO;
    closeGasSol = closeGasSolOverride != null ? closeGasSolOverride : position.gas_cost_sol * (1 - DEPLOY_RATIO);
  } else {
    deployGasSol = configFallback * DEPLOY_RATIO;
    closeGasSol = closeGasSolOverride != null ? closeGasSolOverride : configFallback * (1 - DEPLOY_RATIO);
  }
  const gasCostSol = deployGasSol + closeGasSol;

  const unreliablePct = config.management.vpSlippagePctUnreliable ?? 2.0;
  let slippagePct: number;
  const slippageLamports = estimateSlippageLamports(perBin, binData, activeBinId, {
    lowerBin: position.lower_bin,
    poolParams: opts.poolParams,
  });
  if (slippageLamports === null) {
    if (position.id && position.pair) {
      log("vp_warn", `VP ${position.id} (${position.pair}) slippage data insufficient — using ${unreliablePct}% safety premium`);
    }
    slippagePct = unreliablePct;
  } else {
    const shortfallSol = Number(slippageLamports) / LAMPORTS_PER_SOL;
    slippagePct = rawPositionValueSol > 0
      ? (shortfallSol / rawPositionValueSol) * 100
      : 0;
  }
  const slippageSol = rawPositionValueSol * (slippagePct / 100);
  const positionValueSol = Math.max(0, rawPositionValueSol - gasCostSol - slippageSol);

  // ── PnL breakdown (SOL-denominated for consistency) ─────────────
  const initialSol = position.amount_sol || 0;
  const rawPnlSol = rawPositionValueSol - initialSol;
  const totalCostSol = gasCostSol + slippageSol;
  const netPnlSol = positionValueSol + unclaimedFeesSol - initialSol;

  const unclaimedFeesUsd = unclaimedFeesSol * solPrice;
  const currentValueUsd = positionValueSol * solPrice + unclaimedFeesUsd;
  const initialValueUsd = position.initial_value_usd || 0;
  const pnlUsd = currentValueUsd - initialValueUsd;
  const pnlPct = initialValueUsd > 0 ? (pnlUsd / initialValueUsd) * 100 : 0;

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
    rawPnlSol,
    feesSol: unclaimedFeesSol,
    deployGasSol,
    closeGasSol,
    gasCostSol,
    slippageSol,
    totalCostSol,
    netPnlSol,
    pnlSolPct,
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
 * @returns Y-lamports shortfall, or null if data insufficient.
 */
export function estimateSlippageLamports(
  perBin: PerBinResult[],
  binData: BinData[],
  activeBinId: number | null | undefined,
  opts: { lowerBin?: number; poolParams?: { binStep?: number; sParameter?: unknown; vParameter?: unknown } } = {}
): bigint | null {
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
  const activeBin = binData.find((b) => b.binId === activeBinId);
  if (!activeBin) return null;
  const activePriceBN = BigInt(activeBin.priceQ64 ?? "0");
  if (activePriceBN === 0n) return null;

  // 3. Theoretical Y at no-slippage: X × activePrice / SCALE
  const theoreticalY = PRICE_SCALE != null ? (remainingX * activePriceBN) / PRICE_SCALE : 0n;

  // 4. Walk bins ≤ active in price-DESCENDING order.
  const binsBelowActive = binData
    .filter((b) => b.binId <= activeBinId)
    .sort((a, b) => {
      const aP = BigInt(a.priceQ64 ?? "0"), bP = BigInt(b.priceQ64 ?? "0");
      return bP > aP ? 1 : bP < aP ? -1 : 0;
    });

  if (PRICE_SCALE != null && swapFn && poolParams && poolParams.binStep != null && poolParams.sParameter != null && poolParams.vParameter != null) {
    const { binStep, sParameter, vParameter } = poolParams;
    let totalYReceived = 0n;
    const savedRemainingX = remainingX;
    let sdkOk = false;

    try {
      for (const bin of binsBelowActive) {
        if (remainingX <= 0n) break;
        if (!bin.yAmount || !bin.priceQ64) continue;
        const sdkBin = {
          binId: bin.binId,
          amountX: new BN(bin.xAmount ?? "0"),
          amountY: new BN(bin.yAmount ?? "0"),
          price: new BN(bin.priceQ64),
          priceQ64: bin.priceQ64,
        };
        const inAmount = new BN(remainingX.toString());
        const { amountIn, amountOut } = swapFn(
          sdkBin, binStep, sParameter, vParameter, inAmount, true,
        );
        totalYReceived += BigInt(amountOut.toString());
        remainingX -= BigInt(amountIn.toString());
      }
      sdkOk = true;
    } catch (e) {
      remainingX = savedRemainingX;
      log("vp_slippage", `SDK swapExactInQuoteAtBin failed: ${(e as Error)?.message || e} — using manual slippage`);
    }

    if (sdkOk) {
      if (remainingX > 0n) return null;
      return theoreticalY > totalYReceived ? theoreticalY - totalYReceived : 0n;
    }
  }

  // ── Manual path: simple price-based walk (fallback when poolParams absent) ──
  if (PRICE_SCALE == null) return null;
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
