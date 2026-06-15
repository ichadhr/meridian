import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import { recalculateWeights, getWeightsSummary } from "../../core/index.js";
import { SIGNAL_WEIGHTS_FILE as WEIGHTS_FILE } from "../../config/paths.js";

let originalWeightsContent: string | null = null;

beforeAll(() => {
  if (fs.existsSync(WEIGHTS_FILE)) {
    originalWeightsContent = fs.readFileSync(WEIGHTS_FILE, "utf8");
  }
  if (fs.existsSync(WEIGHTS_FILE)) fs.unlinkSync(WEIGHTS_FILE);
});

afterAll(() => {
  if (originalWeightsContent !== null) {
    fs.writeFileSync(WEIGHTS_FILE, originalWeightsContent);
  } else if (fs.existsSync(WEIGHTS_FILE)) {
    fs.unlinkSync(WEIGHTS_FILE);
  }
});

describe("Signal Weights", () => {
  it("getWeightsSummary default formatting", () => {
    const summary = getWeightsSummary();
    expect(summary).toContain("Signal Weights (Darwinian — learned from past positions):");
    expect(summary).toContain("organic_score");
    expect(summary).toContain("volatility");
    expect(summary).toContain("1.00");
  });

  it("recalculateWeights skips with insufficient samples", () => {
    const mockConfig = {
      darwin: {
        windowDays: 60,
        minSamples: 5,
        boostFactor: 1.05,
        decayFactor: 0.95,
        weightFloor: 0.3,
        weightCeiling: 2.5,
      },
    } as any;

    const perfData = Array.from({ length: 3 }, () => ({
      pnl_usd: 10,
      organic_score: 80,
    })) as any[];

    const result = recalculateWeights(perfData, mockConfig);
    expect(result.changes.length).toBe(0);
  });

  it("recalculateWeights applies boosts and decays correctly", () => {
    const mockConfig = {
      darwin: {
        windowDays: 60,
        minSamples: 4,
        boostFactor: 1.10,
        decayFactor: 0.90,
        weightFloor: 0.3,
        weightCeiling: 2.5,
      },
    } as any;

    const perfData = [
      {
        recorded_at: new Date().toISOString(),
        pnl_usd: 50.0,
        signal_snapshot: {
          organic_score: 90,
          volatility: 3.0,
          smart_wallets_present: true,
          holder_count: 500,
        },
      },
      {
        recorded_at: new Date().toISOString(),
        pnl_usd: 30.0,
        signal_snapshot: {
          organic_score: 95,
          volatility: 3.0,
          smart_wallets_present: true,
          holder_count: 600,
        },
      },
      {
        recorded_at: new Date().toISOString(),
        pnl_usd: -50.0,
        signal_snapshot: {
          organic_score: 60,
          volatility: 3.0,
          smart_wallets_present: false,
          holder_count: 2000,
        },
      },
      {
        recorded_at: new Date().toISOString(),
        pnl_usd: -20.0,
        signal_snapshot: {
          organic_score: 65,
          volatility: 3.0,
          smart_wallets_present: false,
          holder_count: 2500,
        },
      },
    ] as any[];

    const result = recalculateWeights(perfData, mockConfig);
    expect(result.changes.length).toBeGreaterThan(0);

    const boosted = result.changes.filter(c => c.action === "boosted").map(c => c.signal);
    const decayed = result.changes.filter(c => c.action === "decayed").map(c => c.signal);

    expect(boosted.includes("organic_score") || boosted.includes("smart_wallets_present")).toBe(true);
    expect(decayed.includes("holder_count") || decayed.includes("volatility")).toBe(true);
  });
});
