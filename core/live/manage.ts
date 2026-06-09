/**
 * Live management cycle — evaluates open positions, applies deterministic
 * rules, invokes LLM for actions that need judgment.
 *
 * Extracted from index.ts to separate cycle logic from REPL/Telegram wiring.
 */

import { agentLoop } from "../../llm/index.js";
import { log } from "../../utils/logger.js";
import { getMyPositions } from "../../providers/meteora/index.js";
import { config } from "../../config/index.js";
import { sendLongMessage, notifyOutOfRange, isEnabled as telegramEnabled, createLiveMessage } from "../../interfaces/index.js";
import { getCloseRule } from "../close-rules.js";
import { updatePnlAndCheckExits, queuePeakConfirmation, queueTrailingDropConfirmation } from "../state.js";
import { recordPositionSnapshot, recallForPool } from "../pool-memory.js";
import { runVirtualManagementCycle } from "../vp/manage.js";
import { stripThink } from "../../utils/text.js";
import { managementBusy, setManagementBusy, timers } from "./cycle-state.js";
import type { LivePosition, VpResult } from "../../types/index.js";

// ── Types ─────────────────────────────────────────────────────
type AnyObj = Record<string, any>;

/** Dependencies that live in index.ts — avoids circular imports. */
export interface ManageDeps {
  shouldUsePnlRecheck: () => boolean;
  schedulePeakConfirmation: (addr: string) => void;
  scheduleTrailingDropConfirmation: (addr: string) => void;
  tryStartScreening: (source: string, silent?: boolean) => boolean;
}

// ── Management Cycle ──────────────────────────────────────────

