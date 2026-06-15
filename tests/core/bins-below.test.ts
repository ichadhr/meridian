import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { computeBinsBelow } from "../../config/index.js";
import { config } from "../../config/index.js";

describe("computeBinsBelow", () => {
  const original = {
    minBinsBelow: config.strategy.minBinsBelow,
    maxBinsBelow: config.strategy.maxBinsBelow,
  };

  beforeEach(() => {
    config.strategy.minBinsBelow = 35;
    config.strategy.maxBinsBelow = 69;
  });

  afterEach(() => {
    config.strategy.minBinsBelow = original.minBinsBelow;
    config.strategy.maxBinsBelow = original.maxBinsBelow;
  });

  it("throws on zero volatility", () => {
    expect(() => computeBinsBelow(0)).toThrow("Invalid volatility");
  });

  it("throws on negative volatility", () => {
    expect(() => computeBinsBelow(-1)).toThrow("Invalid volatility");
  });

  it("throws on NaN volatility", () => {
    expect(() => computeBinsBelow(NaN)).toThrow("Invalid volatility");
  });

  it("throws on non-numeric volatility", () => {
    expect(() => computeBinsBelow("abc")).toThrow("Invalid volatility");
  });

  it("returns minBinsBelow for low volatility (1)", () => {
    // 35 + (1/5) * (69-35) = 35 + 6.8 = 41.8 → round = 42
    expect(computeBinsBelow(1)).toBe(42);
  });

  it("returns mid range for volatility 2.5", () => {
    // 35 + (2.5/5) * (69-35) = 35 + 17 = 52
    expect(computeBinsBelow(2.5)).toBe(52);
  });

  it("returns maxBinsBelow for high volatility (5+)", () => {
    // 35 + (5/5) * (69-35) = 35 + 34 = 69
    expect(computeBinsBelow(5)).toBe(69);
    expect(computeBinsBelow(10)).toBe(69);
  });

  it("respects custom config bounds", () => {
    config.strategy.minBinsBelow = 20;
    config.strategy.maxBinsBelow = 40;
    // 20 + (2.5/5) * (40-20) = 20 + 10 = 30
    expect(computeBinsBelow(2.5)).toBe(30);
  });
});
