import { describe, it, expect } from "vitest";
import {
  normalizeTimeframe,
  getScreeningDefaultsForTimeframe,
  scaleScreeningToTimeframe,
  TIMEFRAME_SCREENING_SCALES,
} from "../../core/index.js";

describe("Screening Scales", () => {
  describe("normalizeTimeframe", () => {
    it("returns valid timeframe in lowercase", () => {
      expect(normalizeTimeframe("5M")).toBe("5m");
      expect(normalizeTimeframe("24h")).toBe("24h");
    });

    it("returns default 4h for invalid timeframe", () => {
      expect(normalizeTimeframe("15m")).toBe("4h");
      expect(normalizeTimeframe(null)).toBe("4h");
      expect(normalizeTimeframe(undefined)).toBe("4h");
    });
  });

  describe("getScreeningDefaultsForTimeframe", () => {
    it("returns default 4h scales when input is invalid", () => {
      const defaults = getScreeningDefaultsForTimeframe("15m");
      expect(defaults).toEqual({
        timeframe: "4h",
        minFeeActiveTvlRatio: 0.8,
        minVolume: 40000,
      });
    });

    it("returns exact timeframe defaults when valid", () => {
      const defaults = getScreeningDefaultsForTimeframe("30m");
      expect(defaults).toEqual({
        timeframe: "30m",
        minFeeActiveTvlRatio: 0.15,
        minVolume: 1000,
      });
    });
  });

  describe("scaleScreeningToTimeframe", () => {
    it("returns minFeeActiveTvlRatio and minVolume", () => {
      const scales = scaleScreeningToTimeframe("5m");
      expect(scales).toEqual({
        minFeeActiveTvlRatio: 0.02,
        minVolume: 500,
      });
    });
  });
});