export async function runManagementCycle(
  { silent = false }: { silent?: boolean } = {},
  deps: ManageDeps,
): Promise<string | null> {
  if (managementBusy) return null;
  setManagementBusy(true);
  timers.managementLastRun = Date.now();
  log("cron", "Starting management cycle");
  let mgmtReport: string | null = null;
  let positions: LivePosition[] = [];
  let liveMessage: any = null;
  try {
    if (!silent && telegramEnabled()) {
      liveMessage = await createLiveMessage("🔄 Management Cycle", "Evaluating positions...");
    }
    const livePositions: any = await getMyPositions({ force: true }).catch(() => null);
    positions = livePositions?.positions || [];

    if (positions.length === 0) {
      // In dry-run mode, we may still have virtual positions to manage
      const vpEarlyResults: VpResult[] = [];
      if (process.env.DRY_RUN === "true") {
        try {
          const results: VpResult[] = await runVirtualManagementCycle();
          vpEarlyResults.push(...results);
          const vpClosed = results.filter((r: VpResult) => r.action === "CLOSED");
          const vpStay = results.filter((r: VpResult) => r.action === "STAY");
          if (results.length > 0) {
            log("cron", `Virtual positions: ${vpStay.length} active, ${vpClosed.length} closed`);
          }
        } catch (e: any) {
          log("cron_error", `Virtual position management failed: ${e.message}`);
        }
      }
      let report: string = vpEarlyResults.length > 0 ? "" : "No open positions. Triggering screening cycle.";
      if (vpEarlyResults.length > 0) {
        const stayResults = vpEarlyResults.filter((r: VpResult) => r.action === "STAY");
        const vpTotalVal: number = stayResults.reduce((s, r) => s + (r.value_sol ?? r.value_usd ?? 0), 0);
        const vpTotalFees: number = stayResults.reduce((s, r) => s + (r.unclaimed_fees_sol ?? r.unclaimed_fees_usd ?? 0), 0);
        const cur: string = config.management.solMode ? "◎" : "$";
        const vpSummary: string = `💼 ${stayResults.length} VPs | ${cur} ${vpTotalVal.toFixed(4)} | fees: ${cur} ${vpTotalFees.toFixed(4)}`;

        const vpLines: string = vpEarlyResults.map((r: VpResult) => {
          const isSol: boolean = !!config.management.solMode;
          const pnlVal: number = isSol ? (r.pnl_sol_pct ?? 0) : (r.pnl_pct ?? 0);
          const isOor: boolean = typeof r.oor === "string" && r.oor !== "IN";
          const rangeIcon: string = isOor ? "🔴" : "🟢";
          const ageStr: string = r.age_minutes != null ? `Age: ${r.age_minutes}m | ` : "";

          if (r.action === "CLOSED") {
            return `**${r.pair}** | CLOSED: ${r.reason} | PnL: ${pnlVal.toFixed(2)}%`;
          }

          const val: string = isSol ? `◎ ${(r.value_sol ?? 0).toFixed(4)}` : `$ ${(r.value_usd ?? 0).toFixed(2)}`;
          const fees: string = isSol ? `◎ ${(r.unclaimed_fees_sol ?? 0).toFixed(4)}` : `$ ${(r.unclaimed_fees_usd ?? 0).toFixed(2)}`;
          const rAge: number = r.age_minutes ?? 0;
          const yieldVal: string = rAge > 0 && (r.value_sol ?? r.value_usd ?? 0) > 0
            ? (((isSol ? r.unclaimed_fees_sol : r.unclaimed_fees_usd) ?? 0) / (isSol ? (r.value_sol ?? 1) : (r.value_usd ?? 1)) * (1440 / rAge) * 100).toFixed(1)
            : "?";
          return `**${r.pair}** | ${ageStr}Val: ${val} | Unclaimed: ${fees} | Yield: ${yieldVal}% | PnL: ${pnlVal.toFixed(2)}% | ${rangeIcon} ${r.oor} | STAY`;
        }).join("\n");
        report += `\n\n---\n**Virtual Positions**\n\n${vpLines}\n\n${vpSummary}`;
      }
      mgmtReport = report;
      deps.tryStartScreening("mgmt-no-positions");
      return mgmtReport;
    }

    // Snapshot + load pool memory.
    const positionData: LivePosition[] = positions.map((p: LivePosition) => {
      recordPositionSnapshot(p.pool, p as any);
      return { ...p, recall: recallForPool(p.pool) };
    });
    const liveLivePositionData: LivePosition[] = positionData.filter((p: LivePosition) => !p.position?.startsWith?.("vp:"));

    // JS trailing TP check (live positions only)
    const exitMap: Map<string, string> = new Map();
    for (const p of liveLivePositionData) {
      if (
        !p.pnl_pct_suspicious &&
        queuePeakConfirmation(p.position, p.pnl_pct as number, { immediate: !deps.shouldUsePnlRecheck() }) &&
        deps.shouldUsePnlRecheck()
      ) {
        deps.schedulePeakConfirmation(p.position);
      }
      const exit: any = updatePnlAndCheckExits(p.position, p as any, config.management);
      if (exit) {
        if (exit.action === "TRAILING_TP" && exit.needs_confirmation && deps.shouldUsePnlRecheck()) {
          if (queueTrailingDropConfirmation(p.position, exit.peak_pnl_pct, exit.current_pnl_pct, config.management.trailingDropPct)) {
            deps.scheduleTrailingDropConfirmation(p.position);
          }
          continue;
        }
        exitMap.set(p.position, exit.reason);
        log("state", `Exit alert for ${p.pair}: ${exit.reason}`);
      }
    }

    // ── Deterministic rule checks (no LLM) ──────────────────────────
    const actionMap: Map<string, AnyObj> = new Map();
    for (const p of liveLivePositionData) {
      if (exitMap.has(p.position)) {
        actionMap.set(p.position, { action: "CLOSE", rule: "exit", reason: exitMap.get(p.position) });
        continue;
      }
      if (p.instruction) {
        actionMap.set(p.position, { action: "INSTRUCTION" });
        continue;
      }

      const closeRule: AnyObj | null = getCloseRule(p, config.management, p.minutes_out_of_range ?? 0, p.fee_per_tvl_24h);
      if (closeRule) {
        actionMap.set(p.position, closeRule);
        continue;
      }
      if ((p.unclaimed_fees_usd ?? 0) >= config.management.minClaimAmount) {
        actionMap.set(p.position, { action: "CLAIM" });
        continue;
      }
      actionMap.set(p.position, { action: "STAY" });
    }

    // ── Build JS report (live positions only) ──
    const totalValue: number = liveLivePositionData.reduce((s, p) => s + (p.total_value_usd ?? 0), 0);
    const totalUnclaimed: number = liveLivePositionData.reduce((s, p) => s + (p.unclaimed_fees_usd ?? 0), 0);

    const reportLines: string[] = liveLivePositionData.map((p: LivePosition) => {
      const act: AnyObj = actionMap.get(p.position)!;
      const inRange = p.in_range === true ? "🟢 IN" : p.in_range === false ? `🔴 OOR ${p.minutes_out_of_range ?? 0}m` : "??";
      const val = config.management.solMode ? `◎ ${p.total_value_usd ?? "?"}` : `$ ${p.total_value_usd ?? "?"}`;
      const unclaimed = config.management.solMode ? `◎ ${p.unclaimed_fees_usd ?? "?"}` : `$ ${p.unclaimed_fees_usd ?? "?"}`;
      const statusLabel = act.action === "INSTRUCTION" ? "HOLD (instruction)" : act.action;
      let line = `**${p.pair}** | Age: ${p.age_minutes ?? "?"}m | Val: ${val} | Unclaimed: ${unclaimed} | PnL: ${p.pnl_pct ?? "?"}% | Yield: ${p.fee_per_tvl_24h ?? "?"}% | ${inRange} | ${statusLabel}`;
      if (p.instruction) line += `\nNote: "${p.instruction}"`;
      if (act.action === "CLOSE" && act.rule === "exit") line += `\n⚡ Trailing TP: ${act.reason}`;
      if (act.action === "CLOSE" && act.rule && act.rule !== "exit") line += `\nRule ${act.rule}: ${act.reason}`;
      if (act.action === "CLAIM") line += `\n→ Claiming fees`;
      return line;
    });

    const needsAction = [...actionMap.values()].filter((a: AnyObj) => a.action !== "STAY");
    const actionSummary: string = needsAction.length > 0
      ? needsAction.map((a: AnyObj) => a.action === "INSTRUCTION" ? "EVAL instruction" : `${a.action}${a.reason ? ` (${a.reason})` : ""}`).join(", ")
      : "no action";

    const cur: string = config.management.solMode ? "◎" : "$";
    mgmtReport = reportLines.join("\n\n") +
      `\n\nSummary: 💼 ${liveLivePositionData.length} positions | ${cur} ${totalValue.toFixed(4)} | fees: ${cur} ${totalUnclaimed.toFixed(4)} | ${actionSummary}`;

    // ── Call LLM only if action needed (live positions only) ─────────
    const actionLivePositions: LivePosition[] = liveLivePositionData.filter((p: LivePosition) => {
      const a: AnyObj = actionMap.get(p.position)!;
      return a.action !== "STAY";
    });

    if (actionLivePositions.length > 0) {
      log("cron", `Management: ${actionLivePositions.length} action(s) needed — invoking LLM [model: ${config.llm.managementModel}]`);

      const actionBlocks: string = actionLivePositions.map((p: LivePosition) => {
        const act: AnyObj = actionMap.get(p.position)!;
        return [
          `POSITION: ${p.pair} (${p.position})`,
          `  pool: ${p.pool}`,
          `  action: ${act.action}${act.rule && act.rule !== "exit" ? ` — Rule ${act.rule}: ${act.reason}` : ""}${act.rule === "exit" ? ` — ⚡ Trailing TP: ${act.reason}` : ""}`,
          `  pnl_pct: ${p.pnl_pct}% | unclaimed_fees: ${cur} ${p.unclaimed_fees_usd} | value: ${cur} ${p.total_value_usd} | fee_per_tvl_24h: ${p.fee_per_tvl_24h ?? "?"}%`,
          `  bins: lower=${p.lower_bin} upper=${p.upper_bin} active=${p.active_bin} | oor_minutes: ${p.minutes_out_of_range ?? 0}`,
          p.instruction ? `  instruction: "${p.instruction}"` : null,
        ].filter(Boolean).join("\n");
      }).join("\n\n");

      const { content }: { content: string } = await agentLoop(`
MANAGEMENT ACTION REQUIRED — ${actionLivePositions.length} position(s)

${actionBlocks}

RULES:
- CLOSE: call close_position only — it handles fee claiming internally, do NOT call claim_fees first
- CLAIM: call claim_fees with position address
- INSTRUCTION: evaluate the instruction condition. If met → close_position. If not → HOLD, do nothing.
- ⚡ exit alerts: close immediately, no exceptions

Execute the required actions. Do NOT re-evaluate CLOSE/CLAIM — rules already applied. Just execute.
After executing, write a brief one-line result per position.
      `, config.llm.maxSteps, [], "MANAGER", config.llm.managementModel, 2048, {
        onToolStart: async ({ name }: { name: string }) => { await liveMessage?.toolStart(name); },
        onToolFinish: async ({ name, result, success }: { name: string; result: any; success: boolean }) => { await liveMessage?.toolFinish(name, result, success); },
      });

      mgmtReport += `\n\n${content}`;
    } else {
      log("cron", "Management: all positions STAY — skipping LLM");
      await liveMessage?.note("No tool actions needed.");
    }

    // ── Virtual positions management (deterministic, no LLM) ──────
    const vpResults: VpResult[] = [];
    if (process.env.DRY_RUN === "true") {
      try {
        const results: VpResult[] = await runVirtualManagementCycle();
        vpResults.push(...results);
        const vpClosed = results.filter((r: VpResult) => r.action === "CLOSED");
        const vpStay = results.filter((r: VpResult) => r.action === "STAY");
        if (results.length > 0) {
          log("cron", `Virtual positions: ${vpStay.length} active, ${vpClosed.length} closed`);
        }
      } catch (e: any) {
        log("cron_error", `Virtual position management failed: ${e.message}`);
      }
    }

    if (liveLivePositionData.length === 0) mgmtReport = "";

    if (vpResults.length > 0) {
      const stayResults = vpResults.filter((r: VpResult) => r.action === "STAY");
      const vpTotalVal: number = stayResults.reduce((s, r) => s + (r.value_sol ?? r.value_usd ?? 0), 0);
      const vpTotalFees: number = stayResults.reduce((s, r) => s + (r.unclaimed_fees_sol ?? r.unclaimed_fees_usd ?? 0), 0);
      const vpSummary: string = `💼 ${stayResults.length} VPs | ${cur} ${vpTotalVal.toFixed(4)} | fees: ${cur} ${vpTotalFees.toFixed(4)}`;

      const vpLines: string = vpResults.map((r: VpResult) => {
        const isSol: boolean = !!config.management.solMode;
        const pnlVal: number = isSol ? (r.pnl_sol_pct ?? 0) : (r.pnl_pct ?? 0);
        const isOor: boolean = typeof r.oor === "string" && r.oor !== "IN";
        const rangeIcon: string = isOor ? "🔴" : "🟢";
        const ageStr: string = r.age_minutes != null ? `Age: ${r.age_minutes}m | ` : "";

        if (r.action === "CLOSED") {
          return `**${r.pair}** | CLOSED: ${r.reason} | PnL: ${pnlVal.toFixed(2)}%`;
        }

        const val: string = isSol ? `◎ ${(r.value_sol ?? 0).toFixed(4)}` : `$ ${(r.value_usd ?? 0).toFixed(2)}`;
        const fees: string = isSol ? `◎ ${(r.unclaimed_fees_sol ?? 0).toFixed(4)}` : `$ ${(r.unclaimed_fees_usd ?? 0).toFixed(2)}`;
        const rAge2: number = r.age_minutes ?? 0;
        const yieldVal: string = rAge2 > 0 && (r.value_sol ?? r.value_usd ?? 0) > 0
          ? (((isSol ? r.unclaimed_fees_sol : r.unclaimed_fees_usd) ?? 0) / (isSol ? (r.value_sol ?? 1) : (r.value_usd ?? 1)) * (1440 / rAge2) * 100).toFixed(1)
          : "?";
        return `**${r.pair}** | ${ageStr}Val: ${val} | Unclaimed: ${fees} | Yield: ${yieldVal}% | PnL: ${pnlVal.toFixed(2)}% | ${rangeIcon} ${r.oor} | STAY`;
      }).join("\n");
      mgmtReport += `\n\n---\n**Virtual Positions**\n\n${vpLines}\n\n${vpSummary}`;
    }

    // Trigger screening after management
    const afterLivePositions: any = await getMyPositions({ force: true }).catch(() => null);
    const afterCount: number = afterLivePositions?.positions?.length ?? 0;
    if (afterCount < config.risk.maxPositions) {
      deps.tryStartScreening("mgmt-post-management");
    }
  } catch (error: any) {
    log("cron_error", `Management cycle failed: ${error.message}`);
    mgmtReport = `Management cycle failed: ${error.message}`;
  } finally {
    setManagementBusy(false);
    if (!silent && telegramEnabled()) {
      if (mgmtReport) {
        if (liveMessage) await liveMessage.finalize(stripThink(mgmtReport)).catch(() => {});
        else sendLongMessage(`🔄 Management Cycle\n\n${stripThink(mgmtReport)}`).catch(() => { });
      }
      for (const p of positions) {
        if (p.in_range === false && p.minutes_out_of_range >= config.management.outOfRangeWaitMinutes) {
          notifyOutOfRange({ pair: p.pair, minutesOOR: p.minutes_out_of_range }).catch(() => { });
        }
      }
    }
  }
  return mgmtReport;
}
