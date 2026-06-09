/**
 * Shared mutable state for live cycle management.
 *
 * Breaks circular dependency between core/live/manage.ts and index.ts.
 * Both modules import this instead of directly referencing each other's state.
 */

// ═══════════════════════════════════════════
//  CYCLE TIMERS
// ═══════════════════════════════════════════
export const timers: { managementLastRun: number | null; screeningLastRun: number | null } = {
  managementLastRun: null,
  screeningLastRun: null,
};

// ═══════════════════════════════════════════
//  CYCLE LOCKS
// ═══════════════════════════════════════════
export let managementBusy: boolean = false;
export let screeningBusy: boolean = false;
export let screeningLastTriggered: number = 0; // epoch ms — prevents management from spamming screening

export const SCREENING_COOLDOWN_MS: number = 5 * 60 * 1000; // minimum gap between screening cycles

export function setManagementBusy(v: boolean): void { managementBusy = v; }
export function setScreeningBusy(v: boolean): void { screeningBusy = v; }
export function setScreeningLastTriggered(v: number): void { screeningLastTriggered = v; }

// ═══════════════════════════════════════════
//  POLL-TRIGGERED MANAGEMENT
// ═══════════════════════════════════════════
export let pollTriggeredAt: number = 0;
export function setPollTriggeredAt(v: number): void { pollTriggeredAt = v; }

// ═══════════════════════════════════════════
//  TRAILING TP / PEAK CONFIRMATION TIMERS
// ═══════════════════════════════════════════
export const peakConfirmTimers: Map<string, NodeJS.Timeout> = new Map();
export const trailingDropConfirmTimers: Map<string, NodeJS.Timeout> = new Map();
export const TRAILING_PEAK_CONFIRM_DELAY_MS: number = 15_000;
export const TRAILING_PEAK_CONFIRM_TOLERANCE: number = 0.85;
export const TRAILING_DROP_CONFIRM_DELAY_MS: number = 15_000;
export const TRAILING_DROP_CONFIRM_TOLERANCE_PCT: number = 1.0;
