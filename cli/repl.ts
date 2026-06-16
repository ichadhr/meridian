import fs from "fs";
import readline from "readline";
import path from "path";
import { fileURLToPath } from "url";
import { agentLoop } from "../llm/index.js";
import { log } from "../utils/logger.js";
import { toError } from "../utils/errors.js";
import { config, reloadScreeningThresholds } from "../config/index.js";
import { runScreeningCycle, evolveThresholds, getPerformanceSummary, generateBriefing, generateVpReport as generateDryRunReport } from "../core/index.js";
import { getMyPositions, getTopCandidates } from "../providers/meteora/index.js";
import { getWalletBalances } from "../providers/solana/index.js";
import { buildPrompt } from "./format.js";
import { launchCron as _launchCron, cronStarted as _cronStarted } from "../scheduler/index.js";
import type { LivePosition } from "../types/index.js";

// ── Shared state ──────────────────────────────────────────────
export const DEPLOY: number = config.management.deployAmountSol;

let _busy: boolean = false;
export const sessionHistory: any[] = [];
let _latestCandidates: any[] = [];
let _latestCandidatesAt: string | null = null;

export function setLatestCandidates(candidates: any[] = []): void {
  _latestCandidates = Array.isArray(candidates) ? candidates : [];
  _latestCandidatesAt = new Date().toISOString();
}

export function getLatestCandidatesMeta(): { candidates: any[]; count: number; updatedAt: string | null } {
  return {
    candidates: _latestCandidates,
    count: _latestCandidates.length,
    updatedAt: _latestCandidatesAt,
  };
}

export function describeLatestCandidates(limit: number = 5): string {
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

// ── Formatting ─────────────────────────────────────────────────
export function formatCandidates(candidates: any[]): string {
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

export function parseConfigValue(raw: any): any {
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

// ── Conversation history ───────────────────────────────────────
const MAX_HISTORY: number = 20;

export function appendHistory(userMsg: string, assistantMsg: string): void {
  sessionHistory.push({ role: "user", content: userMsg });
  sessionHistory.push({ role: "assistant", content: assistantMsg });
  if (sessionHistory.length > MAX_HISTORY) {
    sessionHistory.splice(0, sessionHistory.length - MAX_HISTORY);
  }
}

// ── Cron launcher (needs rl for prompt refresh) ────────────────
export function launchCron(rl: readline.Interface): void {
  if (!_cronStarted) {
    _launchCron();
    console.log("Autonomous cycles are now running.\n");
    rl.setPrompt(buildPrompt());
    rl.prompt(true);
  }
}

// ── Attach REPL handlers ──────────────────────────────────────
export function attachRepl(rl: readline.Interface, shutdown: (signal: string) => Promise<void>): void {
  async function runBusy(fn: () => Promise<void>): Promise<void> {
    if (_busy) { console.log("Agent is busy, please wait..."); rl.prompt(); return; }
    _busy = true; rl.pause();
    try { await fn(); }
    catch (e) { console.error(`Error: ${toError(e).message}`); }
    finally { _busy = false; rl.setPrompt(buildPrompt()); rl.resume(); rl.prompt(); }
  }

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
        launchCron(rl);
      });
      return;
    }

    // ── auto: run a screening cycle ─────────
    if (input.toLowerCase() === "auto") {
      await runBusy(async () => {
        console.log("\nRunning screening cycle...\n");
        const reply = await runScreeningCycle({ silent: false, source: "cli-auto" });
        console.log(`\n${reply || "Screening returned no result."}\n`);
        launchCron(rl);
      });
      return;
    }

    // ── go: start cron without deploying ────
    if (input.toLowerCase() === "go") {
      launchCron(rl);
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
        const { LESSONS_FILE } = await import("../config/paths.js");
        const lessonsData: any = JSON.parse(fs.readFileSync(LESSONS_FILE, "utf8"));
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
          const filePath: string = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dry-run-report.html");
          fs.writeFileSync(filePath, html, "utf8");
          console.log(`\u2705 Report saved to ${filePath}\n`);
        } else {
          const { positions }: { positions: LivePosition[] } = await getMyPositions({ force: true });
          const vps: LivePosition[] = positions.filter((p: LivePosition) => p.position?.startsWith("vp:"));
          if (vps.length === 0) {
            console.log("No open virtual positions.\n");
            return;
          }
          const solFmt: string = config.management.solMode ? "\u25CE" : "$";
          for (const pos of vps) {
            const vpId: string = pos.position.slice(3);
            const pnl: string = pos.pnl_pct != null ? `${pos.pnl_pct.toFixed(2)}%` : "?";
            const fees: string = pos.unclaimed_fees_usd != null ? `${solFmt} ${pos.unclaimed_fees_usd.toFixed(2)}` : "?";
            const oor: string = pos.in_range === true ? "\u{1F7E2} IN" : pos.in_range === false ? "\u{1F534} OOR" : "??";
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
}
