/**
 * scheduler/index.ts — Cron job management
 *
 * Owns the lifecycle of all scheduled cycles (management, screening, health check,
 * briefing, PnL poller). Directly imports from core/ and interfaces/ — only accepts
 * healthCheckFn to break the llm → executor → scheduler circular dependency.
 */

import cron from "node-cron";
import { config } from "../config/index.js";
import { log } from "../utils/logger.js";
import { bus } from "../utils/events.js";
import {
  generateBriefing,
  runLiveManagementCycle,
  runScreeningCycle,
  tryStartScreening,
  getTrackedPositions,
  getCloseRule,
  managementBusy,
  setManagementBusy,
  screeningBusy,
  timers,
  peakConfirmTimers,
  trailingDropConfirmTimers,
  TRAILING_PEAK_CONFIRM_DELAY_MS,
  TRAILING_PEAK_CONFIRM_TOLERANCE,
  TRAILING_DROP_CONFIRM_DELAY_MS,
  TRAILING_DROP_CONFIRM_TOLERANCE_PCT,
  pollTriggeredAt,
  setPollTriggeredAt,
  getLastBriefingDate,
  setLastBriefingDate,
  resolveLivePendingPeak as resolvePendingPeak,
  resolveLivePendingTrailingDrop as resolvePendingTrailingDrop,
  queueLivePeakConfirmation as queuePeakConfirmation,
  queueLiveTrailingDropConfirmation as queueTrailingDropConfirmation,
  updateLivePnlAndCheckExits as updatePnlAndCheckExits,
} from "../core/index.js";
import { getMyPositions } from "../providers/meteora/index.js";
import {
  isEnabled as telegramEnabled,
  sendLongMessage,
} from "../interfaces/index.js";
import type { ManageDeps } from "../core/live/manage.js";

// ═══════════════════════════════════════════
//  DEPENDENCY INJECTION (health check only)
// ═══════════════════════════════════════════

let _healthCheckFn: (() => Promise<void>) | null = null;

/**
 * Initialize the scheduler. Must be called once at startup.
 * Only healthCheckFn is injected to break the llm → executor → scheduler cycle.
 */
export function initScheduler(opts: { healthCheckFn: () => Promise<void> }): void {
  _healthCheckFn = opts.healthCheckFn;
  bus.removeAllListeners("cron-config-changed");
  bus.on("cron-config-changed", () => restartCronJobs());
}

// ═══════════════════════════════════════════
//  MANAGE DEPS (wired here, not in index.ts)
// ═══════════════════════════════════════════

function shouldUsePnlRecheck(): boolean {
  return !config.api.lpAgentRelayEnabled;
}

function schedulePeakConfirmation(positionAddress: string): void {
  if (!positionAddress || peakConfirmTimers.has(positionAddress)) return;

  const timer = setTimeout(async () => {
    peakConfirmTimers.delete(positionAddress);
    try {
      const result = await getMyPositions({ force: true, silent: true }).catch(() => null);
      const position = result?.positions?.find((p: any) => p.position === positionAddress);
      resolvePendingPeak(positionAddress, position?.pnl_pct ?? null, TRAILING_PEAK_CONFIRM_TOLERANCE);
    } catch (error: any) {
      log("state_warn", `Peak confirmation failed for ${positionAddress}: ${error.message}`);
    }
  }, TRAILING_PEAK_CONFIRM_DELAY_MS);

  peakConfirmTimers.set(positionAddress, timer);
}

function scheduleTrailingDropConfirmation(positionAddress: string): void {
  if (!positionAddress || trailingDropConfirmTimers.has(positionAddress)) return;

  const timer = setTimeout(async () => {
    trailingDropConfirmTimers.delete(positionAddress);
    try {
      const result = await getMyPositions({ force: true, silent: true }).catch(() => null);
      const position = result?.positions?.find((p: any) => p.position === positionAddress);
      const resolved = resolvePendingTrailingDrop(
        positionAddress,
        position?.pnl_pct ?? null,
        config.management.trailingDropPct,
        TRAILING_DROP_CONFIRM_TOLERANCE_PCT,
      );
      if (resolved?.confirmed) {
        log("state", `[Trailing recheck] Confirmed trailing exit for ${positionAddress} — triggering management`);
        runLiveManagementCycle({ silent: true }, manageDeps).catch((e: Error) => log("cron_error", `Trailing recheck management failed: ${e.message}`));
      }
    } catch (error: any) {
      log("state_warn", `Trailing drop confirmation failed for ${positionAddress}: ${error.message}`);
    }
  }, TRAILING_DROP_CONFIRM_DELAY_MS);

  trailingDropConfirmTimers.set(positionAddress, timer);
}

