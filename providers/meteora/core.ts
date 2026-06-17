import {
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import BN from "bn.js";
import { config, computeDeployAmount, MIN_SAFE_BINS_BELOW } from "../../config/index.js";
import type { PositionsResult } from "../../types/index.js";
import { log } from "../../utils/logger.js";
import { computePositions, fetchDlmmPnlForPool } from "../solana/index.js";
import {
  trackPosition,
  markLiveOutOfRange,
  markLiveInRange,
  recordLiveClaim,
  recordLiveClose,
  getTrackedPosition,
  minutesLiveOutOfRange,
  syncLiveOpenPositions,
  trackVpPosition,
  recordPerformance,
  isBaseMintOnCooldown,
  isPoolOnCooldown,
  appendDecision,
  getAndClearStagedSignals,
  mergeVpPositions,
} from "../../core/index.js";
import { fetchSolPrice } from "../jupiter/api.js";
import { normalizeMint, getConnection, getWallet } from "../solana/wallet.js";
import { getWalletBalances } from "../solana/balance.js";
import { estimateDeployGasSol, estimateCloseGasSol, samplePriorityFee } from "../solana/gas-estimator.js";
import { agentMeridianJson, getAgentIdForRequests, getAgentMeridianHeaders } from "../hivemind/index.js";
import { safeNum, maybeNum, roundNum, deriveOpenPnlPct, deriveLpAgentPnlPct, getClosedPnlValue, getClosedPnlPct, resolvePerformanceSignalSnapshot, fetchRawOpenPositionsFromMeridian } from "./pnl.js";
import { getDLMM, decimalPriceToQ64, getDlmmProgramId } from "./dlmm.js";
import { assertRangeDoesNotRequireBinArrayInitialization, assertNoInitializeBinArrayInstructions, getPriorityFeeMicroLamports, addPriorityFee, withRetry, sendTxWithRetry, sendTxBatch, formatSolFee } from "./tx.js";
import { shouldUseLpAgentRelay, normalizeExecutionSignatures, signAndSimulateRelayTransactions, signSerializedTransactions } from "../lpagent/relay.js";
import { getPool, getPoolMetadata, invalidatePoolCache } from "./pool-cache.js";
import { fetchLpAgentOpenPositions } from "../lpagent/open-positions.js";

function shouldUseLpAgentRelayForDeploy(): boolean {
  return false;
}

// ─── Bin helpers (active-bin lookup, in-range bins, VP distribution) ───
// Extracted to ./bins.ts. Imported here so deployPosition (below) can
// use them. Public re-exports live in providers/meteora/index.ts.
import {
  getActiveBin,
  _resetBinsInRangeCacheForTesting,
  _setBinsInRangeCacheForTesting,
  _getBinsInRangeCacheSizeForTesting,
  getBinsInRange,
  computeVpYDistribution,
} from "./bins.js";

// ─── Deploy Position ───────────────────────────────────────────
export async function deployPosition({
  pool_address,
  amount_sol, // legacy: will be used as amount_y if amount_y is not provided
  amount_x,
  amount_y,
  strategy,
  bins_below,
  bins_above,
  downside_pct,
  upside_pct,
  pool_name,
  bin_step,
  base_fee,
  volatility,
  fee_tvl_ratio,
  organic_score,
}: {
  pool_address: string;
  amount_sol?: number | null;
  amount_x?: number | null;
  amount_y?: number | null;
  strategy?: string | null;
  bins_below?: number | null;
  bins_above?: number | null;
  downside_pct?: number | null;
  upside_pct?: number | null;
  pool_name?: string;
  bin_step?: number;
  base_fee?: number;
  volatility?: number;
  fee_tvl_ratio?: number;
  organic_score?: number;
}): Promise<any> {
  pool_address = normalizeMint(pool_address);
  const activeStrategy = strategy || config.strategy.strategy;
  let activeBinsBelow = bins_below ?? config.strategy.defaultBinsBelow ?? config.strategy.minBinsBelow;
  let activeBinsAbove = bins_above ?? 0;
  const parsedVolatility = volatility == null ? null : Number(volatility);
  const normalizedVolatility = parsedVolatility != null && Number.isFinite(parsedVolatility) ? parsedVolatility : null;

  if (volatility != null && (normalizedVolatility == null || normalizedVolatility <= 0)) {
    throw new Error(`Invalid volatility ${volatility} — refusing deploy because the volatility feed is unusable.`);
  }

  if (isPoolOnCooldown(pool_address)) {
    log("deploy", `Pool ${pool_address.slice(0, 8)} is on cooldown — skipping`);
    return { success: false, error: "Pool on cooldown — was recently closed with a cooldown reason. Try a different pool." };
  }

  const { DLMM, StrategyType, getBinIdFromPrice, getPriceOfBinByBinId } = await getDLMM();
  if (!config.tokens?.SOL) {
    throw new Error("config.tokens.SOL is missing — refusing deploy");
  }
  const pool = await getPool(pool_address);
  if (pool.lbPair?.tokenYMint?.toString() !== config.tokens.SOL) {
    throw new Error(`Only SOL-paired pools are supported (got quote mint ${pool.lbPair?.tokenYMint?.toString() ?? "unknown"}).`);
  }
  const baseMint = pool.lbPair.tokenXMint.toString();
  if (isBaseMintOnCooldown(baseMint)) {
    log("deploy", `Base mint ${baseMint.slice(0, 8)} is on cooldown — skipping deploy for pool ${pool_address.slice(0, 8)}`);
    return { success: false, error: "Token on cooldown — recently closed out-of-range too many times. Try a different token." };
  }
  const activeBin = await pool.getActiveBin();
  const actualBinStep = pool.lbPair.binStep;
  const activePrice = Number(getPriceOfBinByBinId(activeBin.binId, actualBinStep).toString());

  if (downside_pct != null || upside_pct != null) {
    const downsidePct = Math.max(0, Number(downside_pct ?? 0));
    const upsidePct = Math.max(0, Number(upside_pct ?? 0));

    if (!Number.isFinite(downsidePct) || !Number.isFinite(upsidePct)) {
      throw new Error("downside_pct and upside_pct must be valid numbers.");
    }
    if (downsidePct >= 100) {
      throw new Error("downside_pct must be less than 100.");
    }

    const lowerTargetPrice = activePrice * (1 - downsidePct / 100);
    const upperTargetPrice = activePrice * (1 + upsidePct / 100);
    const lowerBinId = getBinIdFromPrice(lowerTargetPrice, actualBinStep, true);
    const upperBinId = getBinIdFromPrice(upperTargetPrice, actualBinStep, false);

    activeBinsBelow = Math.max(0, activeBin.binId - lowerBinId);
    activeBinsAbove = Math.max(0, upperBinId - activeBin.binId);
  }

  const strategyMap: Record<string, any> = {
    spot: StrategyType.Spot,
    curve: StrategyType.Curve,
    bid_ask: StrategyType.BidAsk,
  };

  const strategyType = strategyMap[activeStrategy];
  if (strategyType === undefined) {
    throw new Error(`Invalid strategy: ${activeStrategy}. Use spot, curve, or bid_ask.`);
  }

  // Calculate amounts
  // If no explicit SOL amount is provided, fall back to the configured dynamic deploy size.
  const walletBalances = await getWalletBalances();
  const fallbackAmountY =
    amount_y == null && amount_sol == null
      ? computeDeployAmount(walletBalances.sol)
      : 0;
  const solPrice = await fetchSolPrice();
  if (solPrice == null) {
    throw new Error("Cannot deploy: could not fetch a valid SOL/USD price. Refusing to store garbage initial_value_usd.");
  }
  const finalAmountY = Number(amount_y ?? amount_sol ?? fallbackAmountY);
  const finalAmountX = Number(amount_x ?? 0);
  if (!Number.isFinite(finalAmountY) || !Number.isFinite(finalAmountX) || finalAmountY < 0 || finalAmountX < 0) {
    throw new Error("Invalid deploy amount: amount_x and amount_y must be valid non-negative numbers.");
  }
  if (finalAmountX > 0) {
    throw new Error("Unsupported deploy amount: this agent only supports single-side SOL deploys. Use amount_y/amount_sol and keep amount_x=0.");
  }
  if (finalAmountY <= 0) {
    throw new Error("Invalid deploy amount: provide a positive amount_y/amount_sol.");
  }
  const isSingleSidedSol = finalAmountX <= 0 && finalAmountY > 0;
  if (isSingleSidedSol && (Number(bins_above ?? 0) > 0 || Number(upside_pct ?? 0) > 0)) {
    throw new Error(
      "Single-side SOL deploy cannot use bins_above or upside_pct. Use amount_y with bins_below only; the upper bin is the SDK active bin.",
    );
  }
  if (isSingleSidedSol) {
    activeBinsAbove = 0;
  }
  activeBinsBelow = Number(activeBinsBelow);
  activeBinsAbove = Number(activeBinsAbove);
  if (!Number.isFinite(activeBinsBelow) || !Number.isFinite(activeBinsAbove)) {
    throw new Error("Invalid bin range: bins_below and bins_above must be valid numbers.");
  }
  if (activeBinsBelow < 0 || activeBinsAbove < 0) {
    throw new Error("Invalid bin range: bins_below and bins_above cannot be negative.");
  }
  if (!Number.isInteger(activeBinsBelow) || !Number.isInteger(activeBinsAbove)) {
    throw new Error("Invalid bin range: bins_below and bins_above must be whole-bin integers.");
  }
  const minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Number(config.strategy.minBinsBelow ?? MIN_SAFE_BINS_BELOW));
  const totalBins = activeBinsBelow + activeBinsAbove;
  if (totalBins < minBinsBelow) {
    throw new Error(
      `Invalid deploy range: total bins ${totalBins} is below minimum ${minBinsBelow}. Refusing 1-bin/tiny-range deploy.`,
    );
  }

  // Compute bin range and deposit amounts (needed for both dry-run and real deploy)
  const isWideRange = totalBins > 69;
  const minBinId = activeBin.binId - activeBinsBelow;
  const maxBinId = isSingleSidedSol ? activeBin.binId : activeBin.binId + activeBinsAbove;

  if (minBinId > maxBinId) {
    throw new Error(`Invalid bin range: ${minBinId} -> ${maxBinId}`);
  }
  if (isSingleSidedSol && maxBinId !== activeBin.binId) {
    throw new Error(
      `Single-side SOL deploy must end at the SDK active bin. Expected ${activeBin.binId}, got ${maxBinId}.`,
    );
  }

  const totalYLamports = new BN(Math.floor(finalAmountY * 1e9));

  // ── Fetch entry market data at deploy time (live only) ────
  // Captures pool market state (MCAP, TVL, volume) when position opens,
  // used later by HiveMind to correlate entry conditions with performance.
  // Skipped in DRY_RUN — paper trading VPs push lessons locally, not to HiveMind.
  let entryMarket: Record<string, number | null> = {};
  if (process.env.DRY_RUN !== "true") {
    const entryDetail = await fetch(
      `https://pool-discovery-api.datapi.meteora.ag/pools?page_size=1&filter_by=${encodeURIComponent(`pool_address=${pool_address}`)}&timeframe=${encodeURIComponent(config.screening?.timeframe || "5m")}`
    ).then((r) => r.json()).catch(() => null) as any;
    const ep = entryDetail?.data?.[0];
    if (ep) {
      entryMarket = {
        entry_mcap: parseFloat(ep?.token_x?.market_cap) || null,
        entry_tvl: parseFloat(ep?.tvl ?? ep?.active_tvl) || null,
        entry_volume: parseFloat(ep?.volume) || null,
      };
    }
  }

  // ── DRY RUN: track as virtual position ─────────────────────────
  if (process.env.DRY_RUN === "true") {
    let vpId = null;
    try {
      const { bins } = await getBinsInRange({ pool_address, lower_bin: minBinId, upper_bin: maxBinId, skipCache: true });
      log("deploy", `DRY_RUN: bins=${bins.length}, activeBin=${activeBin.binId}, hasActive=${bins.some((b: any) => b.binId === activeBin.binId)}, strategy=${activeStrategy}`);
      if (bins.length > 0) {
        log("deploy", `DRY_RUN: sample0=price=${bins[0].price}, xAmt=${bins[0].xAmount}, yAmt=${bins[0].yAmount}, supply=${bins[0].supply}`);
      }
      const SCALE = new BN(1).shln(64); // Q64.64 scaling factor

      // ── Strategy-aware Y-side BPS distribution ──────────────────
      // Delegates to Meteora SDK's calculateSpotDistribution /
      // calculateBidAskDistribution / calculateNormalDistribution —
      // same BPS weights a real addLiquidityByStrategy uses on-chain.
      const binIds = bins.map((b: any) => b.binId).sort((a: any, b: any) => a - b);
      const yBpsMap = await computeVpYDistribution(activeStrategy, activeBin.binId, binIds);

      const binShares = bins.map((b: any) => {
        const depositBps = yBpsMap.get(b.binId) || 0;
        const depositY = totalYLamports.mul(new BN(depositBps)).div(new BN(10000));

        // Full liquidity-based share formula (matches SDK's simulateDepositBin):
        //   inLiquidity = depositY * 2^64            (single-side Y, depositX = 0)
        //   binLiquidity = price * binX + binY * 2^64
        //   shares = inLiquidity * binSupply / binLiquidity
        const priceBN = new BN(b.priceQ64);
        const binXBN = new BN(b.xAmount ?? "0");
        const binYBN = new BN(b.yAmount ?? "0");
        const binSupplyBN = new BN(b.supply ?? "0");

        const inLiquidity = depositY.mul(SCALE);
        const binLiquidity = priceBN.mul(binXBN).add(binYBN.mul(SCALE));
        const shares = binLiquidity.isZero()
          ? inLiquidity
          : inLiquidity.mul(binSupplyBN).div(binLiquidity);

        return {
          binId: b.binId,
          shares: shares.toString(10),
          price: b.price,
          priceQ64: b.priceQ64,
          feeXPerTokenComplete: b.feeAmountXPerTokenStored ?? "0",
          feeYPerTokenComplete: b.feeAmountYPerTokenStored ?? "0",
          xAmount: b.xAmount,
          yAmount: b.yAmount,
        };
      });

      // Estimate per-VP gas cost: deploy is frozen at deploy time, close is
      // initially captured here and re-estimated on every PnL cycle + at close.
      // Uses SDK default CU constants + sampled priority fee + base fee.
      // Rent (~0.145 SOL) is recoverable on close.
      let gasEstimate = null;
      try {
        const conn = getConnection();
        const [deployGasSol, closeGasSol] = await Promise.all([
          estimateDeployGasSol(conn),
          estimateCloseGasSol(conn),
        ]);
        // Sample once to get priority fee for logging + storage
        const pf = await samplePriorityFee(conn);
        gasEstimate = {
          deployGasSol,
          closeGasSol,
          priorityFee: pf,
        };
        log("deploy", `DRY_RUN: gas estimate = deploy=${deployGasSol.toFixed(6)} + close=${closeGasSol.toFixed(6)} = ${(deployGasSol + closeGasSol).toFixed(6)} SOL (pf=${pf} µl/CU)`);
      } catch (e: any) {
        log("deploy", `DRY_RUN: gas estimate failed — ${e.message}; using config default`);
      }

      vpId = trackVpPosition({
        pool: pool_address,
        pool_name: pool_name as any,
        pair: (pool_name ?? null) as any,
        strategy: activeStrategy,
        bins_below: activeBinsBelow,
        lower_bin: minBinId,
        upper_bin: maxBinId,
        active_bin: activeBin.binId,
        bin_step: actualBinStep,
        amount_sol: finalAmountY,
        initial_value_usd: (solPrice > 0 ? solPrice * finalAmountY : null) as any,
        sol_price_at_deploy: solPrice > 0 ? solPrice : null,
        base_mint: baseMint,
        bin_shares: binShares,
        volatility: normalizedVolatility ?? undefined,
        fee_tvl_ratio: fee_tvl_ratio != null ? Number(fee_tvl_ratio) : undefined,
        organic_score: organic_score != null ? Number(organic_score) : undefined,
        // Mirrors the live deploy paths: pull staged screener signals (organic_score,
        // fee_tvl_ratio, volume, mcap, smart_wallets_present, etc.) so dry-run
        // positions have the same signal attribution as live ones.
        signal_snapshot: config.darwin?.enabled
          ? getAndClearStagedSignals(pool_address, baseMint)
          : null,
        // New VPs: store deploy + close separately
        deploy_gas_sol: gasEstimate?.deployGasSol,
        close_gas_sol: gasEstimate?.closeGasSol,
        gas_priority_fee: gasEstimate?.priorityFee,
        // Legacy field for back-compat with any in-flight VPs from previous version
        gas_cost_sol: gasEstimate ? (gasEstimate.deployGasSol + gasEstimate.closeGasSol) : undefined,
      });
    } catch (e: any) {
      log("deploy", `DRY_RUN: bin state capture failed — ${e.message}`);
      log("deploy", `DRY_RUN: pool=${pool_address}, activeBin=${activeBin.binId}, range=${minBinId}-${maxBinId}`);
      if (e.stack) log("deploy", `DRY_RUN: stack=${e.stack.slice(0, 1000)}`);
    }

    return {
      dry_run: true,
      virtual_position_id: vpId,
      would_deploy: {
        pool_address,
        strategy: activeStrategy,
        bins_below: activeBinsBelow,
        bins_above: activeBinsAbove,
        downside_pct: downside_pct ?? null,
        upside_pct: upside_pct ?? null,
        amount_x: finalAmountX,
        amount_y: finalAmountY,
        wide_range: isWideRange,
      },
      message: vpId
        ? `DRY RUN — virtual position ${vpId} created`
        : "DRY RUN — no transaction sent (bin capture failed)",
    };
  }

  // ── REAL DEPLOY ──────────────────────────────────────────────

  await assertRangeDoesNotRequireBinArrayInitialization(pool, minBinId, maxBinId);

  const minPrice = Number(getPriceOfBinByBinId(minBinId, actualBinStep).toString());
  const maxPrice = Number(getPriceOfBinByBinId(maxBinId, actualBinStep).toString());
  const downsideCoveragePct = activePrice > 0 ? ((activePrice - minPrice) / activePrice) * 100 : null;
  const upsideCoveragePct = activePrice > 0 ? ((maxPrice - activePrice) / activePrice) * 100 : null;
  const totalWidthPct = minPrice > 0 ? ((maxPrice - minPrice) / minPrice) * 100 : null;

  // Use SDK's canonical base fee formula to avoid manual math errors.
  // SDK: base_fee_rate = baseFactor * binStep * 10 * 10^baseFeePowerFactor
  //      baseFeeRatePercentage = (baseFeeRate * 100) / 1e9
  // Note: base_fee param is currently never set by the screening pipeline
  // (condensePool returns fee_pct, not base_fee). Kept as defensive override.
  const params = pool.lbPair.parameters ?? {};
  const baseFactor = params.baseFactor ?? 0;
  const baseFeePowerFactor = params.baseFeePowerFactor ?? 0;
  let actualBaseFee = base_fee ?? null;
  if (actualBaseFee == null && baseFactor > 0) {
    try {
      const feeInfo = DLMM.calculateFeeInfo(baseFactor, actualBinStep, baseFeePowerFactor);
      actualBaseFee = parseFloat(feeInfo.baseFeeRatePercentage.toFixed(4));
    } catch (err: any) {
      log("deploy", `WARN: calculateFeeInfo failed for pool ${pool_address}: ${err.message}`);
    }
  }

  // Token X amount uses mint decimals when available, falling back to 9.
  let totalXLamports = new BN(0);
  if (finalAmountX > 0) {
    const mintInfo = await getConnection().getParsedAccountInfo(new PublicKey(pool.lbPair.tokenXMint));
    const decimals = (mintInfo.value?.data as any)?.parsed?.info?.decimals ?? 9;
    totalXLamports = new BN(Math.floor(finalAmountX * Math.pow(10, decimals)));
  }

  if (shouldUseLpAgentRelayForDeploy()) {
    try {
      const wallet = getWallet();
      log(
        "deploy",
        `Relay deploy via Agent Meridian: ${pool_address} activeBin ${activeBin.binId} bins ${minBinId}->${maxBinId} amountY=${finalAmountY}`,
      );
      const order: any = await agentMeridianJson("/execution/zap-in/order" as any, {
        method: "POST",
        headers: getAgentMeridianHeaders({ json: true }),
        body: JSON.stringify({
          agentId: getAgentIdForRequests(),
          idempotencyKey: `deploy:${pool_address}:${minBinId}:${maxBinId}:${finalAmountY}:${finalAmountX}`,
          poolId: pool_address,
          owner: wallet.publicKey.toString(),
          strategy: activeStrategy === "spot" ? "Spot" : "BidAsk",
          inputSOL: finalAmountY,
          amountY: finalAmountY,
          amountX: finalAmountX,
          percentX: finalAmountX > 0 && finalAmountY > 0 ? 0.5 : 0,
          fromBinId: minBinId,
          toBinId: maxBinId,
          slippageBps: 150, // 1.5% (matches local SDK path)
          provider: "JUPITER_ULTRA",
        }),
      });

      const addLiquidityUnsigned = order?.order?.transactions?.addLiquidity || [];
      const swapUnsigned = order?.order?.transactions?.swap || [];
      if (addLiquidityUnsigned.length + swapUnsigned.length === 0) {
        throw new Error("LPAgent order returned no transactions. Check the pool address, deploy amount, and selected range.");
      }
      assertNoInitializeBinArrayInstructions(addLiquidityUnsigned);

      const addLiquidity = signSerializedTransactions(addLiquidityUnsigned, wallet);
      const swap = signSerializedTransactions(swapUnsigned, wallet);
      const submit = await agentMeridianJson("/execution/zap-in/submit", {
        method: "POST",
        headers: getAgentMeridianHeaders({ json: true }),
        body: JSON.stringify({
          requestId: order.requestId,
          lastValidBlockHeight: order?.order?.lastValidBlockHeight,
          transactions: {
            addLiquidity,
            swap,
          },
          meta: {
            pool: pool_address,
            strategy: activeStrategy,
          },
        }),
      });

      await new Promise((resolve) => setTimeout(resolve, 5000));
      _positionsCacheAt = 0;
      const refreshed = await getMyPositions({ force: true, silent: true }).catch(() => null);
      const matching = refreshed?.positions?.find((position: any) => position.pool === pool_address && position.lower_bin === minBinId && position.upper_bin === maxBinId,
      ) || refreshed?.positions?.find((position: any) => position.pool === pool_address);

      const positionAddress = matching?.position || null;
      if (positionAddress) {
        const signalSnapshot = config.darwin?.enabled
          ? getAndClearStagedSignals(pool_address, baseMint)
          : null;
        trackPosition({
          position: positionAddress,
          pool: pool_address,
          pool_name,
          strategy: activeStrategy,
          bin_range: { min: minBinId, max: maxBinId, bins_below: activeBinsBelow, bins_above: activeBinsAbove },
          bin_step,
          volatility: normalizedVolatility ?? undefined,
          fee_tvl_ratio,
          organic_score,
          amount_sol: finalAmountY,
          amount_x: finalAmountX,
          active_bin: activeBin.binId,
          initial_value_usd: (solPrice > 0 ? solPrice * finalAmountY : null) as any,
          signal_snapshot: signalSnapshot ?? undefined,
          ...entryMarket,
        });
      }

      appendDecision({
        type: "deploy",
        actor: "SCREENER",
        pool: pool_address,
        pool_name,
        position: positionAddress,
        summary: `Relay deployed ${finalAmountY} SOL with ${activeStrategy}`,
        reason: `Chosen range ${minBinId}→${maxBinId} around active bin ${activeBin.binId}`,
        risks: [
          normalizedVolatility != null ? `volatility ${normalizedVolatility}` : null,
          fee_tvl_ratio != null ? `fee/TVL ${fee_tvl_ratio}%` : null,
        ].filter(Boolean) as string[],
        metrics: {
          amount_sol: finalAmountY,
          strategy: activeStrategy,
          active_bin: activeBin.binId,
          min_bin: minBinId,
          max_bin: maxBinId,
          downside_pct: downside_pct ?? downsideCoveragePct,
          upside_pct: upside_pct ?? upsideCoveragePct,
        },
      });

      return {
        success: true,
        relay: true,
        request_id: order.requestId,
        position: positionAddress,
        pool: pool_address,
        pool_name,
        bin_range: { min: minBinId, max: maxBinId, active: activeBin.binId },
        price_range: { min: minPrice, max: maxPrice },
        range_coverage: {
          downside_pct: downsideCoveragePct,
          upside_pct: upsideCoveragePct,
          width_pct: totalWidthPct,
          active_price: activePrice,
        },
        bin_step: actualBinStep,
        base_fee: actualBaseFee ?? undefined,
        strategy: activeStrategy,
        wide_range: isWideRange,
        amount_x: finalAmountX,
        amount_y: finalAmountY,
        txs: normalizeExecutionSignatures(submit),
      };
    } catch (error: any) {
      log("deploy_error", `Relay deploy failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  const wallet = getWallet();
  const newPosition = Keypair.generate();
  let txHashes = []; // declared at function scope so the catch block's recovery path can read it

  log("deploy", `Pool: ${pool_address}`);
  log("deploy", `Strategy: ${activeStrategy}, Bins: ${minBinId} to ${maxBinId} (${totalBins} bins${isWideRange ? " — WIDE RANGE" : ""})`);
  log("deploy", `Amount: ${finalAmountX} X, ${finalAmountY} Y`);
  log("deploy", `Position: ${newPosition.publicKey.toString()}`);

  // Warn if active bin drifted during deploy window (observability, no abort)
  try {
    const freshBin = await pool.getActiveBin();
    const binDrift = Math.abs(freshBin.binId - activeBin.binId);
    if (binDrift > 0) {
      log("deploy_warn", `Active bin drifted ${binDrift} bin(s) during deploy window for ${pool_address.slice(0, 8)} (range: ${totalBins} bins)`);
    }
  } catch (_: any) { /* best-effort */ }

  try {
    if (isWideRange) {
      // ── Wide Range Path (>69 bins) ─────────────────────────────────
      // Solana limits inner instruction realloc to 10240 bytes, so we can't create
      // a large position in a single initializePosition ix.
      // Solution: createExtendedEmptyPosition (returns Transaction | Transaction[]),
      //           then addLiquidityByStrategyChunkable (returns Transaction[]).

      // Phase 1: Create empty position (may be multiple txs)
      const createTxs = await pool.createExtendedEmptyPosition(
        minBinId,
        maxBinId,
        newPosition.publicKey,
        wallet.publicKey,
      );
      const createTxArray = Array.isArray(createTxs) ? createTxs : [createTxs];
      const createHashes = await sendTxBatch(
        getConnection(),
        createTxArray,
        (i) => i === 0 ? [wallet, newPosition] : [wallet],
        "deploy_create"
      );
      txHashes.push(...createHashes);
      createHashes.forEach((h: any, i: any) => log("deploy", `Create tx ${i + 1}/${createTxArray.length}: ${h}`));

      // Phase 2: Add liquidity (may be multiple txs)
      const addTxs = await pool.addLiquidityByStrategyChunkable({
        positionPubKey: newPosition.publicKey,
        user: wallet.publicKey,
        totalXAmount: totalXLamports,
        totalYAmount: totalYLamports,
        strategy: { minBinId, maxBinId, strategyType },
        slippage: 1.5, // 1.5%
      });
      const addTxArray = Array.isArray(addTxs) ? addTxs : [addTxs];
      const addHashes = await sendTxBatch(getConnection(), addTxArray, [wallet], "deploy_add");
      txHashes.push(...addHashes);
      addHashes.forEach((h: any, i: any) => log("deploy", `Add liquidity tx ${i + 1}/${addTxArray.length}: ${h}`));
    } else {
      // ── Standard Path (≤69 bins) ─────────────────────────────────
      const tx = await pool.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: newPosition.publicKey,
        user: wallet.publicKey,
        totalXAmount: totalXLamports,
        totalYAmount: totalYLamports,
        strategy: { maxBinId, minBinId, strategyType },
        slippage: 1.5, // 1.5%
      });
      const txHash = await sendTxWithRetry(getConnection(), tx, [wallet, newPosition], "deploy");
      txHashes.push(txHash);
    }

    log("deploy", `SUCCESS — ${txHashes.length} tx(s): ${txHashes[0]}`);

    _positionsCacheAt = 0;
    const signalSnapshot = config.darwin?.enabled
      ? getAndClearStagedSignals(pool_address, baseMint)
      : null;
    trackPosition({
      position: newPosition.publicKey.toString(),
      pool: pool_address,
      pool_name,
      strategy: activeStrategy,
      bin_range: { min: minBinId, max: maxBinId, bins_below: activeBinsBelow, bins_above: activeBinsAbove },
      bin_step,
      volatility: normalizedVolatility ?? undefined,
      fee_tvl_ratio,
      organic_score,
      amount_sol: finalAmountY,
      amount_x: finalAmountX,
      active_bin: activeBin.binId,
      initial_value_usd: (solPrice > 0 ? solPrice * finalAmountY : null) as any,
      signal_snapshot: signalSnapshot ?? undefined,
      ...entryMarket,
    });

    appendDecision({
      type: "deploy",
      actor: "SCREENER",
      pool: pool_address,
      pool_name,
      position: newPosition.publicKey.toString(),
      summary: `Deployed ${finalAmountY} SOL with ${activeStrategy}`,
      reason: `Chosen range ${minBinId}→${maxBinId} around active bin ${activeBin.binId}`,
      risks: [
        normalizedVolatility != null ? `volatility ${normalizedVolatility}` : null,
        fee_tvl_ratio != null ? `fee/TVL ${fee_tvl_ratio}%` : null,
      ].filter(Boolean) as string[],
      metrics: {
        amount_sol: finalAmountY,
        strategy: activeStrategy,
        active_bin: activeBin.binId,
        min_bin: minBinId,
        max_bin: maxBinId,
        downside_pct: downside_pct ?? null,
        upside_pct: upside_pct ?? null,
      },
    });

    return {
      success: true,
      position: newPosition.publicKey.toString(),
      pool: pool_address,
      pool_name,
      bin_range: { min: minBinId, max: maxBinId, active: activeBin.binId },
      price_range: { min: minPrice, max: maxPrice },
      range_coverage: {
        downside_pct: downsideCoveragePct,
        upside_pct: upsideCoveragePct,
        width_pct: totalWidthPct,
        active_price: activePrice,
      },
      bin_step: actualBinStep,
      base_fee: actualBaseFee ?? undefined,
      strategy: activeStrategy,
      wide_range: isWideRange,
      amount_x: finalAmountX,
      amount_y: finalAmountY,
      txs: txHashes,
    };
  } catch (error: any) {
    // Normalize: SDK/network can throw non-Error values (strings, plain objects,
    // null). Coerce safely so error.message access never masks the root cause.
    const errMsg = error?.message ?? String(error);

    log("deploy_error", errMsg);

    // Recovery: the deploy tx may have landed on-chain despite the error
    // (RPC timeout, blockhash race, or local network blip). Poll the position
    // account with backoff. If a real DLMM position owned by the wallet exists,
    // the deploy actually succeeded — track it and return success.
    //
    // Only applies to the direct SDK path; the Agent Meridian relay path
    // (above, line 1138) owns its own position via LPAgent and returns early.
    let recovered = null;
    try {
      if (typeof newPosition !== "undefined" && newPosition?.publicKey && pool) {
        const recoveryDelays = [3000, 6000, 12000]; // total max 21s
        for (const delayMs of recoveryDelays) {
          await new Promise((r) => setTimeout(r, delayMs));
          try {
            const positionData = await pool.getPosition(newPosition.publicKey);
            if (positionData) {
              recovered = positionData;
              log("deploy_recovery", `Found on-chain position after ${delayMs}ms wait despite tx error: ${errMsg.slice(0, 120)}`);
              break;
            }
          } catch (_: any) {
            // Position account doesn't exist yet; keep polling
          }
        }
      }
    } catch (recoveryErr: any) {
      const recoveryErrMsg = recoveryErr?.message ?? String(recoveryErr);
      log("deploy_recovery_err", `Recovery poll failed: ${recoveryErrMsg}`);
    }

    if (recovered) {
      const recoveredPositionKey = newPosition.publicKey.toString();
      _positionsCacheAt = 0;
      const signalSnapshot = config.darwin?.enabled
        ? getAndClearStagedSignals(pool_address, baseMint)
        : null;
      trackPosition({
        position: recoveredPositionKey,
        pool: pool_address,
        pool_name,
        strategy: activeStrategy,
        bin_range: { min: minBinId, max: maxBinId, bins_below: activeBinsBelow, bins_above: activeBinsAbove },
        bin_step,
        volatility: normalizedVolatility ?? undefined,
        fee_tvl_ratio,
        organic_score,
        amount_sol: finalAmountY,
        amount_x: finalAmountX,
        active_bin: activeBin.binId,
        initial_value_usd: (solPrice > 0 ? solPrice * finalAmountY : null) as any,
        signal_snapshot: signalSnapshot ?? undefined,
        ...entryMarket,
      });

      appendDecision({
        type: "deploy",
        actor: "SCREENER",
        pool: pool_address,
        pool_name,
        position: recoveredPositionKey,
        summary: `Deployed ${finalAmountY} SOL with ${activeStrategy} (recovered)`,
        reason: `Tx errored (${errMsg.slice(0, 80)}) but on-chain position found via recovery poll`,
        risks: [
          normalizedVolatility != null ? `volatility ${normalizedVolatility}` : null,
          fee_tvl_ratio != null ? `fee/TVL ${fee_tvl_ratio}%` : null,
        ].filter(Boolean) as string[],
        metrics: {
          amount_sol: finalAmountY,
          strategy: activeStrategy,
          active_bin: activeBin.binId,
          min_bin: minBinId,
          max_bin: maxBinId,
          downside_pct: downside_pct ?? null,
          upside_pct: upside_pct ?? null,
        },
      });

      return {
        success: true,
        recovered: true,
        recovery_note: "Created on-chain despite tx error — recovered",
        position: recoveredPositionKey,
        pool: pool_address,
        pool_name,
        bin_range: { min: minBinId, max: maxBinId, active: activeBin.binId },
        price_range: { min: minPrice, max: maxPrice },
        range_coverage: {
          downside_pct: downsideCoveragePct,
          upside_pct: upsideCoveragePct,
          width_pct: totalWidthPct,
          active_price: activePrice,
        },
        bin_step: actualBinStep,
        base_fee: actualBaseFee ?? undefined,
        strategy: activeStrategy,
        wide_range: isWideRange,
        amount_x: finalAmountX,
        amount_y: finalAmountY,
        txs: txHashes, // may be empty if errored before the send landed
      };
    }

    return { success: false, error: errMsg };
  }
}

const POSITIONS_CACHE_TTL = 5 * 60_000; // 5 minutes (live)
const DRY_RUN_CACHE_TTL = 10_000; // 10s (DRY_RUN paper trading)

/**
 * Mode-aware positions cache TTL.
 * - Live: 5 min — tolerates Meteora rate limits, positions rarely change second-to-second.
 * - DRY_RUN: 10s — paper trading needs fresh PnL on every management cycle and
 *   user-driven /positions, but 10s still throttles rapid-fire calls (e.g. /positions
 *   + management cycle firing same second) to avoid hammering Meteora.
 */
function _positionsCacheTtl() {
  return process.env.DRY_RUN === "true" ? DRY_RUN_CACHE_TTL : POSITIONS_CACHE_TTL;
}
// Test export — see test/test-dry-run-cache.js
export const _positionsCacheTtlForTesting = _positionsCacheTtl;

/**
 * Invalidate the positions cache. Call this after state changes that
 * the cache wouldn't otherwise observe (e.g. VP close in DRY_RUN, where
 * closeVirtualPosition doesn't go through getMyPositions).
 */
export function invalidatePositionsCache() {
  _positionsCacheAt = 0;
}

let _positionsCache: PositionsResult | null = null;
let _positionsCacheAt = 0;
let _positionsInflight: Promise<PositionsResult> | null = null; // deduplicates concurrent calls

/**
 * Merge virtual positions into the on-chain positions array.
 * Used by getMyPositions in DRY_RUN mode to give the LLM a single
 * source of truth (and the deploy pre-check the same count).
 * Implementation lives in tools/merge-virtual-positions.js so tests
 * can import it without pulling in envcrypt/RPC/wallet modules.
 *
 * NOTE: must be `import` (not `export { X } from "..."`) so the function
 * is in this module's local scope. Re-export-only does NOT create a local
 * binding — the call site at line 1680 would throw ReferenceError.
 */

// fetchLpAgentOpenPositions lives in providers/lpagent/open-positions.ts
// and is imported below alongside the other helpers used by getMyPositions.

// ─── Get My Positions ──────────────────────────────────────────
export async function getMyPositions({ force = false, silent = false, wallet_address = null }: { force?: boolean; silent?: boolean; wallet_address?: string | null } = {}): Promise<import("../../types/index.js").PositionsResult> {
  let walletOverride = null;
  try {
    walletOverride = wallet_address ? new PublicKey(wallet_address).toString() : null;
  } catch (_: any) {
    return { wallet: wallet_address || null, total_positions: 0, positions: [], error: "Invalid wallet address" };
  }

  const useLocalWallet = !walletOverride;
  if (useLocalWallet && !force && _positionsCache && Date.now() - _positionsCacheAt < _positionsCacheTtl()) {
    return _positionsCache;
  }
  if (useLocalWallet && _positionsInflight) return _positionsInflight;

  let walletAddress;
  try {
    walletAddress = walletOverride || getWallet().publicKey.toString();
  } catch (_: any) {
    return { wallet: null, total_positions: 0, positions: [], error: "Wallet not configured" };
  }

  const loadPositions = async () => { try {
    if (config.pnl.source === "rpc") {
      try {
        if (!silent) log("positions", `Computing PnL from RPC (${config.pnl.rpcUrl})...`);
        const rpcResult = await computePositions(walletAddress);
        if (useLocalWallet) {
          syncLiveOpenPositions(rpcResult.positions.map((p: any) => p.position));
          _positionsCache = rpcResult;
          _positionsCacheAt = Date.now();
        }
        return rpcResult;
      } catch (error: any) {
        log("positions_warn", `RPC PnL path failed; falling back to Meteora portfolio API: ${error.message}`);
      }
    }

    let relayLpAgentByPosition = null;
    let relayRequestId = null;
    if (shouldUseLpAgentRelay()) {
      try {
        if (!silent) log("positions", "Fetching raw LPAgent open positions via Agent Meridian relay...");
        const result = await fetchRawOpenPositionsFromMeridian({
          walletAddress,
          agentId: getAgentIdForRequests(),
        });
        relayLpAgentByPosition = result.byPosition || {};
        relayRequestId = result.requestId || result.request_id || null;
      } catch (error: any) {
        log("positions_warn", `Agent Meridian raw relay failed; falling back to direct LPAgent fetch: ${error.message}`);
      }
    }

    // Portfolio API discovers open pools/positions for this wallet.
    // Detailed range data stays on Meteora PnL API; value/PnL can be overridden by LPAgent below.
    if (!silent) log("positions", "Fetching portfolio via Meteora portfolio API...");
    const portfolioUrl = `https://dlmm.datapi.meteora.ag/portfolio/open?user=${walletAddress}`;
    const res = await fetch(portfolioUrl);
    if (!res.ok) throw new Error(`Portfolio API ${res.status}: ${await res.text().catch(() => "")}`);
    const portfolio = await res.json();

    const pools = portfolio.pools || [];
    log("positions", `Found ${pools.length} pool(s) with open positions`);

    // Fetch bin data (lowerBinId, upperBinId, poolActiveBinId) for all pools in parallel
    // Needed for rules 3 & 4 (active_bin vs upper_bin comparison)
    const binDataByPool: Record<string, any> = {};
    const pnlMaps = await Promise.all(pools.map((pool: any) => fetchDlmmPnlForPool(pool.poolAddress, walletAddress)));
    pools.forEach((pool: any, i: any) => { binDataByPool[pool.poolAddress] = pnlMaps[i]; });
    const lpAgentByPosition = relayLpAgentByPosition || await fetchLpAgentOpenPositions(walletAddress);

    const positions = [];
    for (const pool of pools) {
      for (const positionAddress of (pool.listPositions || [])) {
        const tracked = getTrackedPosition(positionAddress);
        const isOOR = pool.outOfRange || pool.positionsOutOfRange?.includes(positionAddress);

        if (isOOR) markLiveOutOfRange(positionAddress);
        else markLiveInRange(positionAddress);

        // Bin data: from supplemental PnL call (OOR) or tracked state (in-range)
        const binData = binDataByPool[pool.poolAddress]?.[positionAddress];
        if (!binData) {
          log("positions_warn", `PnL API missing data for ${positionAddress.slice(0, 8)} in pool ${pool.poolAddress.slice(0, 8)} — using portfolio only for open-position discovery`);
        }
        const lowerBin  = binData?.lowerBinId      ?? tracked?.bin_range?.min ?? null;
        const upperBin  = binData?.upperBinId      ?? tracked?.bin_range?.max ?? null;
        const activeBin = binData?.poolActiveBinId ?? tracked?.bin_range?.active ?? null;
        const lpData = lpAgentByPosition[positionAddress] || null;

        const ageFromState = tracked?.deployed_at
          ? Math.floor((Date.now() - new Date(tracked.deployed_at).getTime()) / 60000)
          : null;
        const reportedPnlPct = lpData
          ? parseFloat(config.management.solMode ? (lpData.pnl?.percentNative || 0) : (lpData.pnl?.percent || 0))
          : binData
            ? parseFloat(config.management.solMode ? (binData.pnlSolPctChange || 0) : (binData.pnlPctChange || 0))
            : null;
        const derivedPnlPct = lpData
          ? deriveLpAgentPnlPct(lpData, config.management.solMode)
          : binData
            ? deriveOpenPnlPct(binData, config.management.solMode)
            : null;
        const solMode = config.management.solMode;
        const depositsSol = binData ? safeNum(binData.allTimeDeposits?.total?.sol) : 0;
        const depositsUsd = binData ? safeNum(binData.allTimeDeposits?.total?.usd) : 0;
        const depositsMissing = (solMode ? depositsSol : depositsUsd) <= 0;
        const xHuman = binData ? parseFloat(binData.unrealizedPnl?.balancesTokenX || 0) : 0;
        const feeXHuman = binData ? parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenX?.amount || 0) : 0;
        const holdsTokenX = xHuman > 0 || feeXHuman > 0;
        const priceMissing = binData ? (holdsTokenX && !safeNum(binData.unrealizedPnl?.balances)) : false;
        const pnlPctSuspicious = priceMissing || depositsMissing;
        if (pnlPctSuspicious) {
          log("positions_warn", `Suspicious pnl_pct for ${positionAddress.slice(0, 8)}: priceMissing=${priceMissing} depositsMissing=${depositsMissing}`);
        }

        positions.push({
          position:           positionAddress,
          pool:               pool.poolAddress,
          pair:               tracked?.pool_name || `${pool.tokenX}/${pool.tokenY}`,
          base_mint:          pool.tokenXMint,
          lower_bin:          lowerBin,
          upper_bin:          upperBin,
          active_bin:         activeBin,
          in_range:           binData ? !binData.isOutOfRange : !isOOR,
          unclaimed_fees_usd: lpData
            ? Math.round((
                config.management.solMode
                  ? safeNum(lpData.unCollectedFeeNative)
                  : safeNum(lpData.unCollectedFee)
              ) * 10000) / 10000
            : binData
            ? Math.round((
                config.management.solMode
                  ? parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenX?.amountSol || 0) + parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenY?.amountSol || 0)
                  : parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0) + parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0)
              ) * 10000) / 10000
            : null,
          total_value_usd:    lpData
            ? Math.round((
                config.management.solMode
                  ? safeNum(lpData.valueNative)
                  : safeNum(lpData.value)
              ) * 10000) / 10000
            : binData
            ? Math.round((
                config.management.solMode
                  ? parseFloat(binData.unrealizedPnl?.balancesSol || 0)
                  : parseFloat(binData.unrealizedPnl?.balances || 0)
              ) * 10000) / 10000
            : null,
          // Always-USD fields for internal accounting and lesson recording.
          total_value_true_usd: lpData
            ? Math.round(safeNum(lpData.value) * 10000) / 10000
            : binData
            ? Math.round(parseFloat(binData.unrealizedPnl?.balances || 0) * 10000) / 10000
            : null,
          collected_fees_usd: lpData
            ? Math.round((
                config.management.solMode
                  ? safeNum(lpData.collectedFeeNative)
                  : safeNum(lpData.collectedFee)
              ) * 10000) / 10000
            : binData
            ? Math.round(parseFloat(config.management.solMode ? (binData.allTimeFees?.total?.sol || 0) : (binData.allTimeFees?.total?.usd || 0)) * 10000) / 10000
            : null,
          collected_fees_true_usd: lpData
            ? Math.round(safeNum(lpData.collectedFee) * 10000) / 10000
            : binData
            ? Math.round(parseFloat(binData.allTimeFees?.total?.usd || 0) * 10000) / 10000
            : null,
          pnl_usd:            lpData
            ? Math.round((
                config.management.solMode
                  ? safeNum(lpData.pnl?.valueNative)
                  : safeNum(lpData.pnl?.value)
              ) * 10000) / 10000
            : binData
            ? Math.round(parseFloat(config.management.solMode ? (binData.pnlSol || 0) : (binData.pnlUsd || 0)) * 10000) / 10000
            : null,
          pnl_true_usd:       lpData
            ? Math.round(safeNum(lpData.pnl?.value) * 10000) / 10000
            : binData
            ? Math.round(parseFloat(binData.pnlUsd || 0) * 10000) / 10000
            : null,
          pnl_pct:            (lpData || binData)
            ? Math.round(reportedPnlPct! * 100) / 100
            : null,
          pnl_pct_derived:    derivedPnlPct != null ? Math.round(derivedPnlPct * 100) / 100 : null,
          pnl_pct_diff:       null,
          pnl_pct_suspicious: !!pnlPctSuspicious,
          unclaimed_fees_true_usd: lpData
            ? Math.round(safeNum(lpData.unCollectedFee) * 10000) / 10000
            : binData
            ? Math.round((parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0) + parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0)) * 10000) / 10000
            : null,
          fee_per_tvl_24h:    binData
            ? Math.round(parseFloat(binData.feePerTvl24h || 0) * 100) / 100
            : null,
          age_minutes:        binData?.createdAt ? Math.floor((Date.now() - binData.createdAt * 1000) / 60000) : ageFromState,
          minutes_out_of_range: minutesLiveOutOfRange(positionAddress),
          instruction:        tracked?.instruction ?? null,
        });
      }
    }

    let resultPositions = positions;
    if (process.env.DRY_RUN === "true" && useLocalWallet) {
      try {
        const { listVpPositions, computePositionPnl } = await import("../../core/index.js");
        const vps = listVpPositions("open");
        // ALWAYS fetch a real SOL price for computePositionPnl (it needs solPrice
        // to compute USD fields correctly, even when display is in SOL mode).
        // Only the display convention in mergeVpPositions switches on solMode.
        const realSolPrice = await fetchSolPrice();
        if (!realSolPrice) {
          log("positions_warn", "fetchSolPrice failed; VP PnL fields will be null");
        }
        const displaySolPrice = config.management.solMode ? (realSolPrice || 0) : 0;
        if (config.management.solMode && !realSolPrice) {
          log("positions_warn", "solMode active but fetchSolPrice failed; VP values will display in USD");
        }
        // Build fresh PnL map: for each VP, fetch fresh bins + activeBinId,
        // compute PnL via computePositionPnl. On RPC failure, leave the
        // entry absent so mergeVpPositions returns nulls for that VP.
        // Step 7 (meridian-wie): no cached-fields fallback — brief nulls
        // during a 30s RPC outage are far less dangerous than stale values.
        const freshPnlMap = new Map<string, any>();
        if (realSolPrice) {
          // Parallelize bin fetches across VPs to reduce getMyPositions latency.
          // Different pools don't share the 30s cache, so this matters for cold cache.
          const results = await Promise.allSettled(vps.map(async (vp) => {
            const { activeBin, binStep, sParameter, vParameter, bins } = await getBinsInRange({
              pool_address: vp.pool,
              lower_bin: vp.lower_bin ?? 0,
              upper_bin: vp.upper_bin ?? 0,
            });
            const poolParams: any = binStep != null && sParameter != null && vParameter != null
              ? { binStep, sParameter, vParameter }
              : null;
            return { vp, activeBin, pnl: computePositionPnl(vp as any, bins, realSolPrice, { activeBinId: activeBin, poolParams }) };
          }));
          for (const r of results) {
            if (r.status === "fulfilled") {
              freshPnlMap.set(r.value.vp.id, { pnl: r.value.pnl, activeBinId: r.value.activeBin });
            } else {
              // Find the VP for logging — r.reason is the error
              log("positions_warn", `Fresh PnL failed for one VP: ${r.reason?.message || r.reason} — using nulls`);
            }
          }
        }
        resultPositions = (mergeVpPositions(positions as any, vps as any, displaySolPrice, Date.now(), freshPnlMap as any) as any).positions;
      } catch (e: any) {
        log("positions_warn", `VP merge failed: ${e.message}`);
      }
    }
    const result = {
      wallet: walletAddress,
      total_positions: resultPositions.length,
      positions: resultPositions,
      request_id: relayRequestId,
    };
    if (useLocalWallet) {
      syncLiveOpenPositions(positions.map(p => p.position));
      _positionsCache = result;
      _positionsCacheAt = Date.now();
    }
    return result;
  } catch (error: any) {
    log("positions_error", `Portfolio fetch failed: ${error.stack || error.message}`);
    return { wallet: walletAddress, total_positions: 0, positions: [], error: error.message };
  } finally {
    if (useLocalWallet) _positionsInflight = null;
  }
  };

  if (useLocalWallet) {
    _positionsInflight = loadPositions();
    return _positionsInflight;
  }

  return loadPositions();
}

