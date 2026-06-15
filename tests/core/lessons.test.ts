import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  addLesson,
  pinLesson,
  unpinLesson,
  listLessons,
  removeLessonsByKeyword,
  clearAllLessons,
  clearPerformance,
  evolveThresholds,
  recordPerformance,
  getPerformanceSummary,
} from "../../core/index.js";
import { config } from "../../config/index.js";
import type { PerformanceRecord } from "../../types/index.js";

describe("Lessons CRUD", () => {
  beforeEach(() => {
    clearAllLessons();
    clearPerformance();
  });

  afterEach(() => {
    clearAllLessons();
    clearPerformance();
  });

  it("adding, pinning, listing, filtering, keyword removal", () => {
    // Add unsanitized lesson
    const rawText = "Avoid: <scam> pools\nwith newlines\tand backticks `test`";
    addLesson(rawText, ["scam", "avoid"], { pinned: false });

    const listed = listLessons({ tag: "scam" });
    expect(listed.total).toBe(1);

    // Verify sanitization
    const ruleText = listed.lessons[0].rule;
    expect(ruleText).not.toContain("<");
    expect(ruleText).not.toContain(">");
    expect(ruleText).not.toContain("\n");
    expect(ruleText).not.toContain("`");
    expect(ruleText).toContain("scam pools with newlines and backticks");

    // Pin and unpin
    const id = listed.lessons[0].id;
    const pinResult = pinLesson(id);
    expect(pinResult.found).toBe(true);
    expect(pinResult.pinned).toBe(true);

    const listedPinned = listLessons({ pinned: true });
    expect(listedPinned.total).toBe(1);

    const unpinResult = unpinLesson(id);
    expect(unpinResult.found).toBe(true);
    expect(unpinResult.pinned).toBe(false);

    const listedPinned2 = listLessons({ pinned: true });
    expect(listedPinned2.total).toBe(0);

    // Keyword removal
    addLesson("Test keyword removal for alpha wallets", ["alpha"]);
    expect(listLessons({ tag: "alpha" }).total).toBe(1);

    const removedCount = removeLessonsByKeyword("alpha");
    expect(removedCount).toBe(1);
    expect(listLessons({ tag: "alpha" }).total).toBe(0);
  });
});

describe("recordPerformance", () => {
  beforeEach(() => {
    clearPerformance();
  });

  afterEach(() => {
    clearPerformance();
  });

  it("skips suspiciousUnitMix records", async () => {
    const suspiciousRecord = {
      position: "pk_suspicious_1",
      pool: "Pool1",
      pool_name: "SUSP-SOL",
      base_mint: "MintSuspicious1",
      amount_sol: 0.5,
      initial_value_usd: 85.0,
      final_value_usd: 0.8,
      fees_earned_usd: 0.01,
      minutes_held: 10,
      minutes_in_range: 8,
      close_reason: "OOR too long",
    };

    await recordPerformance(suspiciousRecord);
    expect(getPerformanceSummary()).toBeNull();
  });

  it("skips suspiciousAbsurdClosedPnl records", async () => {
    const absurdRecord = {
      position: "pk_absurd_1",
      pool: "Pool2",
      pool_name: "ABSURD-SOL",
      base_mint: "MintAbsurd1",
      amount_sol: 0.5,
      initial_value_usd: 85.0,
      final_value_usd: 2.0,
      fees_earned_usd: 0.05,
      minutes_held: 20,
      minutes_in_range: 15,
      close_reason: "Manual close",
    };

    await recordPerformance(absurdRecord);
    expect(getPerformanceSummary()).toBeNull();
  });
});

describe("evolveThresholds", () => {
  const originalConfig = JSON.parse(JSON.stringify(config));

  beforeEach(() => {
    config.screening.minFeeActiveTvlRatio = 0.05;
    config.screening.minOrganic = 60;
  });

  afterEach(() => {
    Object.assign(config.screening, originalConfig.screening);
  });

  it("returns null with insufficient data", () => {
    expect(evolveThresholds([], config)).toBeNull();
  });

  it("returns null with less than MIN_EVOLVE_POSITIONS", () => {
    const perf: PerformanceRecord[] = Array(4).fill(null).map((_, i) => ({
      pool: `pool-${i}`,
      pnl_pct: i % 2 === 0 ? 10 : -10,
      fee_tvl_ratio: 0.1,
      organic_score: 70,
    } as PerformanceRecord));
    expect(evolveThresholds(perf, config)).toBeNull();
  });

  it("nudges up minFeeActiveTvlRatio when winners earn high fees", () => {
    const perf: PerformanceRecord[] = [
      { pool: "w1", pnl_pct: 20, fee_tvl_ratio: 0.5, organic_score: 70 } as PerformanceRecord,
      { pool: "w2", pnl_pct: 15, fee_tvl_ratio: 0.4, organic_score: 70 } as PerformanceRecord,
      { pool: "w3", pnl_pct: 10, fee_tvl_ratio: 0.3, organic_score: 70 } as PerformanceRecord,
      { pool: "l1", pnl_pct: -10, fee_tvl_ratio: 0.02, organic_score: 70 } as PerformanceRecord,
      { pool: "l2", pnl_pct: -15, fee_tvl_ratio: 0.01, organic_score: 70 } as PerformanceRecord,
      { pool: "l3", pnl_pct: -20, fee_tvl_ratio: 0.015, organic_score: 70 } as PerformanceRecord,
    ];
    const result = evolveThresholds(perf, config);
    expect(result).not.toBeNull();
    expect(result?.changes.minFeeActiveTvlRatio).toBeGreaterThan(0.05);
  });

  it("nudges up minOrganic when losers have low organic scores", () => {
    const perf: PerformanceRecord[] = [
      { pool: "w1", pnl_pct: 5.0, fee_tvl_ratio: 0.1, organic_score: 85 } as PerformanceRecord,
      { pool: "w2", pnl_pct: 6.0, fee_tvl_ratio: 0.1, organic_score: 85 } as PerformanceRecord,
      { pool: "l1", pnl_pct: -6.0, fee_tvl_ratio: 0.1, organic_score: 65 } as PerformanceRecord,
      { pool: "l2", pnl_pct: -7.0, fee_tvl_ratio: 0.1, organic_score: 65 } as PerformanceRecord,
      { pool: "l3", pnl_pct: -8.0, fee_tvl_ratio: 0.1, organic_score: 65 } as PerformanceRecord,
    ] as any[];
    const result = evolveThresholds(perf, config);
    expect(result).not.toBeNull();
    expect(result?.changes.minOrganic).toBeDefined();
    expect(result!.changes.minOrganic!).toBeGreaterThan(60);
  });

  it("respects MAX_CHANGE_PER_STEP", () => {
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
      const maxAllowed = 0.05 * 1.20;
      expect(result.changes.minFeeActiveTvlRatio).toBeLessThanOrEqual(maxAllowed);
    }
  });
});
