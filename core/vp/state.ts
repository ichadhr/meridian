import fs from "fs";
import { log } from "../../utils/logger.js";
import {
  appendArchiveRecordIfNew,
  dedupeAllArchives,
  ARCHIVE_DIR,
} from "../archive.js";
const STATE_FILE = "./dry-run-state.json";

// ─── Types ────────────────────────────────────────────────────────────────

export interface DryRunState {
  virtual_positions: DryRunVirtualPosition[];
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

export interface DryRunVirtualPosition {
  id: string;
  pool: string;
  pool_name: string | null;
  pair: string;
  status: "open" | "closed";
  deployed_at: string | null;
  closed_at: string | null;
  strategy: string;
  bins_below: number;
  lower_bin: number;
  upper_bin: number;
  active_bin_at_deploy: number;
  bin_step: number;
  amount_sol: number;
  initial_value_usd: number;
  sol_price_at_deploy: number | null;
  bin_shares: BinShareEntry[] | null;
  base_mint: string | null;
  volatility: number | null;
  fee_tvl_ratio: unknown;
  organic_score: unknown;
  signal_snapshot: Record<string, unknown> | null;
  deploy_gas_sol: number | null;
  close_gas_sol: number | null;
  gas_priority_fee: number | null;
  gas_cost_sol: number | null;
  last_sync_at: string | null;
  _oor_since: string | null;
  _oor_minutes: number;
  _peak_pnl_pct: number;
  _peak_pnl_sol_pct: number;
  _trailing_active: boolean;
  _trailing_pending: boolean;
  _trailing_pending_since: string | null;
  snapshots: Array<Record<string, unknown>>;
  close_reason: string | null;
  close_pnl_usd: number | null;
  close_pnl_pct: number | null;
  [key: string]: unknown;
}

/** Parameters accepted by trackVirtualPosition. */
export interface TrackVirtualPositionParams {
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
  // signal_snapshot field on live positions in state.json — numeric scores
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

function load(): DryRunState {
  if (!fs.existsSync(STATE_FILE)) {
    return { virtual_positions: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as DryRunState;
  } catch (err) {
    log("dry_run_state", `Failed to read: ${(err as Error).message}`);
    return { virtual_positions: [] };
  }
}

/** Persist state. Returns true on success, false on error. */
function save(data: DryRunState): boolean {
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
function nextId(_state: DryRunState): string {
  // new Date().toISOString() → "2026-06-05T07:31:41.234Z"
  // Strip dashes, colons, and milliseconds; keep "YYYYMMDDTHHMMSSZ".
  return "vp-" + new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

// ─── Public API ───────────────────────────────────────────────────────────

export function trackVirtualPosition({
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
  /**
   * @type {{ binId: number, shares: string, price: string|null, feeXPerTokenComplete: string|null, feeYPerTokenComplete: string|null, xAmount: string|null, yAmount: string|null }[]}
   * Per-bin LP position at deploy time. All numeric fields stored as BN strings for JSON safety.
   * - shares: virtual LP tokens attributed to this position in the bin
   * - price: bin price in Q64.64 format (for liquidity math verification)
   * - fee{X,Y}PerTokenComplete: stored fee accumulators at deploy (for delta-based fee calc)
   * - xAmount, yAmount: bin's total token amounts at deploy time (for debugging/verification)
   */
  bin_shares,
  // Structured screener signals captured at deploy time. Mirrors the
  // signal_snapshot field on live positions in state.json — numeric scores
  // + booleans (organic_score, fee_tvl_ratio, volatility, etc.) used for
  // retro-analysis and Darwin weight tuning. null if Darwin is disabled or
  // no signals were staged for this pool/mint.
  signal_snapshot,
  // Screening metadata — used by Virtual Digest for pattern analysis
  volatility,
  fee_tvl_ratio,
  organic_score,
  // Real-time gas estimate — deploy gas is frozen at deploy time, close gas
  // is refreshed on every PnL cycle and re-estimated at close with a fresh
  // priority fee sample.
  deploy_gas_sol,
  close_gas_sol,
  gas_priority_fee, // priority fee (µl/CU) at deploy time, for reference
  gas_cost_sol,     // legacy: kept for back-compat with VPs deployed under prev. version
  // Note: Step 7 (meridian-wie) removed seeding of value_sol, pnl_sol,
  // pnl_sol_pct, total_fees_earned_sol, total_fees_earned_usd, and
  // current_value_usd. These are now computed fresh on every PnL cycle
  // via computePositionPnl. The fields are no longer cached in VP state.
  //
  // TODO(meridian-wie post-Step-7): the 5 pre-Step-7 VPs on the server
  // (vp_006, vp_007, vp_009, vp_011, vp_014) still carry these legacy
  // fields in dry-run-state.json. They are no longer read or written —
  // they are "dead data" that will drain naturally as VPs close. When
  // all 5 close, sweep and remove this TODO. See also the matching
  // TODO in tools/merge-virtual-positions.js.
}: TrackVirtualPositionParams): string {
  const state = load();
  const vp: DryRunVirtualPosition = {
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
  };
  state.virtual_positions.push(vp);
  save(state);
  log("dry_run_state", `Tracked virtual position ${vp.id}: ${vp.pair}`);
  return vp.id;
}

export function listVirtualPositions(statusFilter?: string): DryRunVirtualPosition[] {
  const state = load();
  let list = state.virtual_positions;
  if (statusFilter) list = list.filter((p) => p.status === statusFilter);
  return list.map((p) => ({ ...p }));
}

export function getVirtualPosition(id: string): DryRunVirtualPosition | null {
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

export function updateVirtualPosition(id: string, updates: Record<string, unknown>): boolean {
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

export function closeVirtualPosition(
  id: string,
  reason: string,
  pnlPct: number,
  pnlUsd: number,
  extraFields: Record<string, unknown> = {}
): boolean {
  const state = load();
  const idx = state.virtual_positions.findIndex((p) => p.id === id);
  if (idx === -1) return false;
  const vp = state.virtual_positions[idx];
  vp.status = "closed";
  vp.closed_at = new Date().toISOString();
  vp.close_reason = reason;
  vp.close_pnl_pct = pnlPct;
  vp.close_pnl_usd = pnlUsd;
  // Only copy whitelisted keys to prevent accidental overwrites
  for (const key of Object.keys(extraFields)) {
    if (CLOSE_EXTRA_ALLOWED.has(key)) vp[key] = extraFields[key];
  }
  // State-canonical close: save dry-run-state.json FIRST so the close is durable
  // even if the archive write fails. The archive is a derived view; the sweeper
  // will retry on the next call. Old order (archive → splice → save) lost the
  // close on archive failure and duplicated on crash between archive and save.
  if (!save(state)) {
    log("dry_run_state", `Virtual ${id} close FAILED — dry-run-state.json write failed`);
    return false;
  }

  // Now attempt idempotent archive move. Returns true (appended), false
  // (already existed — replay/crash recovery), or null (write error).
  // Pass the month derived from closed_at so a close at 23:59:31 Jan 31
  // lands in vp-archive-2026-01.jsonl, not the current month file
  // (which would create cross-month duplicates on a late sweeper run).
  const archiveResult = appendArchiveRecordIfNew("paper", vp, vp.closed_at.slice(0, 7));
  if (archiveResult === null) {
    // Archive write failed but the close is durable in dry-run-state.json.
    // Leave the closed VP in state — next sweep will retry the archive move.
    log("dry_run_state", `Virtual ${id} archive FAILED — durable in state, sweep will retry`);
  } else {
    // Archive succeeded (new or already-existed): splice from state.
    const newIdx = state.virtual_positions.findIndex((p) => p.id === id);
    if (newIdx !== -1) {
      state.virtual_positions.splice(newIdx, 1);
      if (!save(state)) {
        // Splice save failed — VP is durable in archive but lingers in state.
        // Next sweep will re-archive (idempotent skip) and retry the splice.
        // Don't return false: the close IS durable, just untidy.
        log("dry_run_state", `Virtual ${id} splice save FAILED — VP lingers in state, sweep will retry`);
      }
    }
  }
  log("dry_run_state", `Virtual ${id} CLOSED: ${reason} PnL=${pnlPct}%`);
  return true;
}

/**
 * Reconcile dry-run-state.json with the JSONL archive:
 *   1. Move any status="closed" VPs from state to archive (idempotent append)
 *   2. Deduplicate the current-month archive (removes legacy duplicates from
 *      the pre-state-canonical era — see meridian-9jf for context)
 *
 * Safe to call on every report generation. Returns counts for logging.
 */
export function archiveVirtualPositions(): { swept: number; failed: number; duplicatesRemoved: number } {
  const state = load();
  if (state.virtual_positions.length === 0 && !fs.existsSync(ARCHIVE_DIR)) {
    return { swept: 0, failed: 0, duplicatesRemoved: 0 };
  }

  let swept = 0;
  let failed = 0;
  if (state.virtual_positions.length > 0) {
    const remaining: DryRunVirtualPosition[] = [];
    for (const vp of state.virtual_positions) {
      if (vp.status === "closed" && vp.closed_at) {
        // Use closed_at month so cross-month closes (23:59:31 Jan 31 etc.)
        // write to the correct archive file.
        const month = vp.closed_at.slice(0, 7);
        const result = appendArchiveRecordIfNew("paper", vp, month);
        if (result === null) {
          // Error — keep for next sweep
          remaining.push(vp);
          failed++;
        } else {
          swept++;
          // Either appended or already existed — safe to splice
        }
      } else {
        remaining.push(vp);
      }
    }
    if (swept > 0 || failed > 0) {
      state.virtual_positions = remaining;
      if (!save(state)) {
        // Sweep save failed — VPs are durable in archive but linger in state.
        // Next sweep will re-archive (idempotent skip) and retry the splice.
        log("dry_run_state", `Reconcile save FAILED — ${remaining.length} VPs linger in state, sweep will retry`);
      }
    }
  }

  // Deduplicate ALL archive months for paper source (legacy cleanup from
  // pre-state-canonical era; cheap at our scale).
  const duplicatesRemoved = dedupeAllArchives("paper");

  if (swept > 0 || failed > 0 || duplicatesRemoved > 0) {
    log("dry_run_state", `Reconcile: swept=${swept} failed=${failed} duplicatesRemoved=${duplicatesRemoved}`);
  }
  return { swept, failed, duplicatesRemoved };
}
