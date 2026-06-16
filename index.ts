import "./utils/secure-env.js";

import fs from "fs";
import readline from "readline";
import path from "path";
import { fileURLToPath } from "url";
import { agentLoop } from "./llm/index.js";
import { log } from "./utils/logger.js";
import { getMyPositions } from "./providers/meteora/index.js";
import { getWalletBalances } from "./providers/solana/index.js";
import { getTopCandidates } from "./providers/meteora/index.js";
import { config, initProviders } from "./config/index.js";
import { executeTool } from "./llm/index.js";
import {
  startPolling,
  stopPolling,
  createLiveMessage,
  telegramHandler,
} from "./interfaces/index.js";
import {
  tryStartScreening,
} from "./core/index.js";
import { toError } from "./utils/errors.js";
import { bootstrapHiveMind, ensureAgentId, startHiveMindBackgroundSync } from "./providers/hivemind/index.js";
import { launchCron as _launchCron, stopCronJobs, initScheduler, maybeRunMissedBriefing } from "./scheduler/index.js";
import { buildPrompt } from "./cli/format.js";
import { busy, setBusy, setTtyInterface } from "./cli/state.js";
import { attachRepl, DEPLOY, formatCandidates, setLatestCandidates, launchCron } from "./cli/repl.js";

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

export async function shutdown(signal: string): Promise<void> {
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

if (isMain && isTTY) {
  const rl: readline.Interface = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: buildPrompt(),
  });
  setTtyInterface(rl);
  launchCron(rl);

  // Update prompt countdown every 10 seconds
  setInterval(() => {
    if (!busy) {
      rl.setPrompt(buildPrompt());
      rl.prompt(true);
    }
  }, 10_000);

  // ── Startup: show wallet + top candidates ──
  console.log(`
╔═══════════════════════════════════════════╗
║         DLMM LP Agent — Ready             ║
╚═══════════════════════════════════════════╝
`);

  console.log("Fetching wallet and top pool candidates...\n");

  setBusy(true);
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
    setBusy(false);
  }

  // Always start autonomous cycles on launch
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
