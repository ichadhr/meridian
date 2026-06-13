/**
 * Virtual position management cycle.
 *
 * Fetches live bin state, computes PnL, updates state, auto-closes on exit conditions.
 */

import BN from "bn.js";
import { getBinsInRange, invalidatePositionsCache } from "../../providers/meteora/index.js";
import { getConnection } from "../../providers/solana/index.js";
import {
  listVpPositions,
  updateVpPosition,
  recordVpClose,
  getVpPosition,
  isVpOutOfRange,
  markVpOutOfRange,
  markVpInRange,
  minutesVpOutOfRange,
} from "./state.js";
import { fetchSolPrice } from "../../providers/jupiter/index.js";
import { recordPoolDeploy } from "../pool-memory.js";
import { config } from "../../config/index.js";
import { log } from "../../utils/logger.js";
import { estimateCloseGasSol, samplePriorityFee } from "../../providers/solana/gas-estimator.js";
import { getCloseRule } from "../close-rules.js";
import { computePositionPnl, estimateSlippageLamports } from "../pnl.js";
import type { PositionPnlResult, BinData } from "../pnl.js";
import type { VpPosition, VpResult } from "../../types/index.js";

/** Return type from getBinsInRange (dlmm.js is still JS) */
interface BinsInRangeResult {
  activeBin: number;
  binStep: number | null;
  sParameter: unknown;
  vParameter: unknown;
  bins: BinData[];
}

/** Return type from closeVpPosition */
interface CloseVpPositionResult {
  success: boolean;
  error?: string;
  dry_run?: true;
  is_virtual?: true;
  vp?: VpPosition;
  finalPnl?: PositionPnlResult;
  pnl_usd?: number;
  pnl_pct?: number;
  position?: string;
  pair?: string;
  pool?: string;
  pool_name?: string;
  base_mint?: string;
}

/**
 * Re-estimate close gas with a FRESH priority fee sample (bypass cache) so
 * the close PnL reflects the real network state at close time. Falls back
 * to the cycle value on RPC failure (logs a warning).
 *
 * Used by both close-rule and trailing-TP close paths in
 * runVpManagementCycle.
 */
async function getFreshCloseGasSol(cycleCloseGasSol: number, vpId: string): Promise<number> {
  try {
    const freshPf = await samplePriorityFee(getConnection(), { fresh: true });
    return await estimateCloseGasSol(getConnection(), freshPf);
  } catch (e) {
    log("vp", `Fresh close gas estimate failed for ${vpId}: ${(e as Error).message} — using cycle value`);
    return cycleCloseGasSol;
  }
}

/**
 * Build the polymorphic position view for the close rule.
 * Caller selects unit (SOL when solMode, USD otherwise) once; the rule
 * reads pre-computed polymorphic values. Mirrors the live
 * getCloseRule shape in core/close-rules.ts, which sees
 * position.pnl_pct from getMyPositions — already polymorphic via
 * mergeVpPositions. Without this branching the rule would always
 * check USD PnL while Telegram shows SOL PnL, so TP/SL/trailing-TP
 * decisions would diverge from the display.
 */
function buildPosForRule(
  vp: VpPosition,
  updates: Record<string, unknown>,
  pnl: PositionPnlResult,
  activeBin: number,
  exitIsSol: boolean,
): Record<string, unknown> {
  return {
    ...vp,
    ...updates,
    pnl_pct: exitIsSol ? pnl.pnlSolPct : pnl.pnlPct,
    total_value_usd: exitIsSol ? pnl.positionValueSol : pnl.currentValueUsd,
    unclaimed_fees_usd: exitIsSol ? pnl.unclaimedFeesSol : pnl.unclaimedFeesUsd,
    active_bin: activeBin,
  };
}

/**
 * Build the result object for a closed VP. Used by both the rule-based
 * and trailing-TP close paths.
 */
