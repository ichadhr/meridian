import "./utils/secure-env.js";

import fs from "fs";
import readline from "readline";
import path from "path";
import { fileURLToPath } from "url";
import { agentLoop } from "./llm/index.js";
import { log } from "./utils/logger.js";
import { getMyPositions, closePosition, getActiveBin, invalidatePositionsCache } from "./providers/meteora/index.js";
import { getWalletBalances } from "./providers/solana/index.js";
import { getTopCandidates } from "./providers/meteora/index.js";
import { config, reloadScreeningThresholds, computeDeployAmount, computeBinsBelow, initProviders } from "./config/index.js";
import { evolveThresholds, getPerformanceSummary } from "./core/index.js";
import { executeTool } from "./llm/index.js";
import {
  startPolling,
  stopPolling,
  sendMessage,
  sendMessageWithButtons,
  sendLongMessage,
  sendDocument,
  editMessage,
  editMessageWithButtons,
  answerCallbackQuery,
  notifyOutOfRange,
  isEnabled as telegramEnabled,
  createLiveMessage,
  dryRunTag,
} from "./interfaces/index.js";
import {
  generateBriefing,
  runLiveManagementCycle,
  tryStartScreening,
  runScreeningCycle,
  getLoneCandidateSkipReason,
  getTrackedPosition,
  getTrackedPositions,
  setPositionInstruction,
  recordPositionSnapshot,
  recallForPool,
  addPoolNote,
  checkSmartWalletsOnPool,
  appendDecision,
  parseVirtualPositionAddress,
  closeVpPosition as closeVpManual,
  generateVpReport as generateDryRunReport,
  readArchive,
  compileVpStats,
} from "./core/index.js";
import { stripThink } from "./utils/text.js";
import { getTokenNarrative, getTokenInfo } from "./providers/jupiter/index.js";
import { bootstrapHiveMind, ensureAgentId, getHiveMindPullMode, isHiveMindEnabled, pullHiveMindLessons, pullHiveMindPresets, registerHiveMindAgent, startHiveMindBackgroundSync } from "./providers/hivemind/index.js";
import { managementBusy, setManagementBusy, screeningBusy, setScreeningBusy, timers } from "./core/index.js";
import { startCronJobs, stopCronJobs, launchCron as _launchCron, pauseCron, resumeCron, cronStarted as _cronStarted, initScheduler, maybeRunMissedBriefing } from "./scheduler/index.js";
import type { LivePosition } from "./types/index.js";
import {
  formatHelpText,
  formatWalletStatus,
  formatConfigSnapshot,
  formatPositions,
  formatPositionDetail,
  formatVirtualPositions,
  formatCloseResult,
  formatCloseAllResult,
  formatSetNote,
  formatSetConfig,
  formatDeployResult,
  formatPause,
  formatResume,
  formatQueued,
  formatQueueFull,
  escapeMarkdown,
  buildConfigSnapshotInput,
} from "./interfaces/index.js";

// ── Type helpers ──────────────────────────────────────────────
type AnyObj = Record<string, any>;

interface TelegramMessage {
  text?: string;
  isCallback?: boolean;
  callbackData?: string;
  callbackQueryId?: string;
  messageId?: number;
  [key: string]: any;
}

interface Candidate {
  pool: AnyObj;
  sw: any;
  n: any;
  ti: any;
  mem: any;
  [key: string]: any;
}

const entrypointPath: string | undefined = process.env.pm_exec_path || process.argv[1];
const isMain: boolean = entrypointPath
  ? path.resolve(entrypointPath) === fileURLToPath(import.meta.url)
  : false;

if (isMain) {
  log("startup", "DLMM LP Agent starting...");
  log("startup", `Mode: ${process.env.DRY_RUN === "true" ? "DRY RUN" : "LIVE"}`);
  initProviders();
  initScheduler({
    healthCheckFn: async () => { await agentLoop(`\nHEALTH CHECK\n\nSummarize the current portfolio health, total fees earned, and performance of all open positions. Recommend any high-level adjustments if needed.\n      `, config.llm.maxSteps, [], "MANAGER"); },
  });
  ensureAgentId();
  bootstrapHiveMind().catch((error: Error) => log("hivemind_warn", `Bootstrap failed: ${error.message}`));
  startHiveMindBackgroundSync();
  import("./core/archive.js").then((m: any) => {
    m.migrateOldArchives();
    m.purgeCorruptedArchiveRecords();
  }).catch(() => {});
}

const TP_PCT: number = config.management.takeProfitPct;
const DEPLOY: number = config.management.deployAmountSol;

function nextRunIn(lastRun: number | null, intervalMin: number): number {
  if (!lastRun) return intervalMin * 60;
  const elapsed = (Date.now() - lastRun) / 1000;
  return Math.max(0, intervalMin * 60 - elapsed);
}

