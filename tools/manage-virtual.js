import BN from "bn.js";
import { getBinsInRange, getConnection, invalidatePositionsCache } from "./dlmm.js";
import {
  listVirtualPositions,
  updateVirtualPosition,
  closeVirtualPosition,
  getVirtualPosition,
} from "./dry-run-state.js";
import { fetchSolPrice } from "./wallet.js";
import { recordPoolDeploy } from "../pool-memory.js";
import { config } from "../config.js";
import { log } from "../logger.js";
import { estimateCloseGasSol, samplePriorityFee } from "./gas-estimator.js";
import { getVirtualCloseRule } from "./virtual-close-rule.js";
import { computePositionPnl, estimateSlippageLamports } from "./compute-position-pnl.js";

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
 * Build the polymorphic position view for the close rule.
 * Caller selects unit (SOL when solMode, USD otherwise) once; the rule
 * reads pre-computed polymorphic values. Mirrors the live
 * getDeterministicCloseRule shape in index.js, which sees
 * position.pnl_pct from getMyPositions — already polymorphic via
 * mergeVirtualPositions. Without this branching the rule would always
 * check USD PnL while Telegram shows SOL PnL, so TP/SL/trailing-TP
 * decisions would diverge from the display.
 */
function buildPosForRule(vp, updates, pnl, activeBin, exitIsSol) {
  return {
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
}

/**
 * Build the result object for a closed VP. Used by both the rule-based
 * and trailing-TP close paths.
 */
function buildCloseResult(pnl, ageMinutes) {
  return {
    age_minutes: ageMinutes,
    pnl_pct: pnl.pnlPct, pnl_usd: pnl.pnlUsd,
    pnl_sol_pct: pnl.pnlSolPct, pnl_sol: pnl.netPnlSol,
    il_sol: pnl.rawPnlSol, unclaimed_fees_sol: pnl.feesSol,
    cost_sol: pnl.totalCostSol, il_usd: pnl.ilUsd,
    unclaimed_fees_usd: pnl.feesUsd, cost_usd: pnl.totalCostUsd,
  };
}

/**
 * Record VP close to pool memory (not lessons/evolution — see NOTES.md).
 * Populates pool-memory.json so the SCREENER can skip pools with past losses.
 *
 * @param {object} vp       the (stale shallow) VP from listVirtualPositions
 * @param {object} pnl      the fresh PnL snapshot
 * @param {string} closeReason
 * @param {number} effectiveOorMinutes  FRESH OOR minutes for this cycle —
 *                     reads from `vp._oor_minutes` would be stale because
 *                     updateVirtualPosition mutates the file, not the
 *                     in-memory copy.
 */
function recordVpDeployToPoolMemory(vp, pnl, closeReason, effectiveOorMinutes) {
  const minutesHeld = vp.deployed_at
    ? Math.floor((Date.now() - new Date(vp.deployed_at).getTime()) / 60000)
    : 0;
  const minutesOOR = effectiveOorMinutes || 0;
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

/**
 * Close a VP, record the result, and return the PnL snapshot for the
 * result array. Returns null on close failure (caller continues to
 * next VP). Consolidates the duplicate close logic from the rule-based
 * and trailing-TP close paths.
 *
 * @param {number} effectiveOorMinutes  fresh OOR minutes for this cycle;
 *                     threaded through to recordVpDeployToPoolMemory.
 */
async function closeVpAndRecord(vp, reason, bins, solPrice, activeBin, cycleCloseGasSol, effectiveOorMinutes) {
  // Fresh re-estimate of close gas (bypass cycle cache)
  const finalCloseGasSol = await getFreshCloseGasSol(cycleCloseGasSol, vp.id);
  const finalPnl = computePositionPnl(vp, bins, solPrice, {
    closeGasSolOverride: finalCloseGasSol,
    activeBinId: activeBin,
  });

  const closed = closeVirtualPosition(vp.id, reason, finalPnl.pnlPct, finalPnl.pnlUsd, {
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
    return null;
  }
  invalidatePositionsCache(); // drop stale positions cache (next /positions re-fetches)
  recordVpDeployToPoolMemory(vp, finalPnl, reason, effectiveOorMinutes);
  log("vp", `VP ${vp.id} (${vp.pair}) CLOSED: ${reason} PnL=${finalPnl.pnlPct.toFixed(2)}% (SOL: ${finalPnl.pnlSolPct.toFixed(2)}%) deployGas=${finalPnl.deployGasSol.toFixed(6)} closeGas=${finalPnl.closeGasSol.toFixed(6)}`);
  return finalPnl;
}

/**
 * Manually close a VP with FRESH PnL computation. Used by:
 * - LLM `close_position` tool (executor.js)
 * - Telegram /close <n> command (index.js)
 *
 * Fetches fresh bins, fetches SOL price, recomputes PnL via
 * computePositionPnl — replacing the legacy `computeSimpleVirtualPnl`
 * which read the stale `vp.current_value_usd` field. Records to
 * pool memory, invalidates the positions cache.
 *
 * On any failure (VP not found, RPC error, archive write) returns
 * `{ success: false, error }` with NO partial state mutation.
 *
 * @param {string} vpId     the VP id (without "vp:" prefix)
 * @param {string} reason   the close reason (e.g. "LLM close_position tool")
 * @returns {Promise<{success: boolean, error?: string, dry_run?: true, is_virtual?: true, vp?: object, finalPnl?: object, pnl_usd?: number, pnl_pct?: number, position?: string, pair?: string, pool?: string, pool_name?: string, base_mint?: string}>}
 */
export async function closeVpManual(vpId, reason) {
  const vp = getVirtualPosition(vpId);
  if (!vp) return { success: false, error: `VP not found: ${vpId}` };

  // Fetch fresh bins + compute PnL. Mirrors the cycle's per-VP flow.
  let finalPnl;
  try {
    const { activeBin, bins } = await getBinsInRange({
      pool_address: vp.pool,
      lower_bin: vp.lower_bin,
      upper_bin: vp.upper_bin,
    });
    const solPrice = await fetchSolPrice();
    if (solPrice == null) {
      return { success: false, error: "Could not fetch SOL price for close PnL" };
    }
    // Manual close: no cycleCloseGasSol — use a fresh sample.
    const freshPf = await samplePriorityFee(getConnection(), { fresh: true });
    const freshCloseGasSol = await estimateCloseGasSol(getConnection(), freshPf);
    finalPnl = computePositionPnl(vp, bins, solPrice, {
      closeGasSolOverride: freshCloseGasSol,
      activeBinId: activeBin,
    });
  } catch (e) {
    log("vp_close", `Fresh PnL failed for manual close ${vpId}: ${e.message}`);
    return { success: false, error: `Fresh PnL failed: ${e.message}` };
  }

  // Close with USD values (archive is USD-native); pass extra fields for
  // the JSONL archive. Mirrors closeVpAndRecord's extraFields exactly.
  const closed = closeVirtualPosition(vpId, reason, finalPnl.pnlPct, finalPnl.pnlUsd, {
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
    return { success: false, error: "VP close failed (archive write error?)" };
  }
  invalidatePositionsCache();
  // Manual close has no fresh effectiveOorMinutes from a cycle; pass
  // the stored value (may be stale by minutes, but it's the best we have
  // without a separate OOR computation pass).
  recordVpDeployToPoolMemory(vp, finalPnl, reason, vp._oor_minutes || 0);
  log("vp_close", `VP ${vpId} (${vp.pair}) CLOSED (manual): ${reason} PnL=${finalPnl.pnlPct.toFixed(2)}% (SOL: ${finalPnl.pnlSolPct.toFixed(2)}%)`);

  // Polymorphic for display (matches getMyPositions convention).
  const isSol = !!config.management.solMode;
  return {
    success: true,
    dry_run: true,
    is_virtual: true,
    vp,
    finalPnl,
    position: `vp:${vpId}`,
    pair: vp.pair || vp.pool_name || `vp:${vpId}`,
    pool: vp.pool,
    pool_name: vp.pool_name || vp.pair,
    base_mint: vp.base_mint || null,
    pnl_usd: isSol ? finalPnl.netPnlSol : finalPnl.pnlUsd,
    pnl_pct: isSol ? finalPnl.pnlSolPct : finalPnl.pnlPct,
  };
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
      const pnl = computePositionPnl(vp, binResult.bins, solPrice, {
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
        // Native SOL fields — kept in sync with computePositionPnl output so
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

      // ── Decide: close (rule OR trailing) or stay ───────────────────
      const exitIsSol = !!mgmtConfig.solMode;
      const posForRule = buildPosForRule(vp, updates, pnl, activeBin, exitIsSol);
      const vpAgeMinutes = vp.deployed_at
        ? Math.floor((Date.now() - new Date(vp.deployed_at).getTime()) / 60000)
        : 0;
      const closeRule = getVirtualCloseRule(posForRule, mgmtConfig, effectiveOorMinutes);
      const closeReason = closeRule?.reason || trailingCloseReason;
      if (closeReason) {
        // Persist final state BEFORE closing (preserves snapshot, peak, OOR)
        updateVirtualPosition(vp.id, updates);
        const finalPnl = await closeVpAndRecord(
          vp, closeReason, binResult.bins, solPrice, activeBin, cycleCloseGasSol, effectiveOorMinutes
        );
        if (!finalPnl) continue;
        results.push({
          id: vp.id, pair: vp.pair, action: "CLOSED", reason: closeReason,
          ...buildCloseResult(finalPnl, vpAgeMinutes),
        });
        continue;
      }

      // ── Stay ──────────────────────────────────────────────────────
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
