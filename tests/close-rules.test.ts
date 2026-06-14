import { describe, it, expect } from "vitest";
import { getCloseRule } from "../core/index.js";
import type { CloseRulePosition, CloseRuleConfig } from "../core/index.js";

const baseConfig: CloseRuleConfig = {
  stopLossPct: -20,
  takeProfitPct: 50,
  outOfRangeWaitMinutes: 30,
  outOfRangeBinsToClose: 5,
  minFeePerTvl24h: 7,
  minAgeBeforeYieldCheck: 60,
  vpTrendExitCycles: 3,
  solMode: true,
};

// Use a high fee_per_tvl_24h (10) for tests where we DON'T want Rule 5 to trigger
const highFee = 10;
// Use a low fee_per_tvl_24h (0.01) for tests where we DO want Rule 5 to trigger
const lowFee = 0.01;

function pos(overrides: Partial<CloseRulePosition> = {}): CloseRulePosition {
  return {
    upper_bin: 100,
    active_bin: 90,
    pnl_pct: 5,
    total_value_usd: 100,
    unclaimed_fees_usd: 10,
    deployed_at: new Date(Date.now() - 30 * 60_000).toISOString(), // 30 min ago (below minAge)
    snapshots: [],
    ...overrides,
  };
}

describe("getCloseRule", () => {
  describe("Rule 1: Stop-loss", () => {
    it("closes when pnl_pct <= stopLossPct", () => {
      const result = getCloseRule(pos({ pnl_pct: -25 }), baseConfig, 0, highFee);
      expect(result).toEqual({ action: "CLOSE", rule: 1, reason: "stop loss" });
    });

    it("stays when pnl_pct > stopLossPct", () => {
      const result = getCloseRule(pos({ pnl_pct: -10 }), baseConfig, 0, highFee);
      expect(result).toBeNull();
    });

    it("skips when pnl_pct is null", () => {
      const result = getCloseRule(pos({ pnl_pct: null }), baseConfig, 0, highFee);
      expect(result).toBeNull();
    });

    it("skips when pnl is suspect (huge negative + value exists)", () => {
      const result = getCloseRule(
        pos({ pnl_pct: -95, total_value_usd: 50 }),
        baseConfig,
        0,
        highFee,
      );
      expect(result).toBeNull();
    });
  });

  describe("Rule 2: Take-profit", () => {
    it("closes when pnl_pct >= takeProfitPct", () => {
      const result = getCloseRule(pos({ pnl_pct: 55 }), baseConfig, 0, highFee);
      expect(result).toEqual({ action: "CLOSE", rule: 2, reason: "take profit" });
    });

    it("stays when pnl_pct < takeProfitPct", () => {
      const result = getCloseRule(pos({ pnl_pct: 40 }), baseConfig, 0, highFee);
      expect(result).toBeNull();
    });

    it("skips when takeProfitPct is undefined", () => {
      const result = getCloseRule(
        pos({ pnl_pct: 100 }),
        { ...baseConfig, takeProfitPct: undefined },
        0,
        highFee,
      );
      expect(result).toBeNull();
    });
  });

  describe("Rule 3: Pumped above range", () => {
    it("closes when active_bin > upper_bin + outOfRangeBinsToClose", () => {
      const result = getCloseRule(
        pos({ active_bin: 106, upper_bin: 100 }),
        baseConfig,
        0,
        highFee,
      );
      expect(result).toEqual({ action: "CLOSE", rule: 3, reason: "pumped far above range" });
    });

    it("stays at boundary (active_bin === upper_bin + outOfRangeBinsToClose)", () => {
      // Condition is > not >=, so exactly at boundary should NOT trigger
      const result = getCloseRule(
        pos({ active_bin: 105, upper_bin: 100 }),
        baseConfig,
        0,
        highFee,
      );
      expect(result).toBeNull();
    });

    it("stays when active_bin is within range", () => {
      const result = getCloseRule(
        pos({ active_bin: 103, upper_bin: 100 }),
        baseConfig,
        0,
        highFee,
      );
      expect(result).toBeNull();
    });
  });

  describe("Rule 4: Out-of-range timeout", () => {
    it("closes when OOR and minutes >= wait threshold", () => {
      const result = getCloseRule(
        pos({ active_bin: 101, upper_bin: 100 }),
        baseConfig,
        35,
        highFee,
      );
      expect(result).toEqual({ action: "CLOSE", rule: 4, reason: "OOR" });
    });

    it("closes at boundary (minutes === wait threshold)", () => {
      const result = getCloseRule(
        pos({ active_bin: 101, upper_bin: 100 }),
        baseConfig,
        30,
        highFee,
      );
      expect(result).toEqual({ action: "CLOSE", rule: 4, reason: "OOR" });
    });

    it("stays when OOR but minutes < wait threshold", () => {
      const result = getCloseRule(
        pos({ active_bin: 101, upper_bin: 100 }),
        baseConfig,
        20,
        highFee,
      );
      expect(result).toBeNull();
    });

    it("stays when within range (active_bin <= upper_bin)", () => {
      const result = getCloseRule(
        pos({ active_bin: 100, upper_bin: 100 }),
        baseConfig,
        100,
        highFee,
      );
      expect(result).toBeNull();
    });
  });

  describe("Rule 5: Low yield", () => {
    it("closes when fee_per_tvl_24h < minFeePerTvl24h and age > minAge", () => {
      const oldPos = pos({
        deployed_at: new Date(Date.now() - 120 * 60_000).toISOString(),
        total_value_usd: 100,
      });
      const result = getCloseRule(oldPos, baseConfig, 0, lowFee);
      expect(result).toEqual({ action: "CLOSE", rule: 5, reason: "low yield" });
    });

    it("closes when fee_per_tvl_24h is 0 (zero yield)", () => {
      const oldPos = pos({
        deployed_at: new Date(Date.now() - 120 * 60_000).toISOString(),
        total_value_usd: 100,
      });
      // 0 < minFeePerTvl24h (7) → should close
      const result = getCloseRule(oldPos, baseConfig, 0, 0);
      expect(result).toEqual({ action: "CLOSE", rule: 5, reason: "low yield" });
    });

    it("stays when fee_per_tvl_24h >= minFeePerTvl24h", () => {
      const oldPos = pos({
        deployed_at: new Date(Date.now() - 120 * 60_000).toISOString(),
        total_value_usd: 100,
      });
      const result = getCloseRule(oldPos, baseConfig, 0, 10);
      expect(result).toBeNull();
    });

    it("skips when age < minAgeBeforeYieldCheck", () => {
      // pos() default is 30 min ago, minAge is 60 min
      const result = getCloseRule(pos(), baseConfig, 0, lowFee);
      expect(result).toBeNull();
    });

    it("skips when total_value_usd is 0", () => {
      const oldPos = pos({
        deployed_at: new Date(Date.now() - 120 * 60_000).toISOString(),
        total_value_usd: 0,
      });
      const result = getCloseRule(oldPos, baseConfig, 0, lowFee);
      expect(result).toBeNull();
    });
  });

  describe("Rule 5 (VP synthetic yield)", () => {
    it("computes synthetic yield when fee_per_tvl_24h is undefined (VP)", () => {
      const oldPos = pos({
        deployed_at: new Date(Date.now() - 120 * 60_000).toISOString(),
        unclaimed_fees_usd: 5,
        total_value_usd: 100,
      });
      // synthetic = (5 / 100) * (1440 / 120) * 100 = 60%
      // 60% > minFeePerTvl24h (7) → should stay
      const result = getCloseRule(oldPos, baseConfig, 0, undefined);
      expect(result).toBeNull();
    });

    it("closes VP when synthetic yield is too low", () => {
      const oldPos = pos({
        deployed_at: new Date(Date.now() - 120 * 60_000).toISOString(),
        unclaimed_fees_usd: 0.1,
        total_value_usd: 100,
      });
      // synthetic = (0.1 / 100) * (1440 / 120) * 100 = 1.2%
      // 1.2% < minFeePerTvl24h (7) → close
      const result = getCloseRule(oldPos, baseConfig, 0, undefined);
      expect(result).toEqual({ action: "CLOSE", rule: 5, reason: "low yield" });
    });

    it("skips Rule 5 when fee_per_tvl_24h is null (live SDK failed)", () => {
      const oldPos = pos({
        deployed_at: new Date(Date.now() - 120 * 60_000).toISOString(),
        unclaimed_fees_usd: 0,
        total_value_usd: 100,
      });
      const result = getCloseRule(oldPos, baseConfig, 0, null);
      expect(result).toBeNull();
    });
  });

  describe("Rule 6: Consecutive down trend (VP only)", () => {
    it("closes on 3 consecutive down snapshots", () => {
      const snapshots = [
        { pnl_pct: -5 },
        { pnl_pct: -8 },
        { pnl_pct: -10 },
        { pnl_pct: -12 },
      ];
      const result = getCloseRule(pos({ snapshots }), baseConfig, 0, highFee);
      expect(result).toEqual({
        action: "CLOSE",
        rule: 6,
        reason: "consecutive down-trend (3 cycles)",
      });
    });

    it("uses pnl_sol_pct when solMode is true", () => {
      const snapshots = [
        { pnl_sol_pct: -5 },
        { pnl_sol_pct: -8 },
        { pnl_sol_pct: -10 },
        { pnl_sol_pct: -12 },
      ];
      const result = getCloseRule(pos({ snapshots }), baseConfig, 0, highFee);
      expect(result).toEqual({
        action: "CLOSE",
        rule: 6,
        reason: "consecutive down-trend (3 cycles)",
      });
    });

    it("stays when trend is not strictly down", () => {
      const snapshots = [
        { pnl_pct: -5 },
        { pnl_pct: -3 },
        { pnl_pct: -8 },
        { pnl_pct: -12 },
      ];
      const result = getCloseRule(pos({ snapshots }), baseConfig, 0, highFee);
      expect(result).toBeNull();
    });

    it("skips when current pnl is not negative", () => {
      const snapshots = [
        { pnl_pct: -5 },
        { pnl_pct: -3 },
        { pnl_pct: -1 },
        { pnl_pct: 1 },
      ];
      const result = getCloseRule(pos({ snapshots }), baseConfig, 0, highFee);
      expect(result).toBeNull();
    });

    it("skips when not enough snapshots", () => {
      const snapshots = [{ pnl_pct: -5 }, { pnl_pct: -8 }];
      const result = getCloseRule(pos({ snapshots }), baseConfig, 0, highFee);
      expect(result).toBeNull();
    });
  });

  describe("Guard: corrupted state", () => {
    it("returns null when upper_bin is null", () => {
      const result = getCloseRule(pos({ upper_bin: null }), baseConfig, 0, highFee);
      expect(result).toBeNull();
    });

    it("returns null when active_bin is null", () => {
      const result = getCloseRule(pos({ active_bin: null }), baseConfig, 0, highFee);
      expect(result).toBeNull();
    });
  });

  describe("Rule 7: Chart indicator exit", () => {
    const oldEnough = new Date(Date.now() - 30 * 60_000).toISOString(); // 30 min
    const tooYoung = new Date(Date.now() - 5 * 60_000).toISOString(); // 5 min

    it("closes when chart exit confirmed and position is old enough", () => {
      const result = getCloseRule(
        pos({ deployed_at: oldEnough }),
        { ...baseConfig, chartExitConfirmed: true, chartExitMinAgeMinutes: 20, chartExitPreset: "supertrend_break" },
        0,
        highFee,
      );
      expect(result).toEqual({ action: "CLOSE", rule: 7, reason: "chart indicator exit (supertrend_break)" });
    });

    it("does NOT close when chart exit not confirmed", () => {
      const result = getCloseRule(
        pos({ deployed_at: oldEnough }),
        { ...baseConfig, chartExitConfirmed: false, chartExitMinAgeMinutes: 20 },
        0,
        highFee,
      );
      expect(result).toBeNull();
    });

    it("does NOT close when position is too young", () => {
      const result = getCloseRule(
        pos({ deployed_at: tooYoung }),
        { ...baseConfig, chartExitConfirmed: true, chartExitMinAgeMinutes: 20 },
        0,
        highFee,
      );
      expect(result).toBeNull();
    });

    it("uses default min age of 20 minutes when not specified", () => {
      const result = getCloseRule(
        pos({ deployed_at: new Date(Date.now() - 25 * 60_000).toISOString() }),
        { ...baseConfig, chartExitConfirmed: true },
        0,
        highFee,
      );
      expect(result?.rule).toBe(7);
    });

    it("has lowest priority — Rule 1 (stop loss) takes precedence", () => {
      const result = getCloseRule(
        pos({ deployed_at: oldEnough, pnl_pct: -30 }), // triggers Rule 1
        { ...baseConfig, chartExitConfirmed: true, chartExitMinAgeMinutes: 20 },
        0,
        highFee,
      );
      expect(result?.rule).toBe(1);
    });

    it("has lowest priority — Rule 5 (low yield) takes precedence", () => {
      const oldEnoughForYield = new Date(Date.now() - 90 * 60_000).toISOString(); // 90 min (>60 min threshold)
      const result = getCloseRule(
        pos({ deployed_at: oldEnoughForYield, pnl_pct: 5 }),
        { ...baseConfig, chartExitConfirmed: true, chartExitMinAgeMinutes: 20 },
        0,
        lowFee, // triggers Rule 5
      );
      expect(result?.rule).toBe(5);
    });

    it("has lowest priority — Rule 6 (trend) takes precedence", () => {
      const snapshots = [
        { pnl_pct: 0 }, { pnl_pct: -3 }, { pnl_pct: -6 }, { pnl_pct: -9 },
      ];
      const result = getCloseRule(
        pos({ deployed_at: oldEnough, snapshots, pnl_pct: -9 }),
        { ...baseConfig, chartExitConfirmed: true, chartExitMinAgeMinutes: 20 },
        0,
        highFee,
      );
      expect(result?.rule).toBe(6);
    });

    it("does NOT close when deployed_at is null", () => {
      const result = getCloseRule(
        pos({ deployed_at: null }),
        { ...baseConfig, chartExitConfirmed: true, chartExitMinAgeMinutes: 20 },
        0,
        highFee,
      );
      expect(result).toBeNull();
    });

    it("does NOT close when deployed_at is undefined", () => {
      const result = getCloseRule(
        pos({ deployed_at: undefined }),
        { ...baseConfig, chartExitConfirmed: true, chartExitMinAgeMinutes: 20 },
        0,
        highFee,
      );
      expect(result).toBeNull();
    });

    it("boundary: closes at exactly min age", () => {
      const exactAge = new Date(Date.now() - 20 * 60_000).toISOString();
      const result = getCloseRule(
        pos({ deployed_at: exactAge }),
        { ...baseConfig, chartExitConfirmed: true, chartExitMinAgeMinutes: 20 },
        0,
        highFee,
      );
      expect(result?.rule).toBe(7);
    });

    it("boundary: min age 0 allows immediate exit", () => {
      const result = getCloseRule(
        pos({ deployed_at: new Date().toISOString() }),
        { ...baseConfig, chartExitConfirmed: true, chartExitMinAgeMinutes: 0 },
        0,
        highFee,
      );
      expect(result?.rule).toBe(7);
    });

    it("uses default preset name when not specified", () => {
      const result = getCloseRule(
        pos({ deployed_at: oldEnough }),
        { ...baseConfig, chartExitConfirmed: true, chartExitMinAgeMinutes: 20 },
        0,
        highFee,
      );
      expect(result?.reason).toBe("chart indicator exit (supertrend_break)");
    });
  });

  describe("Default: STAY", () => {
    it("returns null when no rules trigger", () => {
      const result = getCloseRule(
        pos({ pnl_pct: 10, active_bin: 95, upper_bin: 100 }),
        baseConfig,
        5,
        highFee,
      );
      expect(result).toBeNull();
    });
  });
});
