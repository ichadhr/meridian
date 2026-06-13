import fs from "fs";
import { log } from "../../utils/logger.js";
import {
  appendArchiveRecordIfNew,
  dedupeAllArchives,
} from "../archive.js";
import type { VpPosition } from "../../types/index.js";

import { VP_STATE_FILE, ARCHIVE_DIR } from "../../config/paths.js";

const STATE_FILE = VP_STATE_FILE;

// ─── Types ────────────────────────────────────────────────────────────────

export interface VpState {
  virtual_positions: VpPosition[];
  lastUpdated?: string;
}

/** Per-bin LP position at deploy time. All numeric fields stored as BN strings for JSON safety. */
export interface BinShareEntry {
  binId: number;
  shares: string;
  price: string | null;
  feeXPerTokenComplete: string | null;
  feeYPerTokenComplete: string | null;
  xAmount: string | null;
  yAmount: string | null;
}

/** Parameters accepted by trackVpPosition. */
export interface TrackVpPositionParams {
  pool: string;
  pool_name?: string | null;
  pair?: string;
  strategy?: string;
  bins_below: number;
  lower_bin: number;
  upper_bin: number;
  active_bin: number;
  bin_step: number;
  amount_sol: number;
  initial_value_usd: number;
  sol_price_at_deploy?: number | null;
  /**
   * Per-bin LP position at deploy time. All numeric fields stored as BN strings for JSON safety.
   * - shares: virtual LP tokens attributed to this position in the bin
   * - price: bin price in Q64.64 format (for liquidity math verification)
   * - fee{X,Y}PerTokenComplete: stored fee accumulators at deploy (for delta-based fee calc)
   * - xAmount, yAmount: bin's total token amounts at deploy time (for debugging/verification)
   */
  bin_shares?: BinShareEntry[];
  base_mint?: string | null;
  // Structured screener signals captured at deploy time. Mirrors the
  // signal_snapshot field on live positions in live_state.json — numeric scores
  // + booleans (organic_score, fee_tvl_ratio, volatility, etc.) used for
  // retro-analysis and Darwin weight tuning. null if Darwin is disabled or
  // no signals were staged for this pool/mint.
  signal_snapshot?: Record<string, unknown> | null;
  // Screening metadata — used by Virtual Digest for pattern analysis
  volatility?: number | null;
  fee_tvl_ratio?: unknown;
  organic_score?: unknown;
  // Real-time gas estimate — deploy gas is frozen at deploy time, close gas
  // is refreshed on every PnL cycle and re-estimated at close with a fresh
  // priority fee sample.
  deploy_gas_sol?: number | null;
  close_gas_sol?: number | null;
  gas_priority_fee?: number | null; // priority fee (µl/CU) at deploy time, for reference
  gas_cost_sol?: number | null;     // legacy: kept for back-compat with VPs deployed under prev. version
}

// ─── Internal helpers ─────────────────────────────────────────────────────

