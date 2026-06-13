const ROOT = process.env.MERIDIAN_ROOT || ".";

// ── State files ───────────────────────────────────────────────────────────
export const LIVE_STATE_FILE = `${ROOT}/live_state.json`;
export const VP_STATE_FILE   = `${ROOT}/vp_state.json`;

// ── Data files ────────────────────────────────────────────────────────────
export const LESSONS_FILE         = `${ROOT}/lessons.json`;
export const POOL_MEMORY_FILE     = `${ROOT}/pool-memory.json`;
export const TOKEN_BLACKLIST_FILE = `${ROOT}/token-blacklist.json`;
export const DEV_BLOCKLIST_FILE   = `${ROOT}/dev-blocklist.json`;
export const STRATEGY_FILE        = `${ROOT}/strategy-library.json`;
export const SIGNAL_WEIGHTS_FILE  = `${ROOT}/signal-weights.json`;
export const USER_CONFIG_FILE     = `${ROOT}/user-config.json`;
export const DECISION_LOG_FILE    = `${ROOT}/decision-log.json`;
export const SMART_WALLETS_FILE   = `${ROOT}/smart-wallets.json`;

// ── Archive ───────────────────────────────────────────────────────────────
export const ARCHIVE_DIR = `${ROOT}/archives`;

export function archivePath(source: string, month: string): string {
  const prefix = source === "paper" ? "vp" : "live";
  return `${ARCHIVE_DIR}/${prefix}-archive-${month}.jsonl`;
}
