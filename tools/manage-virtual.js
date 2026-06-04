import BN from "bn.js";
import { getBinsInRange, decimalPriceToQ64 } from "./dlmm.js";
import {
  listVirtualPositions,
  updateVirtualPosition,
  closeVirtualPosition,
} from "./dry-run-state.js";
import { getWalletBalances } from "./wallet.js";
import { recordPoolDeploy } from "../pool-memory.js";
import { config } from "../config.js";
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
export function computeVirtualPnl(vp, binData, solPrice) {
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
    const priceBN = b ? decimalPriceToQ64(b.price) : ZERO;

    // If bin missing from RPC or has no supply → 0 value, 0 fees
    const xAmount = b ? new BN(b.xAmount ?? "0") : ZERO;
    const yAmount = b ? new BN(b.yAmount ?? "0") : ZERO;
    const ourX = supply.isZero() ? ZERO : shares.mul(xAmount).div(supply);
    const ourY = supply.isZero() ? ZERO : shares.mul(yAmount).div(supply);

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

    const unclaimedFeeX = mulShr(shares, feeXDelta, 64); // in X lamports
    const unclaimedFeeY = mulShr(shares, feeYDelta, 64); // in Y lamports
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

  const positionValueSol = Number(totalValueYLamports) / LAMPORTS_PER_SOL;
  const unclaimedFeesSol = Number(totalFeeYLamports) / LAMPORTS_PER_SOL;
  const unclaimedFeesUsd = unclaimedFeesSol * solPrice;
  const currentValueUsd = positionValueSol * solPrice + unclaimedFeesUsd;
  const initialValueUsd = vp.initial_value_usd || 0;
  const pnlUsd = currentValueUsd - initialValueUsd;
  const pnlPct = initialValueUsd > 0 ? (pnlUsd / initialValueUsd) * 100 : 0;

  return {
    positionValueSol,
    unclaimedFeesSol,
    unclaimedFeesUsd,
    pnlUsd,
    pnlPct,
    currentValueUsd,
    initialValueUsd,
    perBin,
  };
}

/**
 * Deterministic close rules for virtual positions.
 * Static close rules only — trailing TP handled by the caller.
 *
 * NOTE: LOW_YIELD (minFeePerTvl24h / minAgeBeforeYieldCheck) is intentionally
 * omitted — it relies on the pool-level feePerTvl24h from the Meteora API
 * (getMyPositions), which VP does not fetch. A synthetic backward-looking
 * approximation would be semantically different and not worth the complexity.
 *
 * @param {object} vp                Virtual position
 * @param {number} pnlPct            Current PnL percentage
 * @param {number} currentValueUsd   Current position value in USD
 * @param {number} activeBin         Current pool active bin
 * @param {object} mgmtConfig        config.management
 * @param {number} effectiveOorMinutes  Computed OOR minutes for THIS cycle (not stale stored value)
 */