function buildCloseResult(
  pnl: PositionPnlResult,
  ageMinutes: number,
): Record<string, number> {
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
 */
function recordVpDeployToPoolMemory(
  vp: VpPosition,
  pnl: PositionPnlResult,
  closeReason: string,
  effectiveOorMinutes: number,
): void {
  const minutesHeld = vp.deployed_at
    ? Math.floor((Date.now() - new Date(vp.deployed_at).getTime()) / 60000)
    : 0;
  const minutesOOR = effectiveOorMinutes || 0;
  const rangeEfficiency = minutesHeld > 0
    ? Math.max(0, (minutesHeld - minutesOOR) / minutesHeld * 100)
    : 0;

  try {
    recordPoolDeploy(vp.pool, {
      pool_name: vp.pool_name ?? vp.pair ?? (undefined as unknown as string),
      base_mint: vp.base_mint ?? undefined,
      deployed_at: vp.deployed_at ?? undefined,
      closed_at: new Date().toISOString(),
      pnl_pct: pnl.pnlPct,
      pnl_usd: pnl.pnlUsd,
      range_efficiency: rangeEfficiency,
      minutes_held: minutesHeld,
      fees_earned_usd: pnl.unclaimedFeesUsd,
      fees_earned_sol: pnl.unclaimedFeesSol,
      fee_earned_pct: (vp.initial_value_usd ?? 0) > 0
        ? ((pnl.unclaimedFeesUsd || 0) / vp.initial_value_usd!) * 100
        : undefined,
      close_reason: closeReason,
      strategy: vp.strategy,
      volatility: undefined,
    } as any);
  } catch (e) {
    log("vp", `Failed to record VP deploy to pool memory: ${(e as Error).message}`);
  }
}

/**
 * Close a VP, record the result, and return the PnL snapshot for the
 * result array. Returns null on close failure (caller continues to
 * next VP). Consolidates the duplicate close logic from the rule-based
 * and trailing-TP close paths.
 */
async function closeVpAndRecord(
  vp: VpPosition,
  reason: string,
  bins: BinData[],
  solPrice: number,
  activeBin: number,
  cycleCloseGasSol: number,
  effectiveOorMinutes: number,
  poolParams: { binStep: number; sParameter: unknown; vParameter: unknown } | null,
): Promise<PositionPnlResult | null> {
  const finalCloseGasSol = await getFreshCloseGasSol(cycleCloseGasSol, vp.id);
  const finalPnl = computePositionPnl(vp as any, bins, solPrice, {
    closeGasSolOverride: finalCloseGasSol,
    activeBinId: activeBin,
    poolParams: poolParams ?? undefined,
  });

  const closed = recordVpClose(vp.id, reason, finalPnl.pnlPct, finalPnl.pnlUsd, {
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
  invalidatePositionsCache();
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
 */
export async function closeVpPosition(vp_id: string, reason: string): Promise<CloseVpPositionResult> {
  const vp = getVpPosition(vp_id);
  if (!vp) return { success: false, error: `VP not found: ${vp_id}` };

  let finalPnl: PositionPnlResult;
  try {
    const binResult = await getBinsInRange({
      pool_address: vp.pool,
      lower_bin: vp.lower_bin!,
      upper_bin: vp.upper_bin!,
    }) as BinsInRangeResult;
    const solPrice = await fetchSolPrice();
    if (solPrice == null) {
      return { success: false, error: "Could not fetch SOL price for close PnL" };
    }
    const freshPf = await samplePriorityFee(getConnection(), { fresh: true });
    const freshCloseGasSol = await estimateCloseGasSol(getConnection(), freshPf);
    const poolParams = binResult.binStep != null && binResult.sParameter != null && binResult.vParameter != null
      ? { binStep: binResult.binStep, sParameter: binResult.sParameter, vParameter: binResult.vParameter }
      : null;
    finalPnl = computePositionPnl(vp as any, binResult.bins, solPrice, {
      closeGasSolOverride: freshCloseGasSol,
      activeBinId: binResult.activeBin,
      poolParams: poolParams ?? undefined,
    });
  } catch (e) {
    log("vp_close", `Fresh PnL failed for manual close ${vp_id}: ${(e as Error).message}`);
    return { success: false, error: `Fresh PnL failed: ${(e as Error).message}` };
  }

  const closed = recordVpClose(vp_id, reason, finalPnl.pnlPct, finalPnl.pnlUsd, {
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
  recordVpDeployToPoolMemory(vp, finalPnl, reason, vp._oor_minutes || 0);
  log("vp_close", `VP ${vp_id} (${vp.pair}) CLOSED (manual): ${reason} PnL=${finalPnl.pnlPct.toFixed(2)}% (SOL: ${finalPnl.pnlSolPct.toFixed(2)}%)`);

  const isSol = !!config.management.solMode;
  return {
    success: true,
    dry_run: true,
    is_virtual: true,
    vp,
    finalPnl,
    position: `vp:${vp_id}`,
    pair: vp.pair || vp.pool_name || `vp:${vp_id}`,
    pool: vp.pool,
    pool_name: vp.pool_name || vp.pair || undefined,
    base_mint: vp.base_mint || undefined,
    pnl_usd: isSol ? finalPnl.netPnlSol : finalPnl.pnlUsd,
    pnl_pct: isSol ? finalPnl.pnlSolPct : finalPnl.pnlPct,
  };
}

// ─── Trailing TP ────────────────────────────────────────────────────────────
// Functions live in core/vp/state.ts (same pattern as core/live/state.ts)
import { queueVpPeakConfirmation, queueVpTrailingDropConfirmation, updateVpPnlAndCheckExits } from "./state.js";

// ─── Main Management Cycle ──────────────────────────────────────────────────

/**
 * Run one management cycle for all open virtual positions.
 * Fetches live bin state, computes PnL, updates state, auto-closes on exit conditions.
 *
 * @returns Result array with { id, pair, action, ... } for each VP
 */
export async function runVpManagementCycle(): Promise<VpResult[]> {
  const vpList = listVpPositions("open");
  if (vpList.length === 0) return [];

  const solPrice = await fetchSolPrice();
  if (solPrice == null) {
    log("vp", "Management cycle skipped: could not fetch valid SOL price");
    return [];
  }

  let cycleCloseGasSol: number | null = null;
  try {
    cycleCloseGasSol = await estimateCloseGasSol(getConnection());
  } catch (e) {
    log("vp", `Failed to estimate close gas: ${(e as Error).message} — using stored vp.close_gas_sol`);
  }

  const mgmtConfig = config.management || {};
  const results: VpResult[] = [];
  const binCache = new Map<string, Promise<BinsInRangeResult | null>>();

  for (const vp of vpList) {
    try {
      const cacheKey = `${vp.pool}:${vp.lower_bin}:${vp.upper_bin}`;
      if (!binCache.has(cacheKey)) {
        binCache.set(
          cacheKey,
          getBinsInRange({
            pool_address: vp.pool,
            lower_bin: vp.lower_bin!,
            upper_bin: vp.upper_bin!,
          }).catch((err) => {
            log("vp", `Bin fetch failed for ${vp.id}: ${(err as Error).message}`);
            return null;
          }) as Promise<BinsInRangeResult | null>,
        );
      }
      const binResult = await binCache.get(cacheKey);
      if (!binResult || !binResult.bins) {
        log("vp", `Skipping ${vp.id}: no bin data available`);
        continue;
      }

      const activeBin = binResult.activeBin;
      const poolParams = binResult.binStep != null && binResult.sParameter != null && binResult.vParameter != null
        ? { binStep: binResult.binStep, sParameter: binResult.sParameter, vParameter: binResult.vParameter }
        : null;
      const pnl = computePositionPnl(vp as any, binResult.bins, solPrice, {
        closeGasSolOverride: cycleCloseGasSol,
        activeBinId: activeBin,
        poolParams: poolParams ?? undefined,
      });

      const upperBin = vp.upper_bin ?? null;
      const oor = isVpOutOfRange(activeBin, upperBin)
        ? markVpOutOfRange(activeBin, upperBin, vp._oor_since as string | null)
        : markVpInRange(activeBin, upperBin, vp._oor_since as string | null);
      const oorMinutes = minutesVpOutOfRange(oor.oorSince);

      const updates: Record<string, unknown> = {
        _peak_pnl_pct: Math.max(vp._peak_pnl_pct || 0, pnl.pnlPct),
        _peak_pnl_sol_pct: Math.max(vp._peak_pnl_sol_pct || 0, pnl.pnlSolPct),
        _oor_since: oor.oorSince,
        _oor_minutes: oorMinutes,
        _trailing_active: vp._trailing_active || false,
        _trailing_pending: vp._trailing_pending || false,
        _trailing_pending_since: vp._trailing_pending_since || null,
        last_sync_at: new Date().toISOString(),
      };

      const trailingIsSol = !!mgmtConfig.solMode;
      const trailingPeakField = trailingIsSol ? "_peak_pnl_sol_pct" : "_peak_pnl_pct";
      const trailingPeak = (updates[trailingPeakField] as number) || 0;
      const trailingCurrentPnl = trailingIsSol ? pnl.pnlSolPct : pnl.pnlPct;

      const trailingResult = updateVpPnlAndCheckExits(
        vp._trailing_active || false,
        vp._trailing_pending || false,
        trailingPeak,
        trailingCurrentPnl,
        mgmtConfig
      );

      updates._trailing_active = trailingResult.trailingActive;
      updates._trailing_pending = trailingResult.trailingPending;
      let trailingCloseReason = trailingResult.trailingCloseReason;

      if (trailingResult.trailingPending && !vp._trailing_pending) {
        updates._trailing_pending_since = new Date().toISOString();
      } else if (!trailingResult.trailingPending) {
        updates._trailing_pending_since = null;
      }

      const snapshots = (vp.snapshots || []) as Array<Record<string, unknown>>;
      snapshots.push({
        at: new Date().toISOString(),
        pnl_pct: pnl.pnlPct,
        pnl_sol_pct: pnl.pnlSolPct,
        value_usd: pnl.currentValueUsd,
        value_sol: pnl.positionValueSol,
        unclaimed_fees_usd: pnl.unclaimedFeesUsd,
        sol_price: solPrice,
        active_bin: activeBin,
        oor_minutes: oorMinutes,
      });
      if (snapshots.length > 100) snapshots.splice(0, snapshots.length - 100);
      updates.snapshots = snapshots;

      const exitIsSol = !!mgmtConfig.solMode;
      const posForRule = buildPosForRule(vp, updates, pnl, activeBin, exitIsSol);
      const vpAgeMinutes = vp.deployed_at
        ? Math.floor((Date.now() - new Date(vp.deployed_at).getTime()) / 60000)
        : 0;
      const closeRule = getCloseRule(posForRule as any, mgmtConfig as any, oorMinutes);
      const closeReason = closeRule?.reason || trailingCloseReason;
      if (closeReason) {
        updateVpPosition(vp.id, updates);
        const finalPnl = await closeVpAndRecord(
          vp, closeReason, binResult.bins, solPrice, activeBin, cycleCloseGasSol!, oorMinutes, poolParams
        );
        if (!finalPnl) continue;
        results.push({
          id: vp.id, pair: vp.pair!, action: "CLOSED", reason: closeReason,
          ...buildCloseResult(finalPnl, vpAgeMinutes),
        } as VpResult);
        continue;
      }

      updateVpPosition(vp.id, updates);

      const oorLabel = oor.oorSince ? `OOR ${oorMinutes}m` : "IN";
      results.push({
        id: vp.id,
        pair: vp.pair!,
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
      log("vp_error", `VP ${vp.id} management failed: ${(e as Error).message}`);
    }
  }

  return results;
}
