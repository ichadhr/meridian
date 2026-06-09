import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { config } from "../config/index.js";
import { evolveThresholds, addLesson, listLessons, clearAllLessons } from "../core/lessons.js";
import type { PerformanceRecord } from "../types/index.js";

describe("evolveThresholds", () => {
  const originalConfig = JSON.parse(JSON.stringify(config));

  beforeEach(() => {
    // Reset config to defaults
    config.screening.minFeeActiveTvlRatio = 0.05;
    config.screening.minOrganic = 60;
  });

  afterEach(() => {
    // Restore original config
    Object.assign(config.screening, originalConfig.screening);
    clearAllLessons();
  });

  it("returns null with insufficient data", () => {
    const result = evolveThresholds([], config);
    expect(result).toBeNull();
  });

  it("returns null with less than MIN_EVOLVE_POSITIONS", () => {
    const perf: PerformanceRecord[] = Array(4).fill(null).map((_, i) => ({
      pool: `pool-${i}`,
      pnl_pct: i % 2 === 0 ? 10 : -10,
      fee_tvl_ratio: 0.1,
      organic_score: 70,
    } as PerformanceRecord));
    const result = evolveThresholds(perf, config);
    expect(result).toBeNull();
  });

  it("evolves minFeeActiveTvlRatio when winners have higher fees", () => {
    const perf: PerformanceRecord[] = [
      // Winners with high fees
      { pool: "w1", pnl_pct: 20, fee_tvl_ratio: 0.5, organic_score: 70 } as PerformanceRecord,
      { pool: "w2", pnl_pct: 15, fee_tvl_ratio: 0.4, organic_score: 70 } as PerformanceRecord,
      { pool: "w3", pnl_pct: 10, fee_tvl_ratio: 0.3, organic_score: 70 } as PerformanceRecord,
      // Losers with low fees
      { pool: "l1", pnl_pct: -10, fee_tvl_ratio: 0.02, organic_score: 70 } as PerformanceRecord,
      { pool: "l2", pnl_pct: -15, fee_tvl_ratio: 0.01, organic_score: 70 } as PerformanceRecord,
      { pool: "l3", pnl_pct: -20, fee_tvl_ratio: 0.015, organic_score: 70 } as PerformanceRecord,
    ];
    const result = evolveThresholds(perf, config);
    expect(result).not.toBeNull();
    expect(result?.changes.minFeeActiveTvlRatio).toBeGreaterThan(0.05);
  });

  it("does not evolve when no clear signal", () => {
    const perf: PerformanceRecord[] = [
      { pool: "w1", pnl_pct: 5, fee_tvl_ratio: 0.1, organic_score: 70 } as PerformanceRecord,
      { pool: "w2", pnl_pct: 3, fee_tvl_ratio: 0.1, organic_score: 70 } as PerformanceRecord,
      { pool: "l1", pnl_pct: -2, fee_tvl_ratio: 0.1, organic_score: 70 } as PerformanceRecord,
      { pool: "l2", pnl_pct: -3, fee_tvl_ratio: 0.1, organic_score: 70 } as PerformanceRecord,
      { pool: "l3", pnl_pct: -4, fee_tvl_ratio: 0.1, organic_score: 70 } as PerformanceRecord,
    ];
    const result = evolveThresholds(perf, config);
    // Fees are identical between winners and losers — no strong signal
    // Result may be null or have empty changes
    if (result) {
      // If it changed, the change should be minimal (within MAX_CHANGE_PER_STEP = 0.20)
      const change = Math.abs((result.changes.minFeeActiveTvlRatio ?? 0.05) - 0.05);
      expect(change).toBeLessThan(0.02);
    }
  });

  it("respects MAX_CHANGE_PER_STEP", () => {
    // Create extreme data that would push threshold way up
    const perf: PerformanceRecord[] = [
      { pool: "w1", pnl_pct: 50, fee_tvl_ratio: 2.0, organic_score: 90 } as PerformanceRecord,
      { pool: "w2", pnl_pct: 40, fee_tvl_ratio: 1.8, organic_score: 90 } as PerformanceRecord,
      { pool: "w3", pnl_pct: 30, fee_tvl_ratio: 1.5, organic_score: 90 } as PerformanceRecord,
      { pool: "l1", pnl_pct: -20, fee_tvl_ratio: 0.01, organic_score: 30 } as PerformanceRecord,
      { pool: "l2", pnl_pct: -30, fee_tvl_ratio: 0.005, organic_score: 30 } as PerformanceRecord,
      { pool: "l3", pnl_pct: -40, fee_tvl_ratio: 0.008, organic_score: 30 } as PerformanceRecord,
    ];
    const result = evolveThresholds(perf, config);
    if (result?.changes.minFeeActiveTvlRatio) {
      // MAX_CHANGE_PER_STEP = 0.20, so max change = 0.05 * 0.20 = 0.01
      const maxAllowed = 0.05 * 1.20; // 20% step from current
      expect(result.changes.minFeeActiveTvlRatio).toBeLessThanOrEqual(maxAllowed);
    }
  });
});

describe("Lessons management", () => {
  afterEach(() => {
    clearAllLessons();
  });

  it("adds and lists lessons", () => {
    addLesson("Test lesson", ["test"]);
    const result = listLessons({ limit: 10 });
    expect(result.total).toBeGreaterThanOrEqual(1);
    expect(result.lessons[0].rule).toBe("Test lesson");
  });

  it("clears all lessons", () => {
    addLesson("Lesson 1", ["test"]);
    addLesson("Lesson 2", ["test"]);
    const cleared = clearAllLessons();
    expect(cleared).toBeGreaterThanOrEqual(2);
    const result = listLessons({ limit: 10 });
    expect(result.total).toBe(0);
  });
});