export function getVirtualCloseRule(vp, pnlPct, currentValueUsd, activeBin, mgmtConfig, effectiveOorMinutes = 0) {
  const stopLossPct = mgmtConfig.stopLossPct ?? -50;
  const takeProfitPct = mgmtConfig.takeProfitPct ?? 100;
  const oorWaitMinutes = mgmtConfig.outOfRangeWaitMinutes ?? 30;
  // Guard against corrupted position state
  if (vp.upper_bin == null || activeBin == null) return null;

  const oorBinsToClose = mgmtConfig.outOfRangeBinsToClose ?? 5;

  // Stop loss
  if (pnlPct != null && pnlPct <= stopLossPct) {
    return { action: "CLOSE", rule: 1, reason: "stop loss" };
  }

  // Take profit
  if (pnlPct != null && pnlPct >= takeProfitPct) {
    return { action: "CLOSE", rule: 2, reason: "take profit" };
  }

  // Pumped far above range
  if (activeBin > vp.upper_bin + oorBinsToClose) {
    return { action: "CLOSE", rule: 3, reason: "pumped far above range" };
  }

  // OOR too long (uses THIS cycle's accumulated OOR minutes, not stale stored value)
  if (activeBin > vp.upper_bin && effectiveOorMinutes >= oorWaitMinutes) {
    return { action: "CLOSE", rule: 4, reason: "OOR" };
  }

  return null;
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

  const wallet = await getWalletBalances();
  const solPrice = wallet.sol_price || 0;
  const mgmtConfig = config.management || {};
  const results = [];

  // Deduplicate bin fetches: key = "pool:lower:upper"
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
        base_mint: null,
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
      const pnl = computeVirtualPnl(vp, binResult.bins, solPrice);
      const activeBin = binResult.activeBin;
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

      const updates = {
        current_value_usd: pnl.currentValueUsd,
        total_fees_earned_usd: (vp.total_fees_earned_usd || 0) + newlyAccruedFeesUsd,
        _last_unclaimed_fees_usd: pnl.unclaimedFeesUsd,
        _peak_pnl_pct: Math.max(vp._peak_pnl_pct || 0, pnl.pnlPct),
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

      if (mgmtConfig.trailingTakeProfit && !trailingActive && (updates._peak_pnl_pct || 0) >= (mgmtConfig.trailingTriggerPct ?? 6)) {
        trailingActive = true;
      }

      if (mgmtConfig.trailingTakeProfit && trailingActive) {
        const peak = updates._peak_pnl_pct || 0;
        const dropFromPeak = peak - pnl.pnlPct;
        const effectiveDropPct = mgmtConfig.trailingDropPct ?? 2.5;
        if (dropFromPeak >= effectiveDropPct && pnl.pnlPct >= 0) {
          if (trailingPending) {
            trailingCloseReason = `trailing TP: peak ${peak.toFixed(2)}% → current ${pnl.pnlPct.toFixed(2)}% (dropped ${dropFromPeak.toFixed(2)}% ≥ ${effectiveDropPct}%)`;
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
        value_usd: pnl.currentValueUsd,
        value_sol: pnl.positionValueSol,
        unclaimed_fees_usd: pnl.unclaimedFeesUsd,
        sol_price: solPrice,
        active_bin: activeBin,
        oor_minutes: effectiveOorMinutes,
      });
      if (snapshots.length > 100) snapshots.splice(0, snapshots.length - 100);
      updates.snapshots = snapshots;

      // ── Exit rules (pass freshly computed OOR minutes) ─────────────
      const closeRule = getVirtualCloseRule(
        vp, pnl.pnlPct, pnl.currentValueUsd, activeBin, mgmtConfig, effectiveOorMinutes,
      );
      if (closeRule) {
        // Persist final state BEFORE closing (preserves snapshot, peak, OOR)
        updateVirtualPosition(vp.id, updates);
        recordVpDeployToPoolMemory(vp, pnl, closeRule.reason);
        closeVirtualPosition(vp.id, closeRule.reason, pnl.pnlPct, pnl.pnlUsd);
        results.push({
          id: vp.id,
          pair: vp.pair,
          action: "CLOSED",
          reason: closeRule.reason,
          pnl_pct: pnl.pnlPct,
          pnl_usd: pnl.pnlUsd,
        });
        log("vp", `VP ${vp.id} (${vp.pair}) CLOSED: ${closeRule.reason} PnL=${pnl.pnlPct.toFixed(2)}%`);
        continue;
      }

      // ── Trailing TP close (2-cycle confirmed) ──────────────────────
      if (trailingCloseReason) {
        updateVirtualPosition(vp.id, updates);
        recordVpDeployToPoolMemory(vp, pnl, trailingCloseReason);
        closeVirtualPosition(vp.id, trailingCloseReason, pnl.pnlPct, pnl.pnlUsd);
        results.push({
          id: vp.id,
          pair: vp.pair,
          action: "CLOSED",
          reason: trailingCloseReason,
          pnl_pct: pnl.pnlPct,
          pnl_usd: pnl.pnlUsd,
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
        pnl_pct: pnl.pnlPct,
        value_sol: pnl.positionValueSol,
        value_usd: pnl.currentValueUsd,
        unclaimed_fees_usd: pnl.unclaimedFeesUsd,
        oor: oorLabel,
      });
    } catch (e) {
      log("vp_error", `VP ${vp.id} management failed: ${e.message}`);
    }
  }

  return results;
}