function formatCountdown(seconds: number): string {
  if (seconds <= 0) return "now";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function buildPrompt(): string {
  const mgmt = formatCountdown(nextRunIn(timers.managementLastRun, config.schedule.managementIntervalMin));
  const scrn = formatCountdown(nextRunIn(timers.screeningLastRun, config.schedule.screeningIntervalMin));
  return `[manage: ${mgmt} | screen: ${scrn}]\n> `;
}

// ═══════════════════════════════════════════
//  GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════
let _shuttingDown: boolean = false;

function withTimeout(promise: Promise<any>, ms: number): Promise<any> {
  let timer: NodeJS.Timeout | null = null;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function shutdown(signal: string): Promise<void> {
  if (_shuttingDown) {
    log("shutdown", `Received ${signal} while shutdown is already in progress.`);
    return;
  }
  _shuttingDown = true;

  log("shutdown", `Received ${signal}. Shutting down...`);
  stopPolling();
  stopCronJobs();

  const positions: any = await withTimeout(
    getMyPositions({ force: true, silent: true }).catch((error: Error) => {
      log("shutdown", `Position snapshot failed during shutdown: ${error.message}`);
      return null;
    }),
    5000
  );
  if (positions) {
    log("shutdown", `Open positions at shutdown: ${positions.total_positions}`);
  } else {
    log("shutdown", "Open position snapshot skipped during shutdown timeout");
  }
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ═══════════════════════════════════════════
//  FORMAT CANDIDATES TABLE
// ═══════════════════════════════════════════
function formatCandidates(candidates: any[]): string {
  if (!candidates.length) return "  No eligible pools found right now.";

  const lines: string[] = candidates.map((p: any, i: number) => {
    const name = (p.name || "unknown").padEnd(20);
    const ftvl = `${p.fee_active_tvl_ratio ?? p.fee_tvl_ratio}%`.padStart(8);
    const vol = `$${((p.volume_window || 0) / 1000).toFixed(1)}k`.padStart(8);
    const active = `${p.active_pct}%`.padStart(6);
    const org = String(p.organic_score).padStart(4);
    return `  [${i + 1}]  ${name}  fee/aTVL:${ftvl}  vol:${vol}  in-range:${active}  organic:${org}`;
  });

  return [
    "  #   pool                  fee/aTVL     vol    in-range  organic",
    "  " + "─".repeat(68),
    ...lines,
  ].join("\n");
}

// ═══════════════════════════════════════════
//  INTERACTIVE REPL
// ═══════════════════════════════════════════
const isTTY: boolean = process.stdin.isTTY;
let busy: boolean = false;
const _telegramQueue: TelegramMessage[] = []; // queued messages received while agent was busy
const sessionHistory: AnyObj[] = []; // persists conversation across REPL turns
const MAX_HISTORY: number = 20;    // keep last 20 messages (10 exchanges)
let _ttyInterface: readline.Interface | null = null;
let _latestCandidates: any[] = [];
let _latestCandidatesAt: string | null = null;

function setLatestCandidates(candidates: any[] = []): void {
  _latestCandidates = Array.isArray(candidates) ? candidates : [];
  _latestCandidatesAt = new Date().toISOString();
}

function getLatestCandidatesMeta(): { candidates: any[]; count: number; updatedAt: string | null } {
  return {
    candidates: _latestCandidates,
    count: _latestCandidates.length,
    updatedAt: _latestCandidatesAt,
  };
}

function describeLatestCandidates(limit: number = 5): string {
  if (!_latestCandidates.length) return "No cached candidates yet. Run /screen first.";
  const lines: string[] = _latestCandidates.slice(0, limit).map((pool: any, i: number) => {
    const feeTvl = pool.fee_active_tvl_ratio ?? pool.fee_tvl_ratio ?? "?";
    const vol = pool.volume_window ?? pool.volume_24h ?? "?";
    const active = pool.active_pct ?? "?";
    const organic = pool.organic_score ?? "?";
    return `${i + 1}. ${pool.name} | fee/aTVL ${feeTvl}% | vol $${vol} | in-range ${active}% | organic ${organic}`;
  });
  const age: string = _latestCandidatesAt ? new Date(_latestCandidatesAt).toLocaleString("en-US", { hour12: false }) : "unknown";
  return `Latest candidates (${_latestCandidates.length}) — updated ${age}\n\n${lines.join("\n")}`;
}



function parseConfigValue(raw: any): any {
  const value: string = String(raw ?? "").trim();
  if (!value.length) return "";
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
  if (/^null$/i.test(value)) return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith("[") && value.endsWith("]")) || (value.startsWith("{") && value.endsWith("}"))) {
    return JSON.parse(value);
  }
  return value;
}

function settingValue(key: string): any {
  const values: AnyObj = {
    solMode: config.management.solMode,
    lpAgentRelayEnabled: config.api.lpAgentRelayEnabled,
    chartIndicatorsEnabled: config.indicators.enabled,
    trailingTakeProfit: config.management.trailingTakeProfit,
    useDiscordSignals: config.screening.useDiscordSignals,
    blockPvpSymbols: config.screening.blockPvpSymbols,
    strategy: config.strategy.strategy,
    minBinsBelow: config.strategy.minBinsBelow,
    maxBinsBelow: config.strategy.maxBinsBelow,
    defaultBinsBelow: config.strategy.defaultBinsBelow,
    deployAmountSol: config.management.deployAmountSol,
    gasReserve: config.management.gasReserve,
    maxPositions: config.risk.maxPositions,
    maxDeployAmount: config.risk.maxDeployAmount,
    takeProfitPct: config.management.takeProfitPct,
    stopLossPct: config.management.stopLossPct,
    trailingTriggerPct: config.management.trailingTriggerPct,
    trailingDropPct: config.management.trailingDropPct,
    repeatDeployCooldownEnabled: config.management.repeatDeployCooldownEnabled,
    repeatDeployCooldownTriggerCount: config.management.repeatDeployCooldownTriggerCount,
    repeatDeployCooldownHours: config.management.repeatDeployCooldownHours,
    repeatDeployCooldownMinFeeEarnedPct: config.management.repeatDeployCooldownMinFeeEarnedPct,
    managementIntervalMin: config.schedule.managementIntervalMin,
    screeningIntervalMin: config.schedule.screeningIntervalMin,
    indicatorEntryPreset: config.indicators.entryPreset,
    indicatorExitPreset: config.indicators.exitPreset,
    rsiLength: config.indicators.rsiLength,
    indicatorIntervals: config.indicators.intervals,
    requireAllIntervals: config.indicators.requireAllIntervals,
  };
  return values[key];
}

function fmtSettingValue(value: any): string {
  if (Array.isArray(value)) return value.join(",");
  if (typeof value === "boolean") return value ? "on" : "off";
  return String(value);
}

function settingButton(label: string, data: string): AnyObj {
  return { text: label, callback_data: data };
}

function toggleButton(key: string, label: string): AnyObj {
  return settingButton(`${label}: ${fmtSettingValue(settingValue(key))}`, `cfg:toggle:${key}`);
}

function stepButtons(key: string, label: string, step: number, { digits = 2 }: { digits?: number } = {}): AnyObj[] {
  const value: number = Number(settingValue(key));
  const shown: string = Number.isFinite(value) ? value.toFixed(digits).replace(/\.?0+$/, "") : "?";
  return [
    settingButton(`- ${label}`, `cfg:step:${key}:${-step}`),
    settingButton(`${label}: ${shown}`, `cfg:noop`),
    settingButton(`+ ${label}`, `cfg:step:${key}:${step}`),
  ];
}

function renderSettingsMenu(page: string = "main"): { text: string; keyboard: AnyObj[][] } {
  const title: string = page === "main" ? "Settings menu" : `Settings: ${page}`;
  const summary: string = [
    title,
    "",
    `Mode: ${config.management.solMode ? "SOL" : "USD"} | Relay: ${config.api.lpAgentRelayEnabled ? "on" : "off"}`,
    `Strategy: ${config.strategy.strategy} | bins ${config.strategy.minBinsBelow}-${config.strategy.maxBinsBelow} | deploy ${config.management.deployAmountSol} SOL`,
    `TP/SL: ${config.management.takeProfitPct}% / ${config.management.stopLossPct}% | trailing ${config.management.trailingTakeProfit ? "on" : "off"}`,
    `Indicators: ${config.indicators.enabled ? "on" : "off"} | entry ${config.indicators.entryPreset} | ${fmtSettingValue(config.indicators.intervals)}`,
  ].join("\n");

  const nav: AnyObj[][] = [
    [
      settingButton("Main", "cfg:page:main"),
      settingButton("Risk", "cfg:page:risk"),
      settingButton("Screen", "cfg:page:screen"),
      settingButton("Indicators", "cfg:page:indicators"),
    ],
  ];

  const footer: AnyObj[][] = [
    [
      settingButton("Refresh", `cfg:page:${page}`),
      settingButton("Close", "cfg:close"),
    ],
  ];

  let rows: AnyObj[][];
  if (page === "risk") {
    rows = [
      stepButtons("deployAmountSol", "Deploy", 0.1),
      stepButtons("gasReserve", "Gas", 0.05),
      stepButtons("maxPositions", "Max pos", 1, { digits: 0 }),
      stepButtons("maxDeployAmount", "Max SOL", 1, { digits: 0 }),
      stepButtons("takeProfitPct", "TP %", 1, { digits: 0 }),
      stepButtons("stopLossPct", "SL %", 5, { digits: 0 }),
      [toggleButton("trailingTakeProfit", "Trailing TP")],
      stepButtons("trailingTriggerPct", "Trail trigger", 0.5, { digits: 1 }),
      stepButtons("trailingDropPct", "Trail drop", 0.5, { digits: 1 }),
      [toggleButton("repeatDeployCooldownEnabled", "Repeat cooldown")],
      stepButtons("repeatDeployCooldownTriggerCount", "Repeat count", 1, { digits: 0 }),
      stepButtons("repeatDeployCooldownHours", "Repeat hrs", 1, { digits: 0 }),
      stepButtons("repeatDeployCooldownMinFeeEarnedPct", "Fee earned %", 0.1, { digits: 1 }),
    ];
  } else if (page === "screen") {
    rows = [
      [toggleButton("useDiscordSignals", "Discord signals"), toggleButton("blockPvpSymbols", "PVP hard block")],
      [
        settingButton(`Strategy: spot`, "cfg:set:strategy:spot"),
        settingButton(`Strategy: bid_ask`, "cfg:set:strategy:bid_ask"),
      ],
      stepButtons("minBinsBelow", "Min bins", 1, { digits: 0 }),
      stepButtons("maxBinsBelow", "Max bins", 1, { digits: 0 }),
      stepButtons("defaultBinsBelow", "Default bins", 1, { digits: 0 }),
      stepButtons("managementIntervalMin", "Manage min", 1, { digits: 0 }),
      stepButtons("screeningIntervalMin", "Screen min", 5, { digits: 0 }),
    ];
  } else if (page === "indicators") {
    rows = [
      [toggleButton("chartIndicatorsEnabled", "Chart indicators"), toggleButton("requireAllIntervals", "Require all TF")],
      [
        settingButton("TF: 5m", "cfg:set:indicatorIntervals:5_MINUTE"),
        settingButton("TF: 15m", "cfg:set:indicatorIntervals:15_MINUTE"),
        settingButton("TF: both", "cfg:set:indicatorIntervals:both"),
      ],
      [
        settingButton("Entry: ST", "cfg:set:indicatorEntryPreset:supertrend_break"),
        settingButton("Entry: RSI", "cfg:set:indicatorEntryPreset:rsi_reversal"),
        settingButton("Entry: ST/RSI", "cfg:set:indicatorEntryPreset:supertrend_or_rsi"),
      ],
      [
        settingButton("Exit: ST", "cfg:set:indicatorExitPreset:supertrend_break"),
        settingButton("Exit: RSI", "cfg:set:indicatorExitPreset:rsi_reversal"),
        settingButton("Exit: BB+RSI", "cfg:set:indicatorExitPreset:bb_plus_rsi"),
      ],
      stepButtons("rsiLength", "RSI len", 1, { digits: 0 }),
    ];
  } else {
    rows = [
      [toggleButton("solMode", "SOL mode"), toggleButton("lpAgentRelayEnabled", "LPAgent relay")],
      [toggleButton("chartIndicatorsEnabled", "Chart indicators"), toggleButton("trailingTakeProfit", "Trailing TP")],
      [
        settingButton("Risk / deploy", "cfg:page:risk"),
        settingButton("Screening", "cfg:page:screen"),
      ],
      [
        settingButton("Indicators", "cfg:page:indicators"),
        settingButton("Show config", "cfg:show"),
      ],
    ];
  }

  return { text: summary, keyboard: [...nav, ...rows, ...footer] };
}

async function showSettingsMenu({ messageId = null, page = "main" }: { messageId?: number | null; page?: string } = {}): Promise<void> {
  const menu = renderSettingsMenu(page);
  if (messageId) {
    await editMessageWithButtons(menu.text, messageId, menu.keyboard);
  } else {
    await sendMessageWithButtons(menu.text, menu.keyboard);
  }
}

function normalizeMenuValue(key: string, raw: any): any {
  if (key === "indicatorIntervals") {
    if (raw === "both") return ["5_MINUTE", "15_MINUTE"];
    return [raw];
  }
  return parseConfigValue(raw);
}

async function applySettingsMenuCallback(msg: TelegramMessage): Promise<void> {
  const data: string = msg.callbackData || msg.text || "";
  const parts: string[] = data.split(":");
  const action: string = parts[1];
  let page: string = "main";

  if (action === "noop") {
    await answerCallbackQuery(msg.callbackQueryId!);
    return;
  }
  if (action === "close") {
    await answerCallbackQuery(msg.callbackQueryId!, "Closed");
    await editMessage("Settings menu closed.", msg.messageId!);
    return;
  }
  if (action === "show") {
    await answerCallbackQuery(msg.callbackQueryId!);
    await editMessageWithButtons(formatConfigSnapshot(buildConfigSnapshotInput(config, isHiveMindEnabled())), msg.messageId!, [[settingButton("Back", "cfg:page:main")]]);
    return;
  }
  if (action === "page") {
    page = parts[2] || "main";
    await answerCallbackQuery(msg.callbackQueryId!);
    await showSettingsMenu({ messageId: msg.messageId!, page });
    return;
  }

  const key: string = parts[2];
  let value: any;
  if (action === "toggle") {
    value = !Boolean(settingValue(key));
  } else if (action === "step") {
    const current: number = Number(settingValue(key));
    const delta: number = Number(parts[3]);
    if (!Number.isFinite(current) || !Number.isFinite(delta)) {
      await answerCallbackQuery(msg.callbackQueryId!, "Invalid setting");
      return;
    }
    value = Number((current + delta).toFixed(4));
    if (key === "maxPositions") value = Math.max(1, Math.round(value));
    if (key === "rsiLength") value = Math.max(2, Math.round(value));
    if (key === "repeatDeployCooldownTriggerCount") value = Math.max(1, Math.round(value));
    if (key === "repeatDeployCooldownHours") value = Math.max(0, Math.round(value));
    if (key === "repeatDeployCooldownMinFeeEarnedPct") value = Math.max(0, value);
    if (["minBinsBelow", "maxBinsBelow", "defaultBinsBelow"].includes(key)) value = Math.max(35, Math.round(value));
    if (["deployAmountSol", "gasReserve", "maxDeployAmount"].includes(key)) value = Math.max(0, value);
  } else if (action === "set") {
    value = normalizeMenuValue(key, parts.slice(3).join(":"));
  } else {
    await answerCallbackQuery(msg.callbackQueryId!, "Unknown action");
    return;
  }

  const result: any = await executeTool("update_config", {
    changes: { [key]: value },
    reason: "Telegram settings menu",
  });
  if (!result?.success) {
    await answerCallbackQuery(msg.callbackQueryId!, "Config update failed");
    return;
  }
  page = key.startsWith("indicator") || key === "chartIndicatorsEnabled" || key === "rsiLength" || key === "requireAllIntervals"
    ? "indicators"
    : ["useDiscordSignals", "blockPvpSymbols", "strategy", "minBinsBelow", "maxBinsBelow", "defaultBinsBelow", "managementIntervalMin", "screeningIntervalMin"].includes(key)
      ? "screen"
      : "risk";
  await answerCallbackQuery(msg.callbackQueryId!, `Updated ${key}`);
  await showSettingsMenu({ messageId: msg.messageId!, page });
}



async function runDeterministicScreen(limit: number = 5): Promise<string> {
  const top: any = await getTopCandidates({ limit });
  const candidates: any[] = (top?.candidates || top?.pools || []).slice(0, limit);
  setLatestCandidates(candidates);
  if (candidates.length > 0) {
    const lines: string[] = candidates.map((pool: any, i: number) => {
      const feeTvl = pool.fee_active_tvl_ratio ?? pool.fee_tvl_ratio ?? "?";
      const vol = pool.volume_window ?? pool.volume_24h ?? "?";
      return `${i + 1}. ${pool.name} | ${pool.pool}\n   fee/aTVL ${feeTvl}% | vol $${vol} | organic ${pool.organic_score ?? "?"}`;
    });
    return `Top candidates (${candidates.length})\n\n${lines.join("\n")}`;
  }
  const examples: string = (top?.filtered_examples || []).slice(0, 3)
    .map((entry: any) => `- ${entry.name}: ${entry.reason}`)
    .join("\n");
  return examples
    ? `No candidates available.\nFiltered examples:\n${examples}`
    : "No candidates available right now.";
}

async function deployLatestCandidate(index: number): Promise<{ result: any; candidate: any; deployAmount: number; binsBelow: number }> {
  const candidate: any = _latestCandidates[index];
  if (!candidate) {
    throw new Error("Invalid candidate index. Run /screen first.");
  }
  if (_latestCandidates.length === 1) {
    const mint: string | null = candidate.base?.mint || candidate.base_mint || null;
    const [smartWallets, narrative, tokenInfo] = await Promise.allSettled([
      checkSmartWalletsOnPool({ pool_address: candidate.pool }),
      mint ? getTokenNarrative({ mint }) : Promise.resolve(null),
      mint ? getTokenInfo({ query: mint }) : Promise.resolve(null),
    ]);
    const context: Candidate = {
      pool: candidate,
      sw: smartWallets.status === "fulfilled" ? smartWallets.value : null,
      n: narrative.status === "fulfilled" ? narrative.value : null,
      ti: tokenInfo.status === "fulfilled" ? (tokenInfo.value as any)?.results?.[0] : null,
      mem: null,
    };
    const skipReason: string | null = getLoneCandidateSkipReason(context);
    if (skipReason) {
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "Single cached candidate skipped",
        reason: skipReason,
        pool: candidate.pool,
        pool_name: candidate.name,
      });
      throw new Error(`NO DEPLOY: only cached candidate ${candidate.name} is not worth deploying — ${skipReason}`);
    }
  }
  const deployAmount: number = computeDeployAmount((await getWalletBalances()).sol);
  const binsBelow: number = computeBinsBelow(candidate.volatility);
  const result: any = await executeTool("deploy_position", {
    pool_address: candidate.pool,
    amount_y: deployAmount,
    strategy: config.strategy.strategy,
    bins_below: binsBelow,
    bins_above: 0,
    pool_name: candidate.name,
    base_mint: candidate.base?.mint || candidate.base_mint || null,
    bin_step: candidate.bin_step,
    base_fee: candidate.base_fee,
    volatility: candidate.volatility,
    fee_tvl_ratio: candidate.fee_active_tvl_ratio ?? candidate.fee_tvl_ratio,
    organic_score: candidate.organic_score,
  });
  if (result?.success === false || result?.error) {
    throw new Error(result.error || "Deploy failed");
  }
  return { result, candidate, deployAmount, binsBelow };
}

