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

    it("returns default 5m for invalid timeframe", () => {
      expect(normalizeTimeframe("15m")).toBe("5m");
      expect(normalizeTimeframe(null)).toBe("5m");
      expect(normalizeTimeframe(undefined)).toBe("5m");
    });
  });

  describe("getScreeningDefaultsForTimeframe", () => {
    it("returns default 5m scales when input is invalid", () => {
      const defaults = getScreeningDefaultsForTimeframe("15m");
      expect(defaults).toEqual({
        timeframe: "5m",
        minFeeActiveTvlRatio: 0.02,
        minVolume: 500,
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
