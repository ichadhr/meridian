import fs from "fs";
import { log } from "../logger.js";
import { appendArchiveRecord } from "./position-archive.js";

const STATE_FILE = "./dry-run-state.json";

function load() {
  if (!fs.existsSync(STATE_FILE)) {
    return { virtual_positions: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (err) {
    log("dry_run_state", `Failed to read: ${err.message}`);
    return { virtual_positions: [] };
  }
}

function save(data) {
  try {
    data.lastUpdated = new Date().toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    log("dry_run_state", `Failed to write: ${err.message}`);
  }
}

function nextId(state) {
  const maxN = state.virtual_positions.reduce((m, p) => {
    const match = p.id && p.id.match(/^vp_(\d+)$/);
    return match ? Math.max(m, parseInt(match[1])) : m;
  }, 0);
  return `vp_${String(maxN + 1).padStart(3, "0")}`;
}

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
  deploy_rationale,
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
  // Native SOL fields — seeded at deploy time with sensible defaults so the
  // management cycle (and the polymorphic _usd display) can read them from
  // cycle 1. The management cycle overwrites these on every PnL sync.
  value_sol = amount_sol ?? 0,
  total_fees_earned_sol = 0,
  pnl_sol = 0,
  pnl_sol_pct = 0,
}) {
  const state = load();
  const vp = {
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
    // Seed native SOL fields at deploy time (overwritten by management cycle).
    value_sol,
    total_fees_earned_sol,
    pnl_sol,
    pnl_sol_pct,
    deploy_rationale: deploy_rationale || null,
    bin_shares: Array.isArray(bin_shares) && bin_shares.length ? bin_shares : null,
    base_mint: base_mint || null,
    volatility: volatility != null ? Number(volatility) : null,
    fee_tvl_ratio: fee_tvl_ratio != null ? fee_tvl_ratio : null,
    organic_score: organic_score != null ? organic_score : null,
    // Per-VP gas estimate (SOL) — deploy frozen at deploy time, close refreshed
    // on every PnL cycle. Falls back to config.management.vpGasCostSol.
    deploy_gas_sol: deploy_gas_sol != null ? Number(deploy_gas_sol) : null,
    close_gas_sol: close_gas_sol != null ? Number(close_gas_sol) : null,
    gas_priority_fee: gas_priority_fee != null ? Number(gas_priority_fee) : null,
    // Legacy: total gas estimate (used by VPs deployed under the previous
    // single-field version). computeVirtualPnl falls back to this when
    // deploy_gas_sol + close_gas_sol are absent.
    gas_cost_sol: gas_cost_sol != null ? Number(gas_cost_sol) : null,
    total_fees_earned_usd: 0,
    current_value_usd: initial_value_usd,
    last_sync_at: null,
    _oor_since: null,
    _oor_minutes: 0,
    _peak_pnl_pct: 0,
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

export function listVirtualPositions(statusFilter) {
  const state = load();
  let list = state.virtual_positions;
  if (statusFilter) list = list.filter((p) => p.status === statusFilter);
  return list.map((p) => ({ ...p }));
}

export function getVirtualPosition(id) {
  const state = load();
  const pos = state.virtual_positions.find((p) => p.id === id);
  return pos ? { ...pos } : null;
}

const UPDATE_PROTECTED = new Set([
  "id", "status", "closed_at", "close_reason", "close_pnl_pct", "close_pnl_usd",
  "close_pnl_sol_pct", "close_pnl_sol", "close_il_sol", "close_fees_sol",
  "close_cost_sol", "close_il_usd", "close_fees_usd", "close_cost_usd",
]);

export function updateVirtualPosition(id, updates) {
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
 * Compute simple position PnL for a virtual position from its stored fields.
 * Used by manual close paths (e.g. Telegram /close) where a fresh bin fetch
 * would be overkill. Falls back to nulls when data is missing.
 * Pure function — exported for testability.
 */
export function computeSimpleVirtualPnl(vp) {
  const initialValue = vp?.initial_value_usd;
  const currentValue = vp?.current_value_usd ?? initialValue;
  const pnlUsd = (currentValue != null && initialValue != null)
    ? currentValue - initialValue
    : null;
  const pnlPct = (currentValue != null && initialValue != null && initialValue > 0)
    ? ((currentValue / initialValue - 1) * 100)
    : null;
  return { pnlUsd, pnlPct };
}

/**
 * Detect a virtual position address (prefixed with "vp:") and extract
 * the underlying VP id. Returns null if the address is not a VP.
 * Pure function — exported for testability.
 */
export function parseVirtualPositionAddress(positionAddress) {
  if (typeof positionAddress !== "string" || !positionAddress.startsWith("vp:")) {
    return null;
  }
  return positionAddress.slice(3);
}

export function closeVirtualPosition(id, reason, pnlPct, pnlUsd, extraFields = {}) {
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
  // Move closed position to JSONL archive and remove from active state
  if (!appendArchiveRecord("paper", vp)) {
    log("dry_run_state", `Virtual ${id} close ABORTED — archive write failed`);
    return false;
  }
  state.virtual_positions.splice(idx, 1);
  save(state);
  log("dry_run_state", `Virtual ${id} CLOSED: ${reason} PnL=${pnlPct}%`);
  return true;
}

export function archiveVirtualPositions() {
  const state = load();
  if (state.virtual_positions.length === 0) return;
  const remaining = [];
  let archived = 0;
  for (const vp of state.virtual_positions) {
    if (vp.status === "closed" && vp.closed_at) {
      appendArchiveRecord("paper", vp);
      archived++;
    } else {
      remaining.push(vp);
    }
  }
  state.virtual_positions = remaining;
  save(state);
  log("dry_run_state", `Archived ${archived} virtual positions, kept ${remaining.length} open`);
}
