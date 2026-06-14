/**
 * Shared mutable state for live cycle management.
 *
 * Keeps active timer registrations (peakConfirmTimers, trailingDropConfirmTimers, and delay configs).
 */

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
