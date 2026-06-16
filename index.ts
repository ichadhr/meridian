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
import { toError } from "./utils/errors.js";
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
import { buildPrompt } from "./cli/format.js";
import { attachRepl, DEPLOY, parseConfigValue, formatCandidates, setLatestCandidates, getLatestCandidatesMeta, describeLatestCandidates, sessionHistory, appendHistory, launchCron } from "./cli/repl.js";
import { renderSettingsMenu, settingButton, settingValue, type AnyObj } from "./interfaces/telegram/menu.js";
import { telegramHandler, showSettingsMenu, applySettingsMenuCallback } from "./interfaces/telegram/handlers.js";

// ── Type helpers ──────────────────────────────────────────────

export interface TelegramMessage {
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
  swFailed?: boolean;
  n: any;
  nFailed?: boolean;
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
//  INTERACTIVE REPL
// ═══════════════════════════════════════════
const isTTY: boolean = process.stdin.isTTY;
export let busy: boolean = false;
const _telegramQueue: TelegramMessage[] = [];
let _ttyInterface: readline.Interface | null = null;

export function setBusy(v: boolean): void { busy = v; }



export async function runDeterministicScreen(limit: number = 5): Promise<string> {
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

export async function deployLatestCandidate(index: number): Promise<{ result: any; candidate: any; deployAmount: number; binsBelow: number }> {
  const meta = getLatestCandidatesMeta();
  const candidate: any = meta.candidates[index];
  if (!candidate) {
    throw new Error("Invalid candidate index. Run /screen first.");
  }
  if (meta.candidates.length === 1) {
    const mint: string | null = candidate.base?.mint || candidate.base_mint || null;
    const [smartWallets, narrative, tokenInfo] = await Promise.allSettled([
      checkSmartWalletsOnPool({ pool_address: candidate.pool }),
      mint ? getTokenNarrative({ mint }) : Promise.resolve(null),
      mint ? getTokenInfo({ query: mint }) : Promise.resolve(null),
    ]);
    const context: Candidate = {
      pool: candidate,
      sw: smartWallets.status === "fulfilled" ? smartWallets.value : null,
      swFailed: smartWallets.status === "rejected",
      n: narrative.status === "fulfilled" ? narrative.value : null,
      nFailed: narrative.status === "rejected",
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

export function refreshPrompt(): void {
  if (!_ttyInterface) return;
  _ttyInterface.setPrompt(buildPrompt());
  _ttyInterface.prompt(true);
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

  } catch (e) {
    console.error(`Startup fetch failed: ${toError(e).message}`);
  } finally {
    busy = false;
  }

  // Always start autonomous cycles on launch
  launchCron(rl);
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

  attachRepl(rl, shutdown);

} else if (isMain) {
  // Non-TTY: start immediately
  log("startup", "Non-TTY mode — starting cron cycles immediately.");
  _launchCron();
  maybeRunMissedBriefing().catch(() => { });
  startPolling(telegramHandler);
  (async () => {
    try {
      tryStartScreening("startup", false);
    } catch (e) {
      log("startup_error", toError(e).message);
    }
  })();
}
