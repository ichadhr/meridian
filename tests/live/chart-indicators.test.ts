/**
 * Test: Chart Indicators evaluation presets (chart-indicators.ts)
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { confirmIndicatorPreset } from "../../providers/hivemind/index.js";
import { config } from "../../config/index.js";

// ── Mock fetch Helper ───────────────────────────────────────────
async function withMockedIndicators(
  payloads: Record<string, any>,
  fn: () => Promise<void>
): Promise<void> {
  const orig = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url: any) => {
    const urlStr = String(url);
    let matchedInterval = "5_MINUTE";
    if (urlStr.includes("interval=15_MINUTE")) matchedInterval = "15_MINUTE";

    const data = payloads[matchedInterval] || {};
    return {
      ok: true,
      text: async () => JSON.stringify(data),
    } as any;
  }) as any;

  try {
    await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

describe("Chart Indicators presets", () => {
  const origEnabled = config.indicators.enabled;
  const origRsiOversold = config.indicators.rsiOversold;
  const origRsiOverbought = config.indicators.rsiOverbought;
  const origRequireAll = config.indicators.requireAllIntervals;

  afterEach(() => {
    config.indicators.enabled = origEnabled;
    config.indicators.rsiOversold = origRsiOversold;
    config.indicators.rsiOverbought = origRsiOverbought;
    config.indicators.requireAllIntervals = origRequireAll;
  });

  it("supertrend_break: entry triggers on bullish flip or direction", async () => {
    config.indicators.enabled = true;
    config.indicators.rsiOversold = 30;
    config.indicators.rsiOverbought = 80;
    config.indicators.requireAllIntervals = false;

    // 1. Bullish flip (supertrendBreakUp = true)
    const payloadFlip = {
      "5_MINUTE": {
        latest: {
          candle: { close: 100 },
          supertrend: { value: 95, direction: "bullish" },
          states: { supertrendBreakUp: true },
        },
      },
    };

    await withMockedIndicators(payloadFlip, async () => {
      const res = await confirmIndicatorPreset({
        mint: "MintA",
        side: "entry",
        preset: "supertrend_break",
        intervals: ["5_MINUTE"],
      });
      expect(res.confirmed).toBe(true);
      expect(res.intervals[0].reason).toContain("flipped bullish");
    });

    // 2. Already bullish (direction = "bullish", close >= supertrendValue)
    const payloadBullish = {
      "5_MINUTE": {
        latest: {
          candle: { close: 102 },
          supertrend: { value: 95, direction: "bullish" },
          states: { supertrendBreakUp: false },
        },
      },
    };

    await withMockedIndicators(payloadBullish, async () => {
      const res = await confirmIndicatorPreset({
        mint: "MintA",
        side: "entry",
        preset: "supertrend_break",
        intervals: ["5_MINUTE"],
      });
      expect(res.confirmed).toBe(true);
    });
  });

  it("rsi_reversal: triggers when RSI is oversold/overbought", async () => {
    config.indicators.enabled = true;
    config.indicators.rsiOversold = 30;
    config.indicators.rsiOverbought = 80;
    config.indicators.requireAllIntervals = false;

    // 1. Entry: RSI <= 30
    const payloadOversold = {
      "5_MINUTE": {
        latest: { rsi: { value: 25 } },
      },
    };

    await withMockedIndicators(payloadOversold, async () => {
      const res = await confirmIndicatorPreset({
        mint: "MintA",
        side: "entry",
        preset: "rsi_reversal",
        intervals: ["5_MINUTE"],
      });
      expect(res.confirmed).toBe(true);
    });

    // 2. Exit: RSI >= 80
    const payloadOverbought = {
      "5_MINUTE": {
        latest: { rsi: { value: 85 } },
      },
    };

    await withMockedIndicators(payloadOverbought, async () => {
      const res = await confirmIndicatorPreset({
        mint: "MintA",
        side: "exit",
        preset: "rsi_reversal",
        intervals: ["5_MINUTE"],
      });
      expect(res.confirmed).toBe(true);
    });
  });

  it("bollinger_reversion: triggers when price crosses band", async () => {
    config.indicators.enabled = true;
    config.indicators.rsiOversold = 30;
    config.indicators.rsiOverbought = 80;
    config.indicators.requireAllIntervals = false;

    // Entry: Close <= lower band
    const payloadBB = {
      "5_MINUTE": {
        latest: {
          candle: { close: 9.5 },
          bollinger: { lower: 10.0, middle: 11.0, upper: 12.0 },
        },
      },
    };

    await withMockedIndicators(payloadBB, async () => {
      const res = await confirmIndicatorPreset({
        mint: "MintA",
        side: "entry",
        preset: "bollinger_reversion",
        intervals: ["5_MINUTE"],
      });
      expect(res.confirmed).toBe(true);
    });
  });

  it("requireAllIntervals: false vs true", async () => {
    config.indicators.enabled = true;
    config.indicators.rsiOversold = 30;
    config.indicators.rsiOverbought = 80;

    // 5m is confirmed, 15m is NOT confirmed
    const payloadMixed = {
      "5_MINUTE": {
        latest: { rsi: { value: 20 } }, // confirmed (<= 30)
      },
      "15_MINUTE": {
        latest: { rsi: { value: 50 } }, // NOT confirmed (> 30)
      },
    };

    // 1. requireAllIntervals = false -> confirmed
    config.indicators.requireAllIntervals = false;
    await withMockedIndicators(payloadMixed, async () => {
      const res = await confirmIndicatorPreset({
        mint: "MintA",
        side: "entry",
        preset: "rsi_reversal",
        intervals: ["5_MINUTE", "15_MINUTE"],
      });
      expect(res.confirmed).toBe(true);
    });

    // 2. requireAllIntervals = true -> NOT confirmed
    config.indicators.requireAllIntervals = true;
    await withMockedIndicators(payloadMixed, async () => {
      const res = await confirmIndicatorPreset({
        mint: "MintA",
        side: "entry",
        preset: "rsi_reversal",
        intervals: ["5_MINUTE", "15_MINUTE"],
      });
      expect(res.confirmed).toBe(false);
    });
  });
});