// ─── Close Position ────────────────────────────────────────────
export async function closePosition({ position_address, reason }: { position_address: string; reason?: string }): Promise<any> {
  position_address = normalizeMint(position_address);
  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_close: position_address, message: "DRY RUN — no transaction sent" };
  }

  const tracked = getTrackedPosition(position_address);

  try {
    log("close", `Closing position: ${position_address}`);
    const wallet = getWallet();
    const poolAddress = await lookupPoolForPosition(position_address, wallet.publicKey.toString());
    const poolMeta = await getPoolMetadata(poolAddress);

    let exitMarket: Record<string, number | null> = {};
    try {
      const exitDetail = await fetch(`https://pool-discovery-api.datapi.meteora.ag/pools?page_size=1&filter_by=${encodeURIComponent(`pool_address=${poolAddress}`)}&timeframe=${encodeURIComponent(config.screening?.timeframe || "5m")}`).then(r => r.json()).catch(() => null) as any;
      const ep = exitDetail?.data?.[0];
      if (ep) {
        exitMarket = {
          exit_mcap: parseFloat(ep?.token_x?.market_cap) || null,
          exit_tvl: parseFloat(ep?.tvl ?? ep?.active_tvl) || null,
          exit_volume: parseFloat(ep?.volume) || null,
        };
      }
    } catch { /* non-blocking */ }

    if (shouldUseLpAgentRelay()) {
      let relaySubmitted = false;
      try {
      const pool = await getPool(poolAddress);
      const relayAllowedDebitMints = [
        pool.lbPair.tokenXMint.toString(),
        pool.lbPair.tokenYMint.toString(),
        config.tokens.SOL,
      ];
      const livePositions = await getMyPositions({ force: true, silent: true });
      const livePosition = livePositions?.positions?.find((position: any) => position.position === position_address);
      const closeFromBinId = livePosition?.lower_bin ?? tracked?.bin_range?.min ?? -887272;
      const closeToBinId = livePosition?.upper_bin ?? tracked?.bin_range?.max ?? 887272;
      const closeOutput = "allToken1";

      const order: any = await agentMeridianJson("/execution/zap-out/order" as any, {
        method: "POST",
        headers: getAgentMeridianHeaders({ json: true }),
        body: JSON.stringify({
          agentId: getAgentIdForRequests(),
          idempotencyKey: `close:${position_address}:10000`,
          positionId: position_address,
          owner: wallet.publicKey.toString(),
          bps: 10000,
          slippageBps: 5000,
          output: closeOutput,
          provider: "OKX",
          type: "meteora",
          fromBinId: closeFromBinId,
          toBinId: closeToBinId,
        }),
      });

      const closeUnsigned = order?.order?.transactions?.close || [];
      const swapUnsigned = order?.order?.transactions?.swap || [];
      if (closeUnsigned.length + swapUnsigned.length === 0) {
        throw new Error("LPAgent close order returned no transactions. Check the position, selected output, and relay order response.");
      }

      const closeSigned = await signAndSimulateRelayTransactions(closeUnsigned, wallet, {
        label: "zap-out close",
        allowedDebitMints: relayAllowedDebitMints,
        maxSolLoss: 0.05,
        requiredStaticAccounts: [wallet.publicKey.toString(), position_address],
      });
      const swapSigned = await signAndSimulateRelayTransactions(swapUnsigned, wallet, {
        label: "zap-out swap",
        allowedDebitMints: relayAllowedDebitMints,
        maxSolLoss: 0.05,
        requiredStaticAccounts: [wallet.publicKey.toString()],
      });

      relaySubmitted = true;
      const submit = await agentMeridianJson("/execution/zap-out/submit", {
        method: "POST",
        headers: getAgentMeridianHeaders({ json: true }),
        body: JSON.stringify({
          requestId: order.requestId,
          lastValidBlockHeight: order?.order?.lastValidBlockHeight,
          transactions: {
            close: closeSigned,
            swap: swapSigned,
          },
        }),
      });

      const claimTxHashes: string[] = [];
      const closeTxHashes = normalizeExecutionSignatures(submit);
      const txHashes = [...claimTxHashes, ...closeTxHashes];

      await new Promise((resolve) => setTimeout(resolve, 5000));
      _positionsCacheAt = 0;

      let closedConfirmed = false;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const refreshed = await getMyPositions({ force: true, silent: true });
          const stillOpen = refreshed?.positions?.some((p: any) => p.position === position_address);
          if (!stillOpen) {
            closedConfirmed = true;
            break;
          }
          log("close_warn", `Relay close still appears open after submit (attempt ${attempt + 1}/4)`);
        } catch (e: any) {
          log("close_warn", `Relay close verification failed (attempt ${attempt + 1}/4): ${e.message}`);
        }
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 3000));
      }

      if (!closedConfirmed) {
        return {
          success: false,
          error: "Close submit succeeded but position still appears open after verification window",
          position: position_address,
          pool: poolAddress,
          close_txs: closeTxHashes,
          txs: txHashes,
        };
      }

      recordLiveClose(position_address, reason || "agent decision");

      if (tracked) {
        const deployedAt = new Date(tracked.deployed_at).getTime();
        const minutesHeld = Math.floor((Date.now() - deployedAt) / 60000);
        let minutesOOR = 0;
        if (tracked.out_of_range_since) {
          minutesOOR = Math.floor((Date.now() - new Date(tracked.out_of_range_since).getTime()) / 60000);
        }

        let pnlUsd = 0;
        let pnlTrueUsd = 0;
        let pnlPct = 0;
        let finalValueUsd = 0;
        let initialUsd = 0;
        let feesUsd = tracked.total_fees_claimed_usd || 0;
        try {
          const closedUrl = `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?user=${wallet.publicKey.toString()}&status=closed&pageSize=50&page=1`;
          for (let attempt = 0; attempt < 6; attempt++) {
            const res = await fetch(closedUrl);
            if (res.ok) {
              const data = await res.json();
              const posEntry = (data.positions || []).find((entry: any) => entry.positionAddress === position_address);
              if (posEntry) {
                pnlTrueUsd = safeNum(posEntry.pnlUsd);
                pnlUsd = config.management.solMode ? getClosedPnlValue(posEntry, true) : pnlTrueUsd;
                pnlPct = getClosedPnlPct(posEntry, config.management.solMode);
                finalValueUsd = parseFloat(posEntry.allTimeWithdrawals?.total?.usd || 0);
                initialUsd = parseFloat(posEntry.allTimeDeposits?.total?.usd || 0);
                feesUsd = parseFloat(posEntry.allTimeFees?.total?.usd || 0) || feesUsd;
                break;
              }
            }
            if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 5000));
          }
        } catch (e: any) {
          log("close_warn", `Relay closed PnL fetch failed: ${e.message}`);
        }

        const closeBaseMint = livePosition?.base_mint || pool.lbPair.tokenXMint.toString();
        const signalSnapshot = resolvePerformanceSignalSnapshot({
          poolAddress,
          baseMint: closeBaseMint,
          tracked,
        });

        await recordPerformance({
          position: position_address,
          pool: poolAddress,
          pool_name: tracked.pool_name || poolMeta.name || poolAddress.slice(0, 8),
          base_mint: closeBaseMint,
          strategy: tracked.strategy,
          bin_range: tracked.bin_range,
          bin_step: (tracked.bin_step || null) as any,
          volatility: (tracked.volatility ?? null) as any,
          fee_tvl_ratio: (tracked.fee_tvl_ratio || null) as any,
          organic_score: (tracked.organic_score || null) as any,
          amount_sol: tracked.amount_sol,
          deployed_at: tracked.deployed_at,
          fees_earned_usd: feesUsd,
          fees_earned_sol: undefined as any,
          final_value_usd: finalValueUsd,
          initial_value_usd: initialUsd,
          minutes_in_range: minutesHeld - minutesOOR,
          minutes_held: minutesHeld,
          close_reason: reason || "agent decision",
          signal_snapshot: signalSnapshot ?? undefined,
          entry_mcap: (tracked as any).entry_mcap ?? null,
          entry_tvl: (tracked as any).entry_tvl ?? null,
          entry_volume: (tracked as any).entry_volume ?? null,
          entry_holders: (tracked as any).entry_holders ?? null,
          ...exitMarket,
        });

        appendDecision({
          type: "close",
          actor: "MANAGER",
          pool: poolAddress,
          pool_name: tracked.pool_name || poolMeta.name || poolAddress.slice(0, 8),
          position: position_address,
          summary: `Relay closed at ${pnlPct.toFixed(2)}%`,
          reason: reason || "agent decision",
          risks: [
            minutesOOR > 0 ? `out of range ${minutesOOR}m` : null,
            tracked.volatility != null ? `volatility ${tracked.volatility}` : null,
          ].filter(Boolean) as string[],
          metrics: {
            pnl_usd: pnlUsd,
            pnl_pct: pnlPct,
            fees_usd: feesUsd,
            minutes_held: minutesHeld,
          },
        });

        return {
          success: true,
          relay: true,
          request_id: order.requestId,
          position: position_address,
          pool: poolAddress,
          pool_name: tracked.pool_name || poolMeta.name || null,
          claim_txs: claimTxHashes,
          close_txs: closeTxHashes,
          txs: txHashes,
          pnl_usd: pnlUsd,
          pnl_pct: pnlPct,
          base_mint: closeBaseMint,
        };
      }

      appendDecision({
        type: "close",
        actor: "MANAGER",
        pool: poolAddress,
        pool_name: poolMeta.name || poolAddress.slice(0, 8),
        position: position_address,
        summary: "Relay closed position",
        reason: reason || "agent decision",
        metrics: {},
      });

      return {
        success: true,
        relay: true,
        request_id: order.requestId,
        position: position_address,
        pool: poolAddress,
        pool_name: poolMeta.name || null,
        claim_txs: claimTxHashes,
        close_txs: closeTxHashes,
        txs: txHashes,
        base_mint: livePosition?.base_mint || null,
      };
      } catch (relayError: any) {
        if (relaySubmitted) throw relayError;
        log("close_warn", `Relay zap-out failed before submit; falling back to local close + Jupiter autoswap: ${relayError.message}`);
      }
    }

    // Clear cached pool so SDK loads fresh position fee state
    invalidatePoolCache(poolAddress.toString());
    const pool = await getPool(poolAddress);

    const positionPubKey = new PublicKey(position_address);
    const claimTxHashes: string[] = [];
    const closeTxHashes = [];

    // ─── Step 1: Claim Fees (to clear account state) ───────────
    const recentlyClaimed = tracked?.last_claim_at && (Date.now() - new Date(tracked.last_claim_at).getTime()) < 60_000;
    try {
      if (recentlyClaimed) {
        log("close", `Step 1: Skipping claim — fees already claimed ${Math.round((Date.now() - new Date(tracked.last_claim_at as string).getTime()) / 1000)}s ago`);
      } else {
        log("close", `Step 1: Claiming fees for ${position_address}`);
        const positionData = await pool.getPosition(positionPubKey);
        const claimTxs = await (pool as any).claimSwapFee({
          owner: wallet.publicKey,
          position: positionData,
        });
        if (claimTxs && claimTxs.length > 0) {
          const claimHashes = await sendTxBatch(getConnection(), claimTxs, [wallet], "close_claim");
          claimTxHashes.push(...claimHashes);
          log("close", `Step 1 OK (claim only): ${claimTxHashes.join(", ")}`);
        }
      }
    } catch (e: any) {
      log("close_warn", `Step 1 (Claim) failed or nothing to claim: ${e.message}`);
    }

    // ─── Step 2: Remove Liquidity & Close ──────────────────────
    let hasLiquidity = false;
    let closeFromBinId = -887272;
    let closeToBinId = 887272;
    try {
      const positionDataForClose = await pool.getPosition(positionPubKey);
      const processed = positionDataForClose?.positionData;
      if (processed) {
        closeFromBinId = processed.lowerBinId ?? closeFromBinId;
        closeToBinId = processed.upperBinId ?? closeToBinId;
        const bins = Array.isArray(processed.positionBinData) ? processed.positionBinData : [];
        hasLiquidity = bins.some((bin: any) => new BN(bin.positionLiquidity || "0").gt(new BN(0)));
      }
    } catch (e: any) {
      log("close_warn", `Could not check liquidity state: ${e.message}`);
    }

    if (hasLiquidity) {
      log("close", `Step 2: Removing liquidity and closing account`);
      const closeTx = await pool.removeLiquidity({
        user: wallet.publicKey,
        position: positionPubKey,
        fromBinId: closeFromBinId,
        toBinId: closeToBinId,
        bps: new BN(10000),
        shouldClaimAndClose: true,
      });

      const closeTxArray = Array.isArray(closeTx) ? closeTx : [closeTx];
      const closeHashes = await sendTxBatch(getConnection(), closeTxArray, [wallet], "close_remove");
      closeTxHashes.push(...closeHashes);
    } else {
      log("close", `Step 2: No position liquidity detected, closing account`);
      const closeTx = await pool.closePosition({
        owner: wallet.publicKey,
        position: { publicKey: positionPubKey },
      });
      const txHash = await sendTxWithRetry(getConnection(), closeTx, [wallet], "close_empty");
      closeTxHashes.push(txHash);
    }
    const txHashes = [...claimTxHashes, ...closeTxHashes];
    log("close", `Step 2 OK (close only): ${closeTxHashes.join(", ") || "none"}`);
    log("close", `SUCCESS txs: ${txHashes.join(", ")}`);
    // Wait for RPC to reflect withdrawn balances before returning — prevents
    // agent from seeing zero balance when attempting post-close swap
    await new Promise(r => setTimeout(r, 5000));
    _positionsCacheAt = 0;

    let closedConfirmed = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const refreshed = await getMyPositions({ force: true, silent: true });
        const stillOpen = refreshed?.positions?.some((p: any) => p.position === position_address);
        if (!stillOpen) {
          closedConfirmed = true;
          break;
        }
        log("close_warn", `Position ${position_address} still appears open after close txs (attempt ${attempt + 1}/4)`);
      } catch (e: any) {
        log("close_warn", `Close verification failed (attempt ${attempt + 1}/4): ${e.message}`);
      }
      if (attempt < 3) await new Promise((r) => setTimeout(r, 3000));
    }

    if (!closedConfirmed) {
      return {
        success: false,
        error: "Close transactions sent but position still appears open after verification window",
        position: position_address,
        pool: poolAddress,
        claim_txs: claimTxHashes,
        close_txs: closeTxHashes,
        txs: txHashes,
      };
    }

    recordLiveClose(position_address, reason || "agent decision");

    // Record performance for learning
    if (tracked) {
      const deployedAt = new Date(tracked.deployed_at).getTime();
      const minutesHeld = Math.floor((Date.now() - deployedAt) / 60000);

      let minutesOOR = 0;
      if (tracked.out_of_range_since) {
        minutesOOR = Math.floor((Date.now() - new Date(tracked.out_of_range_since).getTime()) / 60000);
      }

      const shouldRejectClosedPnl = (pct: any, closeReasonText: any): boolean => {
        if (!Number.isFinite(pct)) return false;
        const reasonText = String(closeReasonText || "").toLowerCase();
        const stopLossTriggered = reasonText.includes("stop loss");
        // Meteora sometimes briefly reports absurd closed pnl while the record is settling.
        // Trust legitimate stop-loss disasters, but reject obviously unsettled outliers otherwise.
        return !stopLossTriggered && pct <= -90;
      };

      // Fetch closed PnL from API — authoritative source after withdrawal settles
      let pnlUsd = 0;
      let pnlTrueUsd = 0;
      let pnlPct = 0;
      let finalValueUsd = 0;
      let initialUsd = 0;
      let feesUsd = tracked.total_fees_claimed_usd || 0;
      try {
        const closedUrl = `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?user=${wallet.publicKey.toString()}&status=closed&pageSize=50&page=1`;
        for (let attempt = 0; attempt < 6; attempt++) {
          const res = await fetch(closedUrl);
          if (res.ok) {
            const data = await res.json();
            const posEntry = (data.positions || []).find((p: any) => p.positionAddress === position_address);
            if (posEntry) {
              const nextPnlUsd = safeNum(posEntry.pnlUsd);
              const nextPnlValue = config.management.solMode ? getClosedPnlValue(posEntry, true) : nextPnlUsd;
              const nextPnlPct = getClosedPnlPct(posEntry, config.management.solMode);
              const nextFinalValueUsd = parseFloat(posEntry.allTimeWithdrawals?.total?.usd || 0);
              const nextInitialUsd = parseFloat(posEntry.allTimeDeposits?.total?.usd || 0);
              const nextFeesUsd = parseFloat(posEntry.allTimeFees?.total?.usd || 0) || feesUsd;

              if (shouldRejectClosedPnl(nextPnlPct, reason || tracked?.close_reason)) {
                log("close_warn", `Rejected unsettled closed PnL for ${position_address.slice(0, 8)} on attempt ${attempt + 1}/6: ${nextPnlPct.toFixed(2)}%`);
              } else {
                pnlTrueUsd    = nextPnlUsd;
                pnlUsd        = nextPnlValue;
                pnlPct        = nextPnlPct;
                finalValueUsd = nextFinalValueUsd;
                initialUsd    = nextInitialUsd;
                feesUsd       = nextFeesUsd;
                log("close", `Closed PnL from API: pnl=${pnlUsd.toFixed(2)} ${config.management.solMode ? "SOL" : "USD"} (${pnlPct.toFixed(2)}%), withdrawn=${finalValueUsd.toFixed(2)} USD, deposited=${initialUsd.toFixed(2)} USD`);
                break;
              }
            } else {
              log("close_warn", `Position not found in status=closed response (attempt ${attempt + 1}/6) — may still be settling`);
            }
          }
          if (attempt < 5) await new Promise((r) => setTimeout(r, 5000));
        }
      } catch (e: any) {
        log("close_warn", `Closed PnL fetch failed: ${e.message}`);
      }
      // Fallback to pre-close cache snapshot if closed API had no data
      if (finalValueUsd === 0) {
        const cachedPos = _positionsCache?.positions?.find((p: any) => p.position === position_address);
        if (cachedPos) {
          pnlTrueUsd    = cachedPos.pnl_true_usd ?? (config.management.solMode ? 0 : cachedPos.pnl_usd) ?? 0;
          pnlUsd        = config.management.solMode ? (cachedPos.pnl_usd ?? 0) : pnlTrueUsd;
          pnlPct        = cachedPos.pnl_pct   ?? 0;
          feesUsd       = (cachedPos.collected_fees_true_usd || 0) + (cachedPos.unclaimed_fees_true_usd || 0);
          initialUsd    = tracked.initial_value_usd || 0;
          if (initialUsd > 0) {
            // Keep fallback internally consistent using USD-only cached metrics.
            finalValueUsd = Math.max(0, initialUsd + pnlTrueUsd - feesUsd);
            if (!config.management.solMode) pnlPct = (pnlTrueUsd / initialUsd) * 100;
          } else {
            finalValueUsd = cachedPos.total_value_true_usd ?? cachedPos.total_value_usd ?? 0;
            initialUsd = Math.max(0, finalValueUsd + feesUsd - pnlTrueUsd);
          }
          log("close_warn", `Using cached pnl fallback because closed API has not settled yet`);
        }
      }

      const closeBaseMint = pool.lbPair.tokenXMint.toString();
      const signalSnapshot = resolvePerformanceSignalSnapshot({
        poolAddress,
        baseMint: closeBaseMint,
        tracked,
      });

      await recordPerformance({
        position: position_address,
        pool: poolAddress,
        pool_name: tracked.pool_name || poolMeta.name || poolAddress.slice(0, 8),
        base_mint: closeBaseMint,
        strategy: tracked.strategy,
        bin_range: tracked.bin_range,
        bin_step: (tracked.bin_step || null) as any,
        volatility: (tracked.volatility ?? null) as any,
        fee_tvl_ratio: (tracked.fee_tvl_ratio || null) as any,
        organic_score: (tracked.organic_score || null) as any,
        amount_sol: tracked.amount_sol,
        deployed_at: tracked.deployed_at,
        fees_earned_usd: feesUsd,
        fees_earned_sol: undefined as any,
        final_value_usd: finalValueUsd,
        initial_value_usd: initialUsd,
        minutes_in_range: minutesHeld - minutesOOR,
        minutes_held: minutesHeld,
        close_reason: reason || "agent decision",
        signal_snapshot: signalSnapshot ?? undefined,
        entry_mcap: (tracked as any).entry_mcap ?? null,
        entry_tvl: (tracked as any).entry_tvl ?? null,
        entry_volume: (tracked as any).entry_volume ?? null,
        entry_holders: (tracked as any).entry_holders ?? null,
        ...exitMarket,
      });

      appendDecision({
        type: "close",
        actor: "MANAGER",
        pool: poolAddress,
        pool_name: tracked.pool_name || poolMeta.name || poolAddress.slice(0, 8),
        position: position_address,
        summary: `Closed at ${pnlPct.toFixed(2)}%`,
        reason: reason || "agent decision",
        risks: [
          minutesOOR > 0 ? `out of range ${minutesOOR}m` : null,
          tracked.volatility != null ? `volatility ${tracked.volatility}` : null,
        ].filter(Boolean) as string[],
        metrics: {
          pnl_usd: pnlUsd,
          pnl_pct: pnlPct,
          fees_usd: feesUsd,
          minutes_held: minutesHeld,
        },
      });

      return {
        success: true,
        position: position_address,
        pool: poolAddress,
        pool_name: tracked.pool_name || poolMeta.name || null,
        claim_txs: claimTxHashes,
        close_txs: closeTxHashes,
        txs: txHashes,
        pnl_usd: pnlUsd,
        pnl_pct: pnlPct,
        base_mint: closeBaseMint,
      };
    }

    appendDecision({
      type: "close",
      actor: "MANAGER",
      pool: poolAddress,
      pool_name: poolMeta.name || poolAddress.slice(0, 8),
      position: position_address,
      summary: "Closed position",
      reason: reason || "agent decision",
      metrics: {},
    });

    return {
      success: true,
      position: position_address,
      pool: poolAddress,
      pool_name: poolMeta.name || null,
      claim_txs: claimTxHashes,
      close_txs: closeTxHashes,
      txs: txHashes,
      base_mint: pool.lbPair.tokenXMint.toString(),
    };
  } catch (error: any) {
    log("close_error", error.message);
    return { success: false, error: error.message };
  }
}

// ─── Helpers ──────────────────────────────────────────────────
// ─── Re-exports for sibling modules ───────────────────────────
// These functions live in their own files (see ./claim.ts, ./position.ts)
// to keep core.ts focused on deploy/close/positions-state. They are
// re-exported here so internal call sites can keep importing from
// "./core.js" without churn.

/**
 * Resolve a position address to its pool address.
 * Checks tracked state, in-memory cache, then falls back to SDK scan.
 */
export async function lookupPoolForPosition(position_address: string, walletAddress: string): Promise<string> {
  const tracked = getTrackedPosition(position_address);
  if (tracked?.pool) return tracked.pool;
  const cached = _positionsCache?.positions?.find((p: any) => p.position === position_address);
  if (cached?.pool) return cached.pool;
  const { DLMM } = await getDLMM();
  const allPositions = await DLMM.getAllLbPairPositionsByUser(getConnection(), new PublicKey(walletAddress));
  for (const [lbPairKey, positionData] of Object.entries(allPositions) as [string, any][]) {
    for (const pos of positionData.lbPairPositionsData || []) {
      if (pos.publicKey.toString() === position_address) return lbPairKey;
    }
  }
  throw new Error(`Position ${position_address} not found in open positions`);
}