function load(): VpState {
  if (!fs.existsSync(STATE_FILE)) {
    return { virtual_positions: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as VpState;
  } catch (err) {
    log("dry_run_state", `Failed to read: ${(err as Error).message}`);
    return { virtual_positions: [] };
  }
}

/** Persist state. Returns true on success, false on error. */
function save(data: VpState): boolean {
  try {
    data.lastUpdated = new Date().toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
    return true;
  } catch (err) {
    log("dry_run_state", `Failed to write: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Generate a globally-unique VP ID using compact ISO 8601 UTC timestamp.
 * Format: `vp-YYYYMMDDTHHMMSSZ` (e.g., `vp-20260605T073141Z`).
 *
 * Why timestamp-based: the previous sequential scheme (`vp_NNN`) reused IDs
 * after close+deploy because `state.virtual_positions` only contains open
 * VPs (closed ones are moved to JSONL archive). Timestamps can't collide
 * and don't require a state scan. Old `vp_NNN` IDs from before this change
 * still work — `parseVirtualPositionAddress` is format-agnostic.
 */
function nextId(_state: VpState): string {
  // new Date().toISOString() → "2026-06-05T07:31:41.234Z"
  // Strip dashes, colons, and milliseconds; keep "YYYYMMDDTHHMMSSZ".
  return "vp-" + new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

// ─── Public API ───────────────────────────────────────────────────────────

export function trackVpPosition({
  pool,
  pool_name,
  pair,
  strategy,
  bins_below,
  lower_bin,
  upper_bin,
  active_bin,
  bin_step,
  amount_sol,
  initial_value_usd,
  sol_price_at_deploy,
  base_mint,
  bin_shares,
  signal_snapshot,
  volatility,
  fee_tvl_ratio,
  organic_score,
  deploy_gas_sol,
  close_gas_sol,
  gas_priority_fee,
  gas_cost_sol,
}: TrackVpPositionParams): string {
  const state = load();
  const vp: VpPosition = {
    id: nextId(state),
    pool,
    pool_name: pool_name || null,
    pair: pair || pool_name || String(pool).slice(0, 8),
    status: "open",
    deployed_at: new Date().toISOString(),
    closed_at: null,
    strategy: strategy || "spot",
    bins_below,
    lower_bin,
    upper_bin,
    active_bin_at_deploy: active_bin,
    bin_step,
    amount_sol,
    initial_value_usd,
    sol_price_at_deploy: sol_price_at_deploy ?? null,
    bin_shares: Array.isArray(bin_shares) && bin_shares.length ? bin_shares : null,
    base_mint: base_mint || null,
    volatility: volatility != null ? Number(volatility) : null,
    fee_tvl_ratio: fee_tvl_ratio != null ? fee_tvl_ratio : null,
    organic_score: organic_score != null ? organic_score : null,
    signal_snapshot: signal_snapshot && typeof signal_snapshot === "object" ? signal_snapshot : null,
    // Per-VP gas estimate (SOL) — deploy frozen at deploy time, close refreshed
    // on every PnL cycle. Falls back to config.management.vpGasCostSol.
    deploy_gas_sol: deploy_gas_sol != null ? Number(deploy_gas_sol) : null,
    close_gas_sol: close_gas_sol != null ? Number(close_gas_sol) : null,
    gas_priority_fee: gas_priority_fee != null ? Number(gas_priority_fee) : null,
    // Legacy: total gas estimate (used by VPs deployed under the previous
    // single-field version). computePositionPnl falls back to this when
    // deploy_gas_sol + close_gas_sol are absent.
    gas_cost_sol: gas_cost_sol != null ? Number(gas_cost_sol) : null,
    last_sync_at: null,
    // Step 7 (meridian-wie): _oor_since and _oor_minutes are still seeded.
    // The cycle reads _oor_since to determine OOR duration on subsequent
    // cycles (line 320 of manage-virtual.js). _oor_minutes is read by
    // recordVpDeployToPoolMemory in the close path. Both are KEPT.
    _oor_since: null,
    _oor_minutes: 0,
    _peak_pnl_pct: 0,
    _peak_pnl_sol_pct: 0,
    _trailing_active: false,
    _trailing_pending: false,
    _trailing_pending_since: null,
    snapshots: [],
    close_reason: null,
    close_pnl_usd: null,
    close_pnl_pct: null,
    last_claim_at: null,
    total_fees_claimed_usd: 0,
  };
  state.virtual_positions.push(vp);
  save(state);
  log("dry_run_state", `Tracked virtual position ${vp.id}: ${vp.pair}`);
  return vp.id;
}

export function listVpPositions(statusFilter?: string): VpPosition[] {
  const state = load();
  let list = state.virtual_positions;
  if (statusFilter) list = list.filter((p) => p.status === statusFilter);
  return list.map((p) => ({ ...p }));
}

export function getVpPosition(id: string): VpPosition | null {
  const state = load();
  const pos = state.virtual_positions.find((p) => p.id === id);
  return pos ? { ...pos } : null;
}

const UPDATE_PROTECTED = new Set([
  "id", "status", "closed_at", "close_reason", "close_pnl_pct", "close_pnl_usd",
  "close_pnl_sol_pct", "close_pnl_sol", "close_il_sol", "close_fees_sol",
  "close_cost_sol", "close_il_usd", "close_fees_usd", "close_cost_usd",
  // Step 7 (meridian-wie): these fields are no longer cached. PnL is
  // computed fresh on every read via computePositionPnl. Add them to
  // UPDATE_PROTECTED as defense-in-depth against accidental future
  // writes that would re-introduce the "stale cache" anti-pattern.
  "value_sol", "pnl_sol", "pnl_sol_pct",
  "total_fees_earned_sol", "total_fees_earned_usd",
  "current_value_usd",
  "_last_unclaimed_fees_usd", "_last_unclaimed_fees_sol",
]);

export function updateVpPosition(id: string, updates: Record<string, unknown>): boolean {
  const state = load();
  const idx = state.virtual_positions.findIndex((p) => p.id === id);
  if (idx === -1) return false;
  const pos = state.virtual_positions[idx];
  for (const key of Object.keys(updates)) {
    if (!UPDATE_PROTECTED.has(key)) pos[key] = updates[key];
  }
  save(state);
  return true;
}

export function recordVpClaim(id: string, fees_usd: number): boolean {
  const state = load();
  const idx = state.virtual_positions.findIndex((p) => p.id === id);
  if (idx === -1) return false;
  const vp = state.virtual_positions[idx];
  vp.last_claim_at = new Date().toISOString();
  vp.total_fees_claimed_usd = (vp.total_fees_claimed_usd || 0) + (fees_usd || 0);
  if (!vp.notes) vp.notes = [];
  vp.notes.push(`Claimed ~$${fees_usd.toFixed(2)} virtual fees at ${vp.last_claim_at}`);
  save(state);
  log("dry_run_state", `Virtual ${id} claimed ~$${fees_usd.toFixed(2)} fees`);
  return true;
}

const CLOSE_EXTRA_ALLOWED = new Set([
  "close_pnl_sol_pct", "close_pnl_sol", "close_il_sol", "close_fees_sol",
  "close_cost_sol", "close_il_usd", "close_fees_usd", "close_cost_usd",
]);

/**
 * Detect a virtual position address (prefixed with "vp:") and extract
 * the underlying VP id. Returns null if the address is not a VP.
 * Pure function — exported for testability.
 */
export function parseVirtualPositionAddress(positionAddress: string): string | null {
  if (typeof positionAddress !== "string" || !positionAddress.startsWith("vp:")) {
    return null;
  }
  return positionAddress.slice(3);
}

export function recordVpClose(
  id: string,
  reason: string,
  pnl_pct: number,
  pnl_usd: number,
  extra_fields: Record<string, unknown> = {}
): boolean {
  const state = load();
  const idx = state.virtual_positions.findIndex((p) => p.id === id);
  if (idx === -1) return false;
  const vp = state.virtual_positions[idx];
  vp.status = "closed";
  vp.closed_at = new Date().toISOString();
  vp.close_reason = reason;
  vp.close_pnl_pct = pnl_pct;
  vp.close_pnl_usd = pnl_usd;
  // Only copy whitelisted keys to prevent accidental overwrites
  for (const key of Object.keys(extra_fields)) {
    if (CLOSE_EXTRA_ALLOWED.has(key)) vp[key] = extra_fields[key];
  }
  // State-canonical close: save vp_state.json FIRST so the close is durable
  if (!save(state)) {
    log("dry_run_state", `Virtual ${id} close FAILED — vp_state.json write failed`);
    return false;
  }

  const archiveResult = appendArchiveRecordIfNew("paper", vp, vp.closed_at.slice(0, 7));
  if (archiveResult === null) {
    log("dry_run_state", `Virtual ${id} archive FAILED — durable in state, sweep will retry`);
  } else {
    const newIdx = state.virtual_positions.findIndex((p) => p.id === id);
    if (newIdx !== -1) {
      state.virtual_positions.splice(newIdx, 1);
      if (!save(state)) {
        log("dry_run_state", `Virtual ${id} splice save FAILED — VP lingers in state, sweep will retry`);
      }
    }
  }
  log("dry_run_state", `Virtual ${id} CLOSED: ${reason} PnL=${pnl_pct}%`);
  return true;
}

// ─── OOR Pure Functions ─────────────────────────────────────────────────────

/** Pure: determine if position is out of range. No disk I/O. */
export function isVpOutOfRange(activeBin: number, upperBin: number | null): boolean {
  if (upperBin == null) return false;
  return activeBin > upperBin;
}

/** Pure: transition position to OOR state. Idempotent — returns existing oorSince if already OOR. No disk I/O. */
export function markVpOutOfRange(
  activeBin: number,
  upperBin: number | null,
  currentOorSince: string | null,
): { oorSince: string | null; changed: boolean } {
  if (!isVpOutOfRange(activeBin, upperBin)) {
    return { oorSince: null, changed: currentOorSince !== null };
  }
  if (currentOorSince) {
    return { oorSince: currentOorSince, changed: false };
  }
  return { oorSince: new Date().toISOString(), changed: true };
}

/** Pure: transition position back in range. Idempotent — returns null if already in range. No disk I/O. */
export function markVpInRange(
  activeBin: number,
  upperBin: number | null,
  currentOorSince: string | null,
): { oorSince: null; changed: boolean } {
  if (isVpOutOfRange(activeBin, upperBin)) {
    return { oorSince: null, changed: false };
  }
  return { oorSince: null, changed: currentOorSince !== null };
}

/** Pure: compute minutes out of range from timestamp. No disk I/O. */
export function minutesVpOutOfRange(oorSince: string | null): number {
  if (!oorSince) return 0;
  const oorTs = new Date(oorSince).getTime();
  if (!Number.isFinite(oorTs)) return 0;
  const minutes = Math.floor((Date.now() - oorTs) / 60000);
  return Math.max(0, minutes);
}

// ─── Pure Trailing TP Helpers ────────────────────────────────────────────────

export function queueVpPeakConfirmation(
  trailingActive: boolean,
  peakPnl: number,
  triggerPct: number
): { trailingActive: boolean } {
  if (!trailingActive && peakPnl >= triggerPct) {
    return { trailingActive: true };
  }
  return { trailingActive };
}

export function queueVpTrailingDropConfirmation(
  trailingPending: boolean,
  peakPnl: number,
  currentPnl: number,
  dropPct: number,
  minPnl = 0
): { trailingPending: boolean; closeReason: string | null } {
  const dropFromPeak = peakPnl - currentPnl;
  if (dropFromPeak >= dropPct && currentPnl >= minPnl) {
    if (trailingPending) {
      return {
        trailingPending,
        closeReason: `trailing TP: peak ${peakPnl.toFixed(2)}% → current ${currentPnl.toFixed(2)}% (dropped ${dropFromPeak.toFixed(2)}% ≥ ${dropPct}%)`
      };
    } else {
      return { trailingPending: true, closeReason: null };
    }
  }
  return { trailingPending: false, closeReason: null };
}

export function updateVpPnlAndCheckExits(
  trailingActive: boolean,
  trailingPending: boolean,
  peakPnl: number,
  currentPnl: number,
  mgmtConfig: {
    trailingTakeProfit?: boolean;
    trailingTriggerPct?: number;
    trailingDropPct?: number;
  }
): { trailingActive: boolean; trailingPending: boolean; trailingCloseReason: string | null } {
  let active = trailingActive;
  let pending = trailingPending;
  let closeReason: string | null = null;

  if (mgmtConfig.trailingTakeProfit) {
    const triggerPct = mgmtConfig.trailingTriggerPct ?? 6;
    const resPeak = queueVpPeakConfirmation(active, peakPnl, triggerPct);
    active = resPeak.trailingActive;

    if (active) {
      const dropPct = mgmtConfig.trailingDropPct ?? 2.5;
      const resDrop = queueVpTrailingDropConfirmation(pending, peakPnl, currentPnl, dropPct, 0);
      pending = resDrop.trailingPending;
      closeReason = resDrop.closeReason;
    }
  }

  return { trailingActive: active, trailingPending: pending, trailingCloseReason: closeReason };
}

export function archiveVpPositions(): { swept: number; failed: number; duplicatesRemoved: number } {
  const state = load();
  if (state.virtual_positions.length === 0 && !fs.existsSync(ARCHIVE_DIR)) {
    return { swept: 0, failed: 0, duplicatesRemoved: 0 };
  }

  let swept = 0;
  let failed = 0;
  if (state.virtual_positions.length > 0) {
    const remaining: VpPosition[] = [];
    for (const vp of state.virtual_positions) {
      if (vp.status === "closed" && vp.closed_at) {
        const month = vp.closed_at.slice(0, 7);
        const result = appendArchiveRecordIfNew("paper", vp, month);
        if (result === null) {
          remaining.push(vp);
          failed++;
        } else {
          swept++;
        }
      } else {
        remaining.push(vp);
      }
    }
    if (swept > 0 || failed > 0) {
      state.virtual_positions = remaining;
      if (!save(state)) {
        log("dry_run_state", `Reconcile save FAILED — ${remaining.length} VPs linger in state, sweep will retry`);
      }
    }
  }

  const duplicatesRemoved = dedupeAllArchives("paper");

  if (swept > 0 || failed > 0 || duplicatesRemoved > 0) {
    log("dry_run_state", `Reconcile: swept=${swept} failed=${failed} duplicatesRemoved=${duplicatesRemoved}`);
  }
  return { swept, failed, duplicatesRemoved };
}
