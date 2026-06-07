// utils/logger.ts — Shared logger with daily file rotation
import fs from "fs";
import path from "path";
import type { LogLevel, ToolAction } from "../types/index.js";

const LOG_DIR = "./logs";
const LOG_LEVEL: string = process.env.LOG_LEVEL || "info";

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel: number = LEVELS[LOG_LEVEL as LogLevel] ?? 1;

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * General log function.
 */
export function log(category: string, message: string): void {
  const level: LogLevel = category.includes("error") ? "error"
    : category.includes("warn") ? "warn"
    : "info";

  if (LEVELS[level] < currentLevel) return;

  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${category.toUpperCase()}] ${message}`;

  // Console output
  console.log(line);

  // File output (daily rotation)
  const dateStr = timestamp.split("T")[0];
  const logFile = path.join(LOG_DIR, `agent-${dateStr}.log`);
  fs.appendFileSync(logFile, line + "\n");
}

/**
 * Log a tool action with full details (for audit trail).
 */
function actionHint(action: ToolAction): string {
  const a = action.args as Record<string, unknown> ?? {};
  const r = action.result as Record<string, unknown> ?? {};
  switch (action.tool) {
    case "deploy_position":   return ` ${a.pool_name ?? String(a.pool_address ?? "").slice(0,8)} ${a.amount_y ?? a.amount_sol} SOL`;
    case "close_position":    return ` ${String(a.position_address ?? "").slice(0,8)}${r.pnl_usd != null ? ` | PnL $${Number(r.pnl_usd) >= 0 ? "+" : ""}${r.pnl_usd} (${r.pnl_pct}%)` : ""}`;
    case "claim_fees":        return ` ${String(a.position_address ?? "").slice(0,8)}`;
    case "get_active_bin":    return ` bin ${r.binId ?? ""}`;
    case "get_pool_detail":   return ` ${r.name || String(a.pool_address ?? "").slice(0,8) || ""}`;
    case "get_my_positions":  return ` ${r.total_positions ?? ""} positions`;
    case "get_wallet_balance":return ` ${r.sol ?? ""} SOL`;
    case "get_top_candidates":return ` ${(r.candidates as unknown[])?.length ?? ""} pools`;
    case "swap_token":        return ` ${a.amount} ${String(a.input_mint ?? "").slice(0,6)}→SOL`;
    case "update_config":     return ` ${Object.keys((r.applied as Record<string, unknown>) ?? {}).join(", ")}`;
    case "add_lesson":        return ` saved`;
    case "clear_lessons":     return ` cleared ${r.cleared ?? ""}`;
    default:                  return "";
  }
}

export function logAction(action: ToolAction): void {
  const timestamp = new Date().toISOString();

  const entry = { timestamp, ...action };

  // Console: single clean line, no raw JSON
  const status = action.success ? "✓" : "✗";
  const dur = action.duration_ms != null ? ` (${action.duration_ms}ms)` : "";
  const hint = actionHint(action);
  console.log(`[${action.tool}] ${status}${hint}${dur}`);

  // File: full JSON for audit trail
  const dateStr = timestamp.split("T")[0];
  const actionsFile = path.join(LOG_DIR, `actions-${dateStr}.jsonl`);
  fs.appendFileSync(actionsFile, JSON.stringify(entry) + "\n");
}