const manageDeps: ManageDeps = {
  shouldUsePnlRecheck,
  schedulePeakConfirmation,
  scheduleTrailingDropConfirmation,
  tryStartScreening,
};

// ═══════════════════════════════════════════
//  BRIEFING
// ═══════════════════════════════════════════

async function runBriefing(): Promise<void> {
  log("cron", "Starting morning briefing");
  try {
    const briefing: string = await generateBriefing();
    if (telegramEnabled()) {
      await sendLongMessage(briefing);
    }
    setLastBriefingDate();
  } catch (error: any) {
    log("cron_error", `Morning briefing failed: ${error.message}`);
  }
}

export async function maybeRunMissedBriefing(): Promise<void> {
  const todayUtc: string = new Date().toISOString().slice(0, 10);
  const lastSent: string | null = getLastBriefingDate();
  if (lastSent === todayUtc) return;
  const nowUtc: Date = new Date();
  const briefingHourUtc: number = 1;
  if (nowUtc.getUTCHours() < briefingHourUtc) return;
  log("cron", `Missed briefing detected (last sent: ${lastSent || "never"}) — sending now`);
  await runBriefing();
}

// ═══════════════════════════════════════════
//  CRON STATE
// ═══════════════════════════════════════════

let _cronTasks: any = [];
export let cronStarted: boolean = false;

// ═══════════════════════════════════════════
//  CRON LIFECYCLE
// ═══════════════════════════════════════════

export function stopCronJobs(): void {
  for (const task of _cronTasks) task.stop();
  if (_cronTasks._pnlPollInterval) clearInterval(_cronTasks._pnlPollInterval);
  _cronTasks = [];
}

