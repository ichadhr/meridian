import fs from "fs";
import { log } from "../logger.js";

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
  sol_price,
  fee_per_tvl_24h,
  initial_value_usd,
  deploy_rationale,
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
    sol_price_at_deploy: sol_price,
    fee_per_tvl_24h_at_deploy: fee_per_tvl_24h ?? null,
    fee_per_tvl_24h: fee_per_tvl_24h ?? null,
    initial_value_usd,
    deploy_rationale: deploy_rationale || null,
    total_fees_earned_usd: 0,
    current_value_usd: initial_value_usd,
    last_sync_at: null,
    _oor_since: null,
    _oor_minutes: 0,
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

export function updateVirtualPosition(id, updates) {
  const state = load();
  const idx = state.virtual_positions.findIndex((p) => p.id === id);
  if (idx === -1) return false;
  Object.assign(state.virtual_positions[idx], updates);
  save(state);
  return true;
}

export function closeVirtualPosition(id, reason, pnlPct, pnlUsd) {
  const state = load();
  const idx = state.virtual_positions.findIndex((p) => p.id === id);
  if (idx === -1) return false;
  const vp = state.virtual_positions[idx];
  vp.status = "closed";
  vp.closed_at = new Date().toISOString();
  vp.close_reason = reason;
  vp.close_pnl_pct = pnlPct;
  vp.close_pnl_usd = pnlUsd;
  save(state);
  log("dry_run_state", `Virtual ${id} CLOSED: ${reason} PnL=${pnlPct}%`);
  return true;
}

export function archiveVirtualPositions() {
  const state = load();
  if (state.virtual_positions.length === 0) return;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const archiveFile = `./dry-run-state-archive-${ts}.json`;
  const archive = { archived_at: ts.replace(/T/, " ").slice(0, 19), virtual_positions: state.virtual_positions };
  try {
    fs.writeFileSync(archiveFile, JSON.stringify(archive, null, 2));
    state.virtual_positions = [];
    save(state);
    log("dry_run_state", `Archived ${archive.virtual_positions.length} virtual positions to ${archiveFile}`);
  } catch (err) {
    log("dry_run_state", `Failed to archive: ${err.message}`);
  }
}