function appendHistory(userMsg: string, assistantMsg: string): void {
  sessionHistory.push({ role: "user", content: userMsg });
  sessionHistory.push({ role: "assistant", content: assistantMsg });
  // Trim to last MAX_HISTORY messages
  if (sessionHistory.length > MAX_HISTORY) {
    sessionHistory.splice(0, sessionHistory.length - MAX_HISTORY);
  }
}

function refreshPrompt(): void {
  if (!_ttyInterface) return;
  _ttyInterface.setPrompt(buildPrompt());
  _ttyInterface.prompt(true);
}

async function drainTelegramQueue(): Promise<void> {
  while (_telegramQueue.length > 0 && !managementBusy && !screeningBusy && !busy) {
    const queued: TelegramMessage | undefined = _telegramQueue.shift();
    if (queued) {
      await telegramHandler(queued);
    }
  }
}

async function telegramHandler(msg: TelegramMessage): Promise<void> {
  const text: string | undefined = msg?.text?.trim().split("@")[0];
  if (!text) return;
  if (msg?.isCallback && text.startsWith("cfg:")) {
    try {
      await applySettingsMenuCallback(msg);
    } catch (e: any) {
      await answerCallbackQuery(msg.callbackQueryId!, e.message).catch(() => {});
    }
    return;
  }
  if (text === "/settings" || text === "/menu" || text === "/configmenu") {
    await showSettingsMenu().catch((e: Error) => sendMessage(`Settings error: ${e.message}`).catch(() => {}));
    return;
  }
  if (managementBusy || screeningBusy || busy) {
    if (_telegramQueue.length < 5) {
      _telegramQueue.push(msg);
      sendMessage(formatQueued(_telegramQueue.length, text)).catch(() => {});
    } else {
      sendMessage(formatQueueFull()).catch(() => {});
    }
    return;
  }

  if (text === "/briefing") {
    try {
      const briefing: string = await generateBriefing();
      await sendLongMessage(briefing);
    } catch (e: any) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/help") {
    await sendMessage(formatHelpText()).catch(() => {});
    return;
  }

  if (text === "/wallet" || text === "/status") {
    try {
      const [wallet, positions] = await Promise.all([getWalletBalances(), getMyPositions({ force: true })]);
      const suffix: string = text === "/status" && positions.total_positions
        ? `\n\nUse /positions for the numbered list.`
        : "";
      await sendMessage(`${formatWalletStatus(wallet, positions, {
        solMode: config.management.solMode,
        maxPositions: config.risk.maxPositions,
        deployAmount: computeDeployAmount(wallet.sol),
        dryRun: process.env.DRY_RUN === "true",
        hiveEnabled: isHiveMindEnabled(),
      })}${suffix}`).catch(() => {});
    } catch (e: any) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/config") {
    await sendMessage(formatConfigSnapshot(buildConfigSnapshotInput(config, isHiveMindEnabled()))).catch(() => {});
    return;
  }

  if (text === "/positions") {
    try {
      const { positions, total_positions }: { positions: LivePosition[]; total_positions: number } = await getMyPositions({ force: true });
      await sendMessage(dryRunTag(formatPositions(positions, total_positions, config.management.solMode)));
    } catch (e: any) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  if (text === "/vp" || text === "/vp report") {
    try {
      if (text === "/vp report") {
        const records: any = await readArchive({ source: "paper", hours: 720, limit: 5000 });
        const statsMsg: string = compileVpStats(records);
        await sendLongMessage(statsMsg);

        const html: string = await generateDryRunReport();
        const filePath: string = path.join(path.dirname(fileURLToPath(import.meta.url)), "dry-run-report.html");
        fs.writeFileSync(filePath, html, "utf8");
        const sent: boolean = await sendDocument(filePath, { caption: "📄 Dry-run VP report" });
        if (!sent) await sendMessage("❌ Failed to upload HTML report — check logs.");
      } else {
        const { positions }: { positions: LivePosition[] } = await getMyPositions({ force: true });
        const vps: LivePosition[] = positions.filter((p: LivePosition) => p.position?.startsWith("vp:"));
        await sendMessage(formatVirtualPositions(vps, config.management.solMode));
      }
    } catch (e: any) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  const poolMatch: RegExpMatchArray | null = text.match(/^\/pool\s+(\d+)$/i);
  if (poolMatch) {
    try {
      const idx: number = parseInt(poolMatch[1]) - 1;
      const { positions }: { positions: LivePosition[] } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
      const pos: LivePosition = positions[idx];
      await sendMessage(formatPositionDetail(pos, idx, config.management.solMode));
    } catch (e: any) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  // Helper: close a position from the result of getMyPositions.
  // Routes to closeVirtualPosition for VPs (source: "virtual") and
  // closePosition for live on-chain positions. Returns a unified
  // result shape so the success/failure branches work for both.
  async function closeTelegramPosition(pos: LivePosition): Promise<any> {
    const vpId: string | null = parseVirtualPositionAddress(pos.position);
    if (vpId) {
      // closeVpManual does a fresh bin fetch + computePositionPnl — the
      // legacy computeSimpleVirtualPnl read stale `vp.current_value_usd`.
      // Returns polymorphic pnl_usd/pnl_pct matching the current solMode.
      return await closeVpManual(vpId, "manual close via telegram /close");
    }
    return await closePosition({ position_address: pos.position });
  }

  const closeMatch: RegExpMatchArray | null = text.match(/^\/close\s+(\d+)$/i);
  if (closeMatch) {
    try {
      const idx: number = parseInt(closeMatch[1]) - 1;
      const { positions }: { positions: LivePosition[] } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
      const pos: LivePosition = positions[idx];
      await sendMessage(`Closing ${escapeMarkdown(pos.pair)}...`);
      const result: any = await closeTelegramPosition(pos);
      await sendMessage(dryRunTag(formatCloseResult(pos, result, config.management.solMode)));
      if (result.success) {
        tryStartScreening("telegram-close", true);
      }
    } catch (e: any) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  if (text === "/closeall") {
    try {
      const { positions }: { positions: LivePosition[] } = await getMyPositions({ force: true });
      if (!positions.length) { await sendMessage("No open positions."); return; }
      await sendMessage(`Closing ${positions.length} position(s)...`);
      const results: Array<{ pair: string; success: boolean; pnl_pct?: number; error?: string; is_virtual?: boolean }> = [];
      for (const pos of positions) {
        try {
          const result: any = await closeTelegramPosition(pos);
          results.push({ pair: pos.pair, success: result.success, pnl_pct: result.pnl_pct, error: result.error, is_virtual: result.is_virtual });
        } catch (error: any) {
          results.push({ pair: pos.pair, success: false, error: error.message });
        }
      }
      await sendMessage(dryRunTag(formatCloseAllResult(results))).catch(() => {});
      tryStartScreening("telegram-closeall", true);
    } catch (e: any) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  const setMatch: RegExpMatchArray | null = text.match(/^\/set\s+(\d+)\s+(.+)$/i);
  if (setMatch) {
    try {
      const idx: number = parseInt(setMatch[1]) - 1;
      const note: string = setMatch[2].trim();
      const { positions }: { positions: LivePosition[] } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
      const pos: LivePosition = positions[idx];
      setPositionInstruction(pos.position, note);
      await sendMessage(formatSetNote(pos.pair, note));
    } catch (e: any) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  const setCfgMatch: RegExpMatchArray | null = text.match(/^\/setcfg\s+([A-Za-z0-9_]+)\s+(.+)$/i);
  if (setCfgMatch) {
    try {
      const key: string = setCfgMatch[1];
      const value: any = parseConfigValue(setCfgMatch[2]);
      const result: any = await executeTool("update_config", {
        changes: { [key]: value },
        reason: "Telegram slash command /setcfg",
      });
      if (!result?.success) {
        await sendMessage(formatSetConfig(key, value, result?.unknown)).catch(() => {});
        return;
      }
      await sendMessage(formatSetConfig(key, value)).catch(() => {});
    } catch (e: any) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/screen") {
    try {
      await sendMessage(await runDeterministicScreen(5)).catch(() => {});
    } catch (e: any) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/candidates") {
    await sendMessage(describeLatestCandidates(5)).catch(() => {});
    return;
  }

  const deployMatch: RegExpMatchArray | null = text.match(/^\/deploy\s+(\d+)$/i);
  if (deployMatch) {
    try {
      const idx: number = parseInt(deployMatch[1]) - 1;
      const { candidate, result, deployAmount, binsBelow } = await deployLatestCandidate(idx);
      await sendMessage(dryRunTag(formatDeployResult(candidate, result, deployAmount, binsBelow, config.strategy.strategy))).catch(() => {});
    } catch (e: any) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/pause") {
    pauseCron();
    await sendMessage(formatPause()).catch(() => {});
    return;
  }

  if (text === "/resume") {
    if (!_cronStarted) {
      resumeCron();
      await sendMessage(formatResume(false)).catch(() => {});
    } else {
      await sendMessage(formatResume(true)).catch(() => {});
    }
    return;
  }

  if (text === "/hive" || text === "/hive pull") {
    try {
      const enabled: boolean = isHiveMindEnabled();
      const agentId: string = ensureAgentId();
      if (!enabled) {
        await sendMessage(`HiveMind: disabled\nAgent ID: ${agentId}\nSet hiveMindApiKey to connect.`).catch(() => {});
        return;
      }
      const isManualPull: boolean = text === "/hive pull";
      const pullMode: string = getHiveMindPullMode();
      const [registerResult, lessons, presets]: [any, any, any] = await Promise.all([
        registerHiveMindAgent({ reason: isManualPull ? "telegram_pull" : "telegram_status" }),
        (pullMode === "auto" || isManualPull) ? pullHiveMindLessons(12) : Promise.resolve(null),
        (pullMode === "auto" || isManualPull) ? pullHiveMindPresets() : Promise.resolve(null),
      ]);
      await sendMessage([
        "HiveMind: enabled",
        `Agent ID: ${agentId}`,
        `URL: ${config.hiveMind.url}`,
        `Pull mode: ${pullMode}`,
        `Register: ${registerResult ? "ok" : "warn"}`,
        `Shared lessons: ${Array.isArray(lessons) ? lessons.length : (pullMode === "manual" ? "manual" : 0)}`,
        `Presets: ${Array.isArray(presets) ? presets.length : (pullMode === "manual" ? "manual" : 0)}`,
        isManualPull ? "Manual pull: completed" : null,
      ].join("\n")).catch(() => {});
    } catch (e: any) {
      await sendMessage(`HiveMind error: ${e.message}`).catch(() => {});
    }
    return;
  }

  busy = true;
  let liveMessage: any = null;
  try {
    log("telegram", `Incoming: ${text}`);
    const hasCloseIntent: boolean = /\bclose\b|\bsell\b|\bexit\b|\bwithdraw\b/i.test(text);
    const isDeployRequest: boolean = !hasCloseIntent && /\bdeploy\b|\bopen position\b|\blp into\b|\badd liquidity\b/i.test(text);
    const agentRole: string = isDeployRequest ? "SCREENER" : "GENERAL";
    const agentModel = agentRole === "SCREENER" ? config.llm.screeningModel : config.llm.generalModel;
    liveMessage = await createLiveMessage("🤖 Live Update", `Request: ${text.slice(0, 240)}`);
    const { content }: { content: string } = await agentLoop(text, config.llm.maxSteps, sessionHistory, agentRole as any, agentModel, null, {
      interactive: true,
      onToolStart: async ({ name }: { name: string }) => { await liveMessage?.toolStart(name); },
      onToolFinish: async ({ name, result, success }: { name: string; result: any; success: boolean }) => { await liveMessage?.toolFinish(name, result, success); },
    });
    appendHistory(text, content);
    if (liveMessage) await liveMessage.finalize(stripThink(content));
    else await sendLongMessage(stripThink(content));
  } catch (e: any) {
    if (liveMessage) await liveMessage.fail(e.message).catch(() => {});
    else await sendMessage(`Error: ${e.message}`).catch(() => {});
  } finally {
    busy = false;
    refreshPrompt();
    drainTelegramQueue().catch(() => {});
  }
}



// Restarter and screening trigger now handled by scheduler/index.ts and executor.ts directly

if (isMain && isTTY) {
  const rl: readline.Interface = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: buildPrompt(),
  });
  _ttyInterface = rl;

  // Update prompt countdown every 10 seconds
  setInterval(() => {
    if (!busy) {
      rl.setPrompt(buildPrompt());
      rl.prompt(true); // true = preserve current line
    }
  }, 10_000);

  function launchCron(): void {
    if (!_cronStarted) {
      _launchCron();
      console.log("Autonomous cycles are now running.\n");
      rl.setPrompt(buildPrompt());
      rl.prompt(true);
    }
  }

  async function runBusy(fn: () => Promise<void>): Promise<void> {
    if (busy) { console.log("Agent is busy, please wait..."); rl.prompt(); return; }
    busy = true; rl.pause();
    try { await fn(); }
    catch (e: any) { console.error(`Error: ${e.message}`); }
    finally { busy = false; rl.setPrompt(buildPrompt()); rl.resume(); rl.prompt(); }
  }

  // ── Startup: show wallet + top candidates ──
  console.log(`
╔═══════════════════════════════════════════╗
║         DLMM LP Agent — Ready             ║
╚═══════════════════════════════════════════╝
`);

  console.log("Fetching wallet and top pool candidates...\n");

  busy = true;
  try {
    const [wallet, positions, { candidates, total_eligible, total_screened }]: [any, any, any] = await Promise.all([
      getWalletBalances(),
      getMyPositions({ force: true }),
      getTopCandidates({ limit: 5 }),
    ]);

    setLatestCandidates(candidates);

    console.log(`Wallet:    ${wallet.sol} SOL  ($ ${wallet.sol_usd})  |  SOL price: $ ${wallet.sol_price}`);
    if (positions.total_positions > 0) {
      console.log("Open positions:");
      for (const p of positions.positions) {
        const status: string = p.in_range === true ? "in-range ✓" : p.in_range === false ? "OUT OF RANGE ⚠" : "?? (no fresh PnL)";
        console.log(`  ${p.pair.padEnd(16)} ${status}  fees: $ ${p.unclaimed_fees_usd}`);
      }
      console.log();
    }

    console.log(`Top pools (${total_eligible} eligible from ${total_screened} screened):\n`);
    console.log(formatCandidates(candidates));

  } catch (e: any) {
    console.error(`Startup fetch failed: ${e.message}`);
  } finally {
    busy = false;
  }

  // Always start autonomous cycles on launch
  launchCron();
  maybeRunMissedBriefing().catch(() => { });

  startPolling(telegramHandler);

  console.log(`
Commands:
  1 / 2 / 3 ...  Deploy ${DEPLOY} SOL into that pool
  auto           Let the agent pick and deploy automatically
  /status        Refresh wallet + positions
  /candidates    Refresh top pool list
  /briefing      Show morning briefing (last 24h)
  /learn         Study top LPers from the best current pool and save lessons
  /learn <addr>  Study top LPers from a specific pool address
  /thresholds    Show current screening thresholds + performance stats
  /evolve        Manually trigger threshold evolution from performance data
  /stop          Shut down
`);

  rl.prompt();

  rl.on("line", async (line: string) => {
    const input: string = line.trim();
    if (!input) { rl.prompt(); return; }

    // ── Number pick: deploy into pool N ─────
    const pick: number = parseInt(input);
    const latest: any[] = getLatestCandidatesMeta().candidates;
    if (!isNaN(pick) && pick >= 1 && pick <= latest.length) {
      await runBusy(async () => {
        const pool: any = latest[pick - 1];
        console.log(`\nDeploying ${DEPLOY} SOL into ${pool.name}...\n`);
        const { content: reply }: { content: string } = await agentLoop(
          `Deploy ${DEPLOY} SOL into pool ${pool.pool} (${pool.name}). Call get_active_bin first then deploy_position. Report result.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── auto: agent picks and deploys ───────
    if (input.toLowerCase() === "auto") {
      await runBusy(async () => {
        console.log("\nAgent is picking and deploying...\n");
        const { content: reply }: { content: string } = await agentLoop(
          `get_top_candidates and deploy only if a candidate is clearly worth it. If there is only one weak candidate, report NO DEPLOY. For a valid deploy, use amount_y=${DEPLOY}, amount_x=0, bins_above=0, and bins_below from positive volatility. Execute now, don't ask.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── go: start cron without deploying ────
    if (input.toLowerCase() === "go") {
      launchCron();
      rl.prompt();
      return;
    }

    // ── Slash commands ───────────────────────
    if (input === "/stop") { await shutdown("user command"); return; }

    if (input === "/status") {
      await runBusy(async () => {
        const [wallet, positions]: [any, any] = await Promise.all([getWalletBalances(), getMyPositions({ force: true })]);
        console.log(`\nWallet: ${wallet.sol} SOL  ($ ${wallet.sol_usd})`);
        console.log(`Positions: ${positions.total_positions}`);
        for (const p of positions.positions) {
          // Step 7 (meridian-wie): null in_range = "no fresh PnL".
          const status: string = p.in_range === true ? "in-range ✓" : p.in_range === false ? "OUT OF RANGE ⚠" : "?? (no fresh PnL)";
          console.log(`  ${p.pair.padEnd(16)} ${status}  fees: ${config.management.solMode ? "◎" : "$"}${p.unclaimed_fees_usd}`);
        }
        console.log();
      });
      return;
    }

    if (input === "/briefing") {
      await runBusy(async () => {
        const briefing: string = await generateBriefing();
        console.log(`\n${briefing.replace(/<[^>]*>/g, "")}\n`);
      });
      return;
    }

    if (input === "/candidates") {
      await runBusy(async () => {
        const { candidates, total_eligible, total_screened }: any = await getTopCandidates({ limit: 5 });
        setLatestCandidates(candidates);
        console.log(`\nTop pools (${total_eligible} eligible from ${total_screened} screened):\n`);
        console.log(formatCandidates(candidates));
        console.log();
      });
      return;
    }

    if (input === "/thresholds") {
      const s: any = config.screening;
      console.log("\nCurrent screening thresholds:");
      console.log(`  minFeeActiveTvlRatio: ${s.minFeeActiveTvlRatio}`);
      console.log(`  minOrganic:           ${s.minOrganic}`);
      console.log(`  minHolders:           ${s.minHolders}`);
      console.log(`  minTvl:               ${s.minTvl}`);
      console.log(`  maxTvl:               ${s.maxTvl}`);
      console.log(`  minVolume:            ${s.minVolume}`);
      console.log(`  minTokenFeesSol:      ${s.minTokenFeesSol}`);
      console.log(`  maxBundlePct:         ${s.maxBundlePct}`);
      console.log(`  maxBotHoldersPct:     ${s.maxBotHoldersPct}`);
      console.log(`  maxTop10Pct:          ${s.maxTop10Pct}`);
      console.log(`  timeframe:            ${s.timeframe}`);
      const perf: any = getPerformanceSummary();
      if (perf) {
        console.log(`\n  Based on ${perf.total_positions_closed} closed positions`);
        console.log(`  Win rate: ${perf.win_rate_pct}%  |  Avg PnL: ${perf.avg_pnl_pct}%`);
      } else {
        console.log("\n  No closed positions yet — thresholds are preset defaults.");
      }
      console.log();
      rl.prompt();
      return;
    }

    if (input.startsWith("/learn")) {
      await runBusy(async () => {
        const parts: string[] = input.split(" ");
        const poolArg: string | null = parts[1] || null;

        let poolsToStudy: any[] = [];

        if (poolArg) {
          poolsToStudy = [{ pool: poolArg, name: poolArg }];
        } else {
          // Fetch top 10 candidates across all eligible pools
          console.log("\nFetching top pool candidates to study...\n");
          const { candidates }: { candidates: any[] } = await getTopCandidates({ limit: 10 });
          if (!candidates.length) {
            console.log("No eligible pools found to study.\n");
            return;
          }
          poolsToStudy = candidates.map((c: any) => ({ pool: c.pool, name: c.name }));
        }

        console.log(`\nStudying top LPers across ${poolsToStudy.length} pools...\n`);
        for (const p of poolsToStudy) console.log(`  • ${p.name || p.pool}`);
        console.log();

        const poolList: string = poolsToStudy
          .map((p: any, i: number) => `${i + 1}. ${p.name} (${p.pool})`)
          .join("\n");

        const { content: reply }: { content: string } = await agentLoop(
          `Study top LPers across these ${poolsToStudy.length} pools by calling study_top_lpers for each:

${poolList}

For each pool, call study_top_lpers then move to the next. After studying all pools:
1. Identify patterns that appear across multiple pools (hold time, scalping vs holding, win rates).
2. Note pool-specific patterns where behaviour differs significantly.
3. Derive 4-8 concrete, actionable lessons using add_lesson. Prioritize cross-pool patterns — they're more reliable.
4. Summarize what you learned.

Focus on: hold duration, entry/exit timing, what win rates look like, whether scalpers or holders dominate.`,
          config.llm.maxSteps,
          [],
          "GENERAL"
        );
        console.log(`\n${reply}\n`);
      });
      return;
    }

    if (input === "/evolve") {
      await runBusy(async () => {
        const perf: any = getPerformanceSummary();
        if (!perf || perf.total_positions_closed < 5) {
          const needed: number = 5 - (perf?.total_positions_closed || 0);
          console.log(`\nNeed at least 5 closed positions to evolve. ${needed} more needed.\n`);
          return;
        }
        const fs: any = await import("fs");
        const { LESSONS_FILE } = await import("./config/paths.js");
        const lessonsData: any = JSON.parse(fs.default.readFileSync(LESSONS_FILE, "utf8"));
        const result: any = evolveThresholds(lessonsData.performance, config);
        if (!result || Object.keys(result.changes).length === 0) {
          console.log("\nNo threshold changes needed — current settings already match performance data.\n");
        } else {
          reloadScreeningThresholds();
          console.log("\nThresholds evolved:");
          for (const [key, val] of Object.entries(result.changes)) {
            console.log(`  ${key}: ${result.rationale[key]}`);
          }
          console.log("\nSaved to user-config.json. Applied immediately.\n");
        }
      });
      return;
    }

    if (input.startsWith("/vp")) {
      await runBusy(async () => {
        if (input === "/vp report") {
          console.log("\nGenerating dry-run report...\n");
          const html: string = await generateDryRunReport();
          const filePath: string = path.join(path.dirname(fileURLToPath(import.meta.url)), "dry-run-report.html");
          fs.writeFileSync(filePath, html, "utf8");
          console.log(`✅ Report saved to ${filePath}\n`);
        } else {
          // Use getMyPositions({force:true}) so the display has FRESH PnL
          // (via Step 3 fresh path) and live in_range — not the stale cached
          // fields. Filter to VPs only.
          const { positions }: { positions: LivePosition[] } = await getMyPositions({ force: true });
          const vps: LivePosition[] = positions.filter((p: LivePosition) => p.position?.startsWith("vp:"));
          if (vps.length === 0) {
            console.log("No open virtual positions.\n");
            return;
          }
          const solFmt: string = config.management.solMode ? "◎" : "$";
          for (const pos of vps) {
            const vpId: string = pos.position.slice(3); // strip "vp:" prefix
            const pnl: string = pos.pnl_pct != null ? `${pos.pnl_pct.toFixed(2)}%` : "?";
            const fees: string = pos.unclaimed_fees_usd != null ? `${solFmt} ${pos.unclaimed_fees_usd.toFixed(2)}` : "?";
            // Step 7 (meridian-wie): null in_range = "no fresh PnL".
            const oor: string = pos.in_range === true ? "🟢 IN" : pos.in_range === false ? "🔴 OOR" : "??";
            console.log(`  ${vpId} | ${pos.pair.padEnd(16)} | PnL: ${pnl.padStart(8)} | fees: ${fees} | ${oor}`);
          }
          console.log();
        }
      });
      return;
    }

    // ── Free-form chat ───────────────────────
    await runBusy(async () => {
      log("user", input);
      const { content }: { content: string } = await agentLoop(input, config.llm.maxSteps, sessionHistory, "GENERAL", config.llm.generalModel, null, { interactive: true });
      appendHistory(input, content);
      console.log(`\n${content}\n`);
    });
  });

  rl.on("close", () => shutdown("stdin closed"));

} else if (isMain) {
  // Non-TTY: start immediately
  log("startup", "Non-TTY mode — starting cron cycles immediately.");
  _launchCron();
  maybeRunMissedBriefing().catch(() => { });
  startPolling(telegramHandler);
  (async () => {
    try {
      await runScreeningCycle({ silent: false });
    } catch (e: any) {
      log("startup_error", e.message);
    }
  })();
}
