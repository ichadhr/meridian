/**
 * Shared mutable state for cycle management.
 *
 * Exposes locks and timers that are shared across screening and management.
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
export let screeningLastStarted: number = 0; // epoch ms — suppresses duplicate screening cycles

export const SCREENING_COOLDOWN_MS: number = 5 * 60 * 1000; // minimum gap between screening cycles

export function setManagementBusy(v: boolean): void { managementBusy = v; }
export function setScreeningBusy(v: boolean): void { screeningBusy = v; }
export function setScreeningLastStarted(v: number): void { screeningLastStarted = v; }
