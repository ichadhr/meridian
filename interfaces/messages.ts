/**
 * Platform-agnostic message formatters.
 *
 * All functions return markdown text (**bold**, `code`).
 * Platform adapters (Telegram, Slack, Discord) convert to their native format.
 *
 * Rules:
 * - No imports from config/ — all context comes via parameters.
 * - escapeMarkdown() dynamic values before wrapping in bold/code.
 * - Supported subset: **bold**, *italic*, `code`, newlines.
 */

import type { LivePosition, Config } from "../types/index.js";

// ── Helpers ──────────────────────────────────────────────────────

/** Currency symbol based on solMode. */
export function cur(solMode: boolean): string {
  return solMode ? "◎" : "$";
}

/** Format a number as percentage. */
export function fmtPct(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : "?";
}

/** Escape markdown special characters in dynamic values. */
export function escapeMarkdown(s: string): string {
  return s.replace(/[*_`]/g, "\\$&");
}

// ── Command Responses ────────────────────────────────────────────

export function formatHelpText(): string {
  return [
    "Telegram commands",
    "",
    "/help — show commands",
    "/status — wallet + positions snapshot",
    "/wallet — wallet, deploy amount, HiveMind status",
    "/positions — list open positions",
    "/vp — list virtual (dry-run) positions",
    "/vp report — generate dry-run HTML report",
    "/pool <n> — detailed info for one open position",
    "/close <n> — close one position by index",
    "/closeall — close all open positions",
    "/set <n> <note> — set note/instruction on position",
    "/config — show important runtime config",
    "/settings — button menu for common config",
    "/setcfg <key> <value> — update persisted config",
    "/screen — refresh deterministic candidate list",
    "/candidates — show latest cached candidates",
    "/deploy <n> — deploy candidate by cached index",
    "/briefing — morning briefing",
    "/hive — HiveMind sync status",
    "/hive pull — manual HiveMind pull now",
    "/pause — stop cron cycles",
    "/resume — start cron cycles again",
    "/stop — shut down agent",
  ].join("\n");
}

export function formatWalletStatus(
  wallet: { sol: number; sol_usd: number; sol_price: number },
  positions: { total_positions: number },
  opts: { solMode: boolean; maxPositions: number; deployAmount: number; dryRun: boolean; hiveEnabled: boolean },
): string {
  return [
    `Wallet: ${wallet.sol} SOL ($ ${wallet.sol_usd})`,
    `SOL price: $ ${wallet.sol_price}`,
    `Open positions: ${positions.total_positions}/${opts.maxPositions}`,
    `Next deploy amount: ${opts.deployAmount} SOL`,
    `Dry run: ${opts.dryRun ? "yes" : "no"}`,
    `HiveMind: ${opts.hiveEnabled ? "on" : "off"}`,
  ].join("\n");
}

export interface ConfigSnapshotInput {
  strategy: string;
  minBinsBelow: number;
  maxBinsBelow: number;
  defaultBinsBelow: number;
  deployAmountSol: number;
  gasReserve: number;
  maxPositions: number;
  stopLossPct: number;
  takeProfitPct: number;
  trailingTakeProfit: boolean;
  trailingTriggerPct: number;
  trailingDropPct: number;
  outOfRangeWaitMinutes: number;
  oorCooldownTriggerCount: number;
  oorCooldownHours: number;
  repeatDeployCooldownEnabled: boolean;
  repeatDeployCooldownTriggerCount: number;
  repeatDeployCooldownHours: number;
  repeatDeployCooldownMinFeeEarnedPct: number;
  repeatDeployCooldownScope: string;
  minFeePerTvl24h: number;
  minAgeBeforeYieldCheck: number;
  screeningCategory: string;
  screeningTimeframe: string;
  minTvl: number;
  maxTvl: number;
  managementIntervalMin: number;
  screeningIntervalMin: number;
  hiveEnabled: boolean;
  agentId?: string | null;
}

/** Build ConfigSnapshotInput from the runtime Config object. */
export function buildConfigSnapshotInput(config: Config, hiveEnabled: boolean): ConfigSnapshotInput {
  return {
    strategy: config.strategy.strategy,
    minBinsBelow: config.strategy.minBinsBelow,
    maxBinsBelow: config.strategy.maxBinsBelow,
    defaultBinsBelow: config.strategy.defaultBinsBelow,
    deployAmountSol: config.management.deployAmountSol,
    gasReserve: config.management.gasReserve,
    maxPositions: config.risk.maxPositions,
    stopLossPct: config.management.stopLossPct,
    takeProfitPct: config.management.takeProfitPct,
    trailingTakeProfit: config.management.trailingTakeProfit,
    trailingTriggerPct: config.management.trailingTriggerPct,
    trailingDropPct: config.management.trailingDropPct,
    outOfRangeWaitMinutes: config.management.outOfRangeWaitMinutes,
    oorCooldownTriggerCount: config.management.oorCooldownTriggerCount,
    oorCooldownHours: config.management.oorCooldownHours,
    repeatDeployCooldownEnabled: config.management.repeatDeployCooldownEnabled,
    repeatDeployCooldownTriggerCount: config.management.repeatDeployCooldownTriggerCount,
    repeatDeployCooldownHours: config.management.repeatDeployCooldownHours,
    repeatDeployCooldownMinFeeEarnedPct: config.management.repeatDeployCooldownMinFeeEarnedPct,
    repeatDeployCooldownScope: config.management.repeatDeployCooldownScope,
    minFeePerTvl24h: config.management.minFeePerTvl24h,
    minAgeBeforeYieldCheck: config.management.minAgeBeforeYieldCheck,
    screeningCategory: config.screening.category,
    screeningTimeframe: config.screening.timeframe,
    minTvl: config.screening.minTvl,
    maxTvl: config.screening.maxTvl,
    managementIntervalMin: config.schedule.managementIntervalMin,
    screeningIntervalMin: config.schedule.screeningIntervalMin,
    hiveEnabled,
    agentId: config.hiveMind.agentId,
  };
}

export function formatConfigSnapshot(cfg: ConfigSnapshotInput): string {
  return [
    "Config snapshot",
    "",
    `Strategy: ${cfg.strategy} | binsBelow: ${cfg.minBinsBelow}-${cfg.maxBinsBelow} | default ${cfg.defaultBinsBelow}`,
    `Deploy: ${cfg.deployAmountSol} SOL | gasReserve: ${cfg.gasReserve} | maxPositions: ${cfg.maxPositions}`,
    `Stop loss: ${cfg.stopLossPct}% | take profit: ${cfg.takeProfitPct}%`,
    `Trailing: ${cfg.trailingTakeProfit ? "on" : "off"} | trigger ${cfg.trailingTriggerPct}% | drop ${cfg.trailingDropPct}%`,
    `OOR: ${cfg.outOfRangeWaitMinutes}m | cooldown ${cfg.oorCooldownTriggerCount}x / ${cfg.oorCooldownHours}h`,
    `Repeat deploy cooldown: ${cfg.repeatDeployCooldownEnabled ? "on" : "off"} | ${cfg.repeatDeployCooldownTriggerCount}x / ${cfg.repeatDeployCooldownHours}h | min fee earned ${cfg.repeatDeployCooldownMinFeeEarnedPct}% | ${cfg.repeatDeployCooldownScope}`,
    `Yield floor: ${cfg.minFeePerTvl24h}% | min age ${cfg.minAgeBeforeYieldCheck}m`,
    `Screening: ${cfg.screeningCategory} / ${cfg.screeningTimeframe} | TVL ${cfg.minTvl}-${cfg.maxTvl}`,
    `Intervals: manage ${cfg.managementIntervalMin}m | screen ${cfg.screeningIntervalMin}m`,
    `HiveMind: ${cfg.hiveEnabled ? "enabled" : "disabled"}${cfg.agentId ? ` | ${cfg.agentId}` : ""}`,
  ].join("\n");
}

export function formatPositions(
  positions: LivePosition[],
  total: number,
  solMode: boolean,
): string {
  if (total === 0) return "No open positions.";
  const c = cur(solMode);
  const lines = positions.map((p, i) => {
    const pnlUsd = p.pnl_usd ?? 0;
    const pnl = pnlUsd >= 0 ? `+${c} ${pnlUsd}` : `-${c} ${Math.abs(pnlUsd)}`;
    const age = p.age_minutes != null ? `${p.age_minutes}m` : "?";
    const oor = p.in_range === false ? " 🔴 OOR" : p.in_range === true ? " 🟢 IN" : " ??";
    return `${i + 1}. ${escapeMarkdown(p.pair)} | ${c} ${p.total_value_usd} | PnL: ${pnl} | fees: ${c} ${p.unclaimed_fees_usd} | ${age}${oor}`;
  });
  return `📊 Open Positions (${total}):\n\n${lines.join("\n")}\n\n/close <n> to close | /set <n> <note> to set instruction`;
}

export function formatPositionDetail(pos: LivePosition, idx: number, solMode: boolean): string {
  const c = cur(solMode);
  return [
    `${idx + 1}. ${escapeMarkdown(pos.pair)}`,
    `Pool: ${pos.pool}`,
    `Position: ${pos.position}`,
    `Range: ${pos.lower_bin} → ${pos.upper_bin} | active ${pos.active_bin}`,
    `PnL: ${pos.pnl_pct ?? "?"}% | fees: ${c} ${pos.unclaimed_fees_usd ?? "?"}`,
    `Value: ${c} ${pos.total_value_usd ?? "?"}`,
    `Age: ${pos.age_minutes ?? "?"}m | ${pos.in_range === true ? "🟢 IN RANGE" : pos.in_range === false ? `🔴 OOR ${pos.minutes_out_of_range ?? 0}m` : "?? (no fresh PnL)"}`,
    pos.instruction ? `Note: ${escapeMarkdown(pos.instruction)}` : null,
  ].filter(Boolean).join("\n");
}

export function formatVirtualPositions(vps: LivePosition[], solMode: boolean): string {
  if (vps.length === 0) return "No open virtual positions.";
  const c = cur(solMode);
  const lines = vps.map((pos, i) => {
    const vpId = pos.position.slice(3); // strip "vp:" prefix
    const pnl = pos.pnl_pct != null ? `${pos.pnl_pct.toFixed(2)}%` : "?";
    const fees = pos.unclaimed_fees_usd != null ? `${c} ${pos.unclaimed_fees_usd.toFixed(2)}` : "?";
    const oor = pos.in_range === true ? "🟢 IN" : pos.in_range === false ? "🔴 OOR" : "??";
    return `${i + 1}. ${escapeMarkdown(pos.pair)} ${oor}\n   PnL: ${pnl} | fees ${fees}\n   ID: ${vpId}`;
  });
  return `📊 Virtual Positions (${vps.length}):\n\n${lines.join("\n\n")}`;
}

export function formatCloseResult(
  pos: LivePosition,
  result: { success: boolean; is_virtual?: boolean; pnl_pct?: number; pnl_usd?: number; close_txs?: string[]; txs?: string[]; claim_txs?: string[]; error?: string },
  solMode: boolean,
): string {
  const c = cur(solMode);
  if (!result.success) {
    return `❌ Close failed: ${escapeMarkdown(pos.pair)}\n\n${result.error || "unknown error"}`;
  }
  if (result.is_virtual) {
    return `✅ Closed VP ${escapeMarkdown(pos.pair)}\n\nPnL: ${result.pnl_pct?.toFixed(2) ?? "?"}% | ${c}${result.pnl_usd?.toFixed(4) ?? "?"}`;
  }
  const closeTxs = result.close_txs?.length ? result.close_txs : result.txs;
  const txLine = closeTxs?.length ? `\nTx: ${closeTxs.join(", ")}` : "";
  const claimLine = result.claim_txs?.length ? `\nClaim: ${result.claim_txs.join(", ")}` : "";
  return `✅ Closed ${escapeMarkdown(pos.pair)}\n\nPnL: ${c} ${result.pnl_usd ?? "?"}${txLine}${claimLine}`;
}

export function formatCloseAllResult(
  results: Array<{ pair: string; success: boolean; pnl_pct?: number; error?: string; is_virtual?: boolean }>,
): string {
  const lines = results.map((r) => {
    const tag = r.is_virtual ? " (VP)" : "";
    if (r.success) {
      const pnl = r.pnl_pct != null ? ` PnL ${r.pnl_pct.toFixed(2)}%` : "";
      return `${escapeMarkdown(r.pair)}${tag}: closed${pnl}`;
    }
    return `${escapeMarkdown(r.pair)}: failed (${r.error || "unknown"})`;
  });
  return `Close-all finished.\n\n${lines.join("\n")}`;
}

export function formatSetNote(pair: string, note: string): string {
  return `✅ Note set for ${escapeMarkdown(pair)}:\n"${escapeMarkdown(note)}"`;
}

export function formatSetConfig(key: string, value: unknown, unknownKeys?: string[]): string {
  if (unknownKeys?.length) {
    return `Config update failed.\nUnknown: ${unknownKeys.join(", ") || "none"}`;
  }
  return `✅ Updated ${key} = ${JSON.stringify(value)}`;
}

export function formatDeployResult(
  candidate: { name: string; pool: string },
  result: { position?: string; txs?: string[]; range_coverage?: { downside_pct: number; upside_pct: number } },
  deployAmount: number,
  binsBelow: number,
  strategy: string,
): string {
  const coverage = result.range_coverage
    ? `Range: ${fmtPct(result.range_coverage.downside_pct)} downside | ${fmtPct(result.range_coverage.upside_pct)} upside`
    : `Strategy: ${strategy} | binsBelow: ${binsBelow}`;
  return [
    `✅ Deployed ${escapeMarkdown(candidate.name)}`,
    `Pool: ${candidate.pool}`,
    `Amount: ${deployAmount} SOL`,
    coverage,
    `Position: ${result.position || "n/a"}`,
    result.txs?.length ? `Tx: ${result.txs[0]}` : null,
  ].filter(Boolean).join("\n");
}

export function formatPause(): string {
  return "⏸ Paused autonomous cycles. Telegram control still works. Use /resume to start again.";
}

export function formatResume(alreadyRunning: boolean): string {
  return alreadyRunning
    ? "Autonomous cycles are already running."
    : "▶️ Autonomous cycles resumed.";
}

export function formatQueued(count: number, text: string): string {
  return `⏳ Queued (${count} in queue): "${text.slice(0, 60)}"`;
}

export function formatQueueFull(): string {
  return "Queue is full (5 messages). Wait for the agent to finish.";
}

export function formatError(message: string): string {
  return `Error: ${message}`;
}

// ── Notification Formatters ──────────────────────────────────────

export function formatDeployNotification(opts: {
  pair: string;
  amountSol: number;
  position?: string;
  tx?: string;
  priceRange?: { min: number; max: number };
  rangeCoverage?: { downside_pct: number; upside_pct: number; width_pct: number };
  binStep?: number;
  baseFee?: number;
}): string {
  const priceStr = opts.priceRange
    ? `Price range: ${opts.priceRange.min < 0.0001 ? opts.priceRange.min.toExponential(3) : opts.priceRange.min.toFixed(6)} – ${opts.priceRange.max < 0.0001 ? opts.priceRange.max.toExponential(3) : opts.priceRange.max.toFixed(6)}\n`
    : "";
  const coverageStr = opts.rangeCoverage
    ? `Range cover: ${fmtPct(opts.rangeCoverage.downside_pct)} downside | ${fmtPct(opts.rangeCoverage.upside_pct)} upside | ${fmtPct(opts.rangeCoverage.width_pct)} total\n`
    : "";
  const poolStr = (opts.binStep || opts.baseFee)
    ? `Bin step: ${opts.binStep ?? "?"}  |  Base fee: ${opts.baseFee != null ? opts.baseFee + "%" : "?"}\n`
    : "";
  return [
    `✅ **Deployed** ${escapeMarkdown(opts.pair)}`,
    `Amount: ${opts.amountSol} SOL`,
    priceStr.trim(),
    coverageStr.trim(),
    poolStr.trim(),
    `Position: \`${opts.position?.slice(0, 8)}...\``,
    `Tx: \`${opts.tx?.slice(0, 16)}...\``,
  ].filter(Boolean).join("\n");
}

export function formatCloseNotification(pair: string, pnlUsd: number, pnlPct: number): string {
  const sign = pnlUsd >= 0 ? "+" : "";
  return `🔒 **Closed** ${escapeMarkdown(pair)}\nPnL: ${sign}$${(pnlUsd ?? 0).toFixed(2)} (${sign}${(pnlPct ?? 0).toFixed(2)}%)`;
}

export function formatSwapNotification(opts: {
  inputSymbol: string;
  outputSymbol: string;
  amountIn: unknown;
  amountOut: unknown;
  tx?: string;
}): string {
  return [
    `🔄 **Swapped** ${escapeMarkdown(opts.inputSymbol)} → ${escapeMarkdown(opts.outputSymbol)}`,
    `In: ${opts.amountIn ?? "?"} | Out: ${opts.amountOut ?? "?"}`,
    `Tx: \`${opts.tx?.slice(0, 16)}...\``,
  ].join("\n");
}

export function formatOutOfRange(pair: string, minutesOOR: number): string {
  return `⚠️ **Out of Range** ${escapeMarkdown(pair)}\nBeen OOR for ${minutesOOR} minutes`;
}

// ── Cycle Reports ────────────────────────────────────────────────

export interface ManagementReportPosition {
  position: string;
  pair: string;
  age_minutes: number | null;
  total_value_usd: number | null;
  unclaimed_fees_usd: number | null;
  pnl_pct: number | null;
  fee_per_tvl_24h: number | null;
  in_range: boolean | null;
  minutes_out_of_range: number;
  instruction?: string | null;
}

export interface ManagementReportAction {
  action: string;
  rule?: string | number;
  reason?: string;
}

export function formatManagementReport(
  positions: ManagementReportPosition[],
  actionMap: Map<string, ManagementReportAction>,
  solMode: boolean,
): string {
  const c = cur(solMode);
  const totalValue = positions.reduce((s, p) => s + (p.total_value_usd ?? 0), 0);
  const totalUnclaimed = positions.reduce((s, p) => s + (p.unclaimed_fees_usd ?? 0), 0);

  const reportLines = positions.map((p) => {
    const act = actionMap.get(p.position);
    const inRange = p.in_range === true ? "🟢 IN" : p.in_range === false ? `🔴 OOR ${p.minutes_out_of_range ?? 0}m` : "??";
    const val = `${c} ${p.total_value_usd ?? "?"}`;
    const unclaimed = `${c} ${p.unclaimed_fees_usd ?? "?"}`;
    const statusLabel = act?.action === "INSTRUCTION" ? "HOLD (instruction)" : act?.action ?? "STAY";
    // Line 1: pair + status + action
    const line1 = `**${escapeMarkdown(p.pair)}** ${inRange} | ${statusLabel}`;
    // Line 2: numbers
    const line2 = `  ${val} | fees ${unclaimed} | PnL ${p.pnl_pct ?? "?"}% | yield ${p.fee_per_tvl_24h ?? "?"}%`;
    // Line 3: age
    const line3 = `  Age: ${p.age_minutes ?? "?"}m`;
    // Optional detail lines
    const details: string[] = [];
    if (p.instruction) details.push(`  Note: "${escapeMarkdown(p.instruction)}"`);
    if (act?.action === "CLOSE" && act.rule === "exit") details.push(`  ⚡ Trailing TP: ${escapeMarkdown(act.reason ?? "")}`);
    if (act?.action === "CLOSE" && act.rule && act.rule !== "exit") details.push(`  Rule ${act.rule}: ${escapeMarkdown(act.reason ?? "")}`);
    if (act?.action === "CLAIM") details.push(`  → Claiming fees`);
    return [line1, line2, line3, ...details].join("\n");
  });

  const needsAction = [...actionMap.values()].filter((a) => a.action !== "STAY");
  const actionSummary = needsAction.length > 0
    ? needsAction.map((a) => a.action === "INSTRUCTION" ? "EVAL instruction" : `${a.action}${a.reason ? ` (${escapeMarkdown(a.reason)})` : ""}`).join(", ")
    : "no action";

  return reportLines.join("\n\n") +
    `\n\n💼 ${positions.length} positions | ${c} ${totalValue.toFixed(4)} | fees: ${c} ${totalUnclaimed.toFixed(4)}\nActions: ${actionSummary}`;
}
