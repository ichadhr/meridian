/**
 * Test: Chart Indicators evaluation presets (chart-indicators.ts)
 */

import { confirmIndicatorPreset } from "../providers/hivemind/index.js";
import { config } from "../config/index.js";

let pass = 0;
let fail = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`✅ ${name}`);
    pass++;
  } catch (e: any) {
    console.log(`❌ ${name}: ${e.message}`);
    fail++;
  }
}

function assertEq<T>(actual: T, expected: T, msg = ""): void {
  if (actual !== expected) {
    throw new Error(`${msg} expected=${expected} actual=${actual}`);
  }
}

function assert(cond: boolean, msg = "assertion failed"): void {
  if (!cond) throw new Error(msg);
}

// ── Mock fetch Helper ───────────────────────────────────────────
async function withMockedIndicators(
  payloads: Record<string, any>,
  fn: () => Promise<void>
): Promise<void> {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: any) => {
    const urlStr = String(url);
    console.log("Mock fetch URL:", urlStr);
    let matchedInterval = "5_MINUTE";
    if (urlStr.includes("interval=15_MINUTE")) matchedInterval = "15_MINUTE";

    const data = payloads[matchedInterval] || {};
    return {
      ok: true,
      text: async () => JSON.stringify(data),
    };
  }) as any;

  try {
    await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

async function suite(): Promise<void> {
  // Ensure indicators are enabled in config
  const origEnabled = config.indicators.enabled;
  const origRsiOversold = config.indicators.rsiOversold;
  const origRsiOverbought = config.indicators.rsiOverbought;
  const origRequireAll = config.indicators.requireAllIntervals;

  config.indicators.enabled = true;
  config.indicators.rsiOversold = 30;
  config.indicators.rsiOverbought = 80;
  config.indicators.requireAllIntervals = false;

  try {
    // ── Test 1: supertrend_break preset ──────────────────────────
    await test("preset supertrend_break: entry triggers on bullish flip or direction", async () => {
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
        assertEq(res.confirmed, true, "should confirm on bullish flip");
        assertEq(res.intervals[0].reason.includes("flipped bullish"), true);
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
        assertEq(res.confirmed, true, "should confirm when price is above bullish Supertrend");
      });
    });

    // ── Test 2: rsi_reversal preset ──────────────────────────────
    await test("preset rsi_reversal: triggers when RSI is oversold/overbought", async () => {
      // 1. Entry: RSI <= 30
      const payloadOversold = {
        "5_MINUTE": {
          latest: {
            rsi: { value: 25 },
          },
        },
      };

      await withMockedIndicators(payloadOversold, async () => {
        const res = await confirmIndicatorPreset({
          mint: "MintA",
          side: "entry",
          preset: "rsi_reversal",
          intervals: ["5_MINUTE"],
        });
        assertEq(res.confirmed, true, "should confirm entry when RSI is <= 30");
      });

      // 2. Exit: RSI >= 80
      const payloadOverbought = {
        "5_MINUTE": {
          latest: {
            rsi: { value: 85 },
          },
        },
      };

      await withMockedIndicators(payloadOverbought, async () => {
        const res = await confirmIndicatorPreset({
          mint: "MintA",
          side: "exit",
          preset: "rsi_reversal",
          intervals: ["5_MINUTE"],
        });
        assertEq(res.confirmed, true, "should confirm exit when RSI is >= 80");
      });
    });

    // ── Test 3: bollinger_reversion preset ───────────────────────
    await test("preset bollinger_reversion: triggers when price crosses band", async () => {
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
        assertEq(res.confirmed, true, "should confirm entry when close <= lower band");
      });
    });

    // ── Test 4: requireAllIntervals filtering ─────────────────────
    await test("intervals combination: requireAllIntervals = false vs true", async () => {
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
        assertEq(res.confirmed, true, "should be true if requireAllIntervals is false and at least one interval is confirmed");
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
        assertEq(res.confirmed, false, "should be false if requireAllIntervals is true and not all intervals are confirmed");
      });
    });

  } finally {
    // Restore original config
    config.indicators.enabled = origEnabled;
    config.indicators.rsiOversold = origRsiOversold;
    config.indicators.rsiOverbought = origRsiOverbought;
    config.indicators.requireAllIntervals = origRequireAll;
  }

  console.log(`\n${pass + fail} tests: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

suite().catch((err) => {
  console.error(err);
  process.exit(1);
});
