import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  trackPosition,
  markOutOfRange,
  markInRange,
  minutesOutOfRange,
  recordClaim,
  recordClose,
  setPositionInstruction,
  queuePeakConfirmation,
  resolvePendingPeak,
  queueTrailingDropConfirmation,
  resolvePendingTrailingDrop,
  getTrackedPosition,
  getTrackedPositions,
} from "../core/state.js";

describe("State machine — trailing TP", () => {
  const POS = "test-pos-001";

  beforeEach(() => {
    // Track a fresh position for each test
    trackPosition({
      position: POS,
      pool: "test-pool",
      pool_name: "TEST-SOL",
      strategy: "spot",
      amount_sol: 1,
      active_bin: 100,
    });
  });

  afterEach(() => {
    // Clean up — mark as closed
    recordClose(POS, "test cleanup");
  });

  describe("queuePeakConfirmation", () => {
    it("queues peak when candidate > current peak", () => {
      const result = queuePeakConfirmation(POS, 10.5);
      expect(result).toBe(true);
      const pos = getTrackedPosition(POS);
      expect(pos?.pending_peak_pnl_pct).toBe(10.5);
    });

    it("rejects when candidate <= current peak", () => {
      queuePeakConfirmation(POS, 10.5);
      const result = queuePeakConfirmation(POS, 10.0);
      expect(result).toBe(false);
    });

    it("accepts immediate mode without pending", () => {
      const result = queuePeakConfirmation(POS, 15.0, { immediate: true });
      expect(result).toBe(true);
      const pos = getTrackedPosition(POS);
      expect(pos?.peak_pnl_pct).toBe(15.0);
      expect(pos?.pending_peak_pnl_pct).toBeNull();
    });

    it("rejects null candidate", () => {
      const result = queuePeakConfirmation(POS, null as any);
      expect(result).toBe(false);
    });

    it("rejects closed position", () => {
      recordClose(POS, "test");
      const result = queuePeakConfirmation(POS, 10.0);
      expect(result).toBe(false);
    });
  });

  describe("resolvePendingPeak", () => {
    it("confirms when current >= pending * tolerance", () => {
      queuePeakConfirmation(POS, 10.0);
      const result = resolvePendingPeak(POS, 9.0, 0.85);
      expect(result.confirmed).toBe(true);
      expect(result.peak).toBeGreaterThanOrEqual(9.0);
    });

    it("rejects when current < pending * tolerance", () => {
      queuePeakConfirmation(POS, 10.0);
      const result = resolvePendingPeak(POS, 5.0, 0.85);
      expect(result.confirmed).toBe(false);
      expect(result.rejected).toBe(true);
    });

    it("clears pending state after resolution", () => {
      queuePeakConfirmation(POS, 10.0);
      resolvePendingPeak(POS, 9.0);
      const pos = getTrackedPosition(POS);
      expect(pos?.pending_peak_pnl_pct).toBeNull();
      expect(pos?.pending_peak_started_at).toBeNull();
    });

    it("returns pending:false when no pending peak", () => {
      const result = resolvePendingPeak(POS, 10.0);
      expect(result.pending).toBe(false);
    });
  });

  describe("queueTrailingDropConfirmation", () => {
    it("queues when drop >= trailingDropPct", () => {
      const result = queueTrailingDropConfirmation(POS, 20.0, 15.0, 5.0);
      expect(result).toBe(true);
      const pos = getTrackedPosition(POS);
      expect(pos?.pending_trailing_peak_pnl_pct).toBe(20.0);
      expect(pos?.pending_trailing_current_pnl_pct).toBe(15.0);
    });

    it("rejects when drop < trailingDropPct", () => {
      const result = queueTrailingDropConfirmation(POS, 20.0, 18.0, 5.0);
      expect(result).toBe(false);
    });

    it("updates if current drop is worse", () => {
      queueTrailingDropConfirmation(POS, 20.0, 15.0, 5.0);
      const result = queueTrailingDropConfirmation(POS, 20.0, 10.0, 5.0);
      expect(result).toBe(true);
      const pos = getTrackedPosition(POS);
      expect(pos?.pending_trailing_current_pnl_pct).toBe(10.0);
    });

    it("rejects null values", () => {
      const result = queueTrailingDropConfirmation(POS, null as any, 15.0, 5.0);
      expect(result).toBe(false);
    });
  });

  describe("resolvePendingTrailingDrop", () => {
    it("confirms when still near crash and still dropped enough", () => {
      queueTrailingDropConfirmation(POS, 20.0, 15.0, 5.0);
      const result = resolvePendingTrailingDrop(POS, 14.0, 5.0, 1.0);
      expect(result.confirmed).toBe(true);
      expect(result.reason).toContain("Trailing TP");
    });

    it("rejects when recovered above pending current", () => {
      queueTrailingDropConfirmation(POS, 20.0, 15.0, 5.0);
      const result = resolvePendingTrailingDrop(POS, 18.0, 5.0, 1.0);
      expect(result.confirmed).toBe(false);
      expect(result.rejected).toBe(true);
    });

    it("clears pending state after resolution", () => {
      queueTrailingDropConfirmation(POS, 20.0, 15.0, 5.0);
      resolvePendingTrailingDrop(POS, 14.0, 5.0);
      const pos = getTrackedPosition(POS);
      expect(pos?.pending_trailing_current_pnl_pct).toBeNull();
      expect(pos?.pending_trailing_peak_pnl_pct).toBeNull();
    });

    it("returns pending:false when no pending drop", () => {
      const result = resolvePendingTrailingDrop(POS, 15.0, 5.0);
      expect(result.pending).toBe(false);
    });
  });
});