export function startCronJobs(): void {
  stopCronJobs(); // stop any running tasks before (re)starting

  const mgmtTask = cron.schedule(`*/${Math.max(1, config.schedule.managementIntervalMin)} * * * *`, async () => {
    if (managementBusy) return;
    timers.managementLastRun = Date.now();
    await runLiveManagementCycle({}, manageDeps);
  });

  const screenTask = cron.schedule(`*/${Math.max(1, config.schedule.screeningIntervalMin)} * * * *`, async () => {
    tryStartScreening("cron");
  });

  const healthTask = cron.schedule(`0 * * * *`, async () => {
    if (managementBusy) return;
    setManagementBusy(true);
    log("cron", "Starting health check");
    try {
      await _healthCheckFn?.();
    } catch (error: any) {
      log("cron_error", `Health check failed: ${error.message}`);
    } finally {
      setManagementBusy(false);
    }
  });

  // Morning Briefing at 8:00 AM UTC+7 (1:00 AM UTC)
  const briefingTask = cron.schedule(`0 1 * * *`, async () => {
    await runBriefing();
  }, { timezone: "UTC" });

  // Every 6h — catch up if briefing was missed (agent restart, crash, etc.)
  const briefingWatchdog = cron.schedule(`0 */6 * * *`, async () => {
    await maybeRunMissedBriefing();
  }, { timezone: "UTC" });

  // Lightweight 30s PnL poller — updates trailing TP state between management cycles, no LLM
  let _pnlPollBusy: boolean = false;
  const pnlPollInterval: NodeJS.Timeout = setInterval(async () => {
    if (managementBusy || screeningBusy || _pnlPollBusy) return;
    if (getTrackedPositions(true).length === 0) return;
    _pnlPollBusy = true;
    try {
      const result: any = await getMyPositions({ force: true, silent: true }).catch(() => null);
      if (!result?.positions?.length) return;
      for (const p of result.positions) {
        if (
          !p.pnl_pct_suspicious &&
          queuePeakConfirmation(p.position, p.pnl_pct, { immediate: !shouldUsePnlRecheck() }) &&
          shouldUsePnlRecheck()
        ) {
          schedulePeakConfirmation(p.position);
        }
        const exit: any = updatePnlAndCheckExits(p.position, p, config.management);
        if (exit) {
          if (exit.action === "TRAILING_TP" && exit.needs_confirmation && shouldUsePnlRecheck()) {
            if (queueTrailingDropConfirmation(p.position, exit.peak_pnl_pct, exit.current_pnl_pct, config.management.trailingDropPct)) {
              scheduleTrailingDropConfirmation(p.position);
            }
            continue;
          }
          const cooldownMs: number = config.schedule.managementIntervalMin * 60 * 1000;
          const sinceLastTrigger: number = Date.now() - pollTriggeredAt;
          if (sinceLastTrigger >= cooldownMs) {
            setPollTriggeredAt(Date.now());
            log("state", `[PnL poll] Exit alert: ${p.pair} — ${exit.reason} — triggering management`);
            runLiveManagementCycle({ silent: true }, manageDeps).catch((e: Error) => log("cron_error", `Poll-triggered management failed: ${e.message}`));
          } else {
            log("state", `[PnL poll] Exit alert: ${p.pair} — ${exit.reason} — cooldown (${Math.round((cooldownMs - sinceLastTrigger) / 1000)}s left)`);
          }
          break;
        }
        const closeRule: any = getCloseRule(p, config.management, p.minutes_out_of_range ?? 0, p.fee_per_tvl_24h);
        if (closeRule) {
          const cooldownMs: number = config.schedule.managementIntervalMin * 60 * 1000;
          const sinceLastTrigger: number = Date.now() - pollTriggeredAt;
          if (sinceLastTrigger >= cooldownMs) {
            setPollTriggeredAt(Date.now());
            log("state", `[PnL poll] Deterministic close rule: ${p.pair} — Rule ${closeRule.rule}: ${closeRule.reason} — triggering management`);
            runLiveManagementCycle({ silent: true }, manageDeps).catch((e: Error) => log("cron_error", `Poll-triggered management failed: ${e.message}`));
          } else {
            log("state", `[PnL poll] Deterministic close rule: ${p.pair} — Rule ${closeRule.rule}: ${closeRule.reason} — cooldown (${Math.round((cooldownMs - sinceLastTrigger) / 1000)}s left)`);
          }
          break;
        }
      }
    } finally {
      _pnlPollBusy = false;
    }
  }, 30_000);

  _cronTasks = [mgmtTask, screenTask, healthTask, briefingTask, briefingWatchdog];
  // Store interval ref so stopCronJobs can clear it
  _cronTasks._pnlPollInterval = pnlPollInterval;
  log("cron", `Cycles started — management every ${config.schedule.managementIntervalMin}m, screening every ${config.schedule.screeningIntervalMin}m`);
}

/**
 * Restart cron jobs (called by executor.ts when intervals change).
 */
export function restartCronJobs(): void {
  if (cronStarted) {
    startCronJobs();
    log("config", `Cron restarted — management: ${config.schedule.managementIntervalMin}m, screening: ${config.schedule.screeningIntervalMin}m`);
  }
}

/**
 * Start cron jobs if not already running. Seeds timers for REPL countdown.
 * Call this from the REPL "go" command or non-TTY startup.
 */
export function launchCron(): void {
  if (!cronStarted) {
    cronStarted = true;
    timers.managementLastRun = Date.now();
    timers.screeningLastRun = Date.now();
    startCronJobs();
  }
}

/**
 * Pause all cron jobs. Telegram control still works.
 */
export function pauseCron(): void {
  stopCronJobs();
  cronStarted = false;
}

/**
 * Resume cron jobs if paused.
 */
export function resumeCron(): void {
  if (!cronStarted) {
    cronStarted = true;
    timers.managementLastRun = Date.now();
    timers.screeningLastRun = Date.now();
    startCronJobs();
  }
}
