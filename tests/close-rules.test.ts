import { describe, it, expect } from "vitest";
import { getCloseRule } from "../core/close-rules.js";
import type { CloseRulePosition, CloseRuleConfig } from "../core/close-rules.js";

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