describe("State machine — OOR tracking", () => {
  const POS = "test-oor-001";

  beforeEach(() => {
    trackPosition({
      position: POS,
      pool: "test-pool",
      pool_name: "TEST-SOL",
      strategy: "spot",
      amount_sol: 1,
    });
  });

  afterEach(() => {
    recordClose(POS, "test cleanup");
  });

  it("marks out of range", () => {
    markOutOfRange(POS);
    const pos = getTrackedPosition(POS);
    expect(pos?.out_of_range_since).not.toBeNull();
  });

  it("does not re-mark if already OOR", () => {
    markOutOfRange(POS);
    const pos1 = getTrackedPosition(POS);
    const time1 = pos1?.out_of_range_since;
    markOutOfRange(POS);
    const pos2 = getTrackedPosition(POS);
    expect(pos2?.out_of_range_since).toBe(time1);
  });

  it("marks back in range", () => {
    markOutOfRange(POS);
    markInRange(POS);
    const pos = getTrackedPosition(POS);
    expect(pos?.out_of_range_since).toBeNull();
  });

  it("computes minutes out of range", () => {
    // Mark OOR, then wait (simulated by setting time in the past via markOutOfRange)
    markOutOfRange(POS);
    // The function uses Date.now() internally, so we need to check that it returns > 0
    const minutes = minutesOutOfRange(POS);
    expect(minutes).toBeGreaterThanOrEqual(0);
  });
});

describe("State machine — position lifecycle", () => {
  const POS = "test-lifecycle-001";

  it("tracks and retrieves position", () => {
    trackPosition({
      position: POS,
      pool: "test-pool",
      pool_name: "TEST-SOL",
      strategy: "spot",
      amount_sol: 0.5,
    });
    const pos = getTrackedPosition(POS);
    expect(pos).not.toBeNull();
    expect(pos?.pool).toBe("test-pool");
    expect(pos?.amount_sol).toBe(0.5);
    recordClose(POS, "test cleanup");
  });

  it("records claim", () => {
    trackPosition({
      position: POS,
      pool: "test-pool",
      amount_sol: 0.5,
    });
    recordClaim(POS, 1.23);
    const pos = getTrackedPosition(POS);
    expect(pos?.total_fees_claimed_usd).toBe(1.23);
    recordClose(POS, "test cleanup");
  });

  it("sets instruction", () => {
    trackPosition({
      position: POS,
      pool: "test-pool",
      amount_sol: 0.5,
    });
    const result = setPositionInstruction(POS, "hold until 50%");
    expect(result).toBe(true);
    const pos = getTrackedPosition(POS);
    expect(pos?.instruction).toBe("hold until 50%");
    recordClose(POS, "test cleanup");
  });

  it("closes position", () => {
    trackPosition({
      position: POS,
      pool: "test-pool",
      amount_sol: 0.5,
    });
    recordClose(POS, "take profit");
    const pos = getTrackedPosition(POS);
    expect(pos?.closed).toBe(true);
    expect(pos?.closed_at).not.toBeNull();
  });

  it("returns null for nonexistent position", () => {
    const pos = getTrackedPosition("nonexistent-id");
    expect(pos).toBeNull();
  });

  it("getTrackedPositions openOnly excludes closed", () => {
    trackPosition({
      position: POS,
      pool: "test-pool",
      amount_sol: 0.5,
    });
    const before = getTrackedPositions(true);
    const hadOpen = before.some((p) => p.position === POS);
    recordClose(POS, "test cleanup");
    const after = getTrackedPositions(true);
    const hasOpen = after.some((p) => p.position === POS);
    // Should have been open before close, closed after
    expect(hadOpen).toBe(true);
    expect(hasOpen).toBe(false);
  });
});
