/**
 * Test: Darwinian Signal Weights system (signal-weights.ts)
 */

import fs from "fs";
import { recalculateWeights, getWeightsSummary } from "../signal-weights.js";

const WEIGHTS_FILE = "./signal-weights.json";

let pass = 0;
let fail = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
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

// ── Backup & Restore ─────────────────────────────────────────────
let originalWeightsContent: string | null = null;

function backup(): void {
  if (fs.existsSync(WEIGHTS_FILE)) {
    originalWeightsContent = fs.readFileSync(WEIGHTS_FILE, "utf8");
  }
}

function restore(): void {
  if (originalWeightsContent !== null) {
    fs.writeFileSync(WEIGHTS_FILE, originalWeightsContent);
  } else if (fs.existsSync(WEIGHTS_FILE)) {
    fs.unlinkSync(WEIGHTS_FILE);
  }
}

function suite(): void {
  backup();

  try {
    // Clean start (delete local json if exists to let it initialize defaults)
    if (fs.existsSync(WEIGHTS_FILE)) fs.unlinkSync(WEIGHTS_FILE);

    // ── Test 1: getWeightsSummary default layout ──────────────────
    test("weights summary: default formatting", () => {
      const summary = getWeightsSummary();
      assert(summary.includes("Signal Weights (Darwinian — learned from past positions):"), "missing header");
      assert(summary.includes("organic_score"), "missing organic_score");
      assert(summary.includes("volatility"), "missing volatility");
      assert(summary.includes("1.00"), "default weights should be 1.00");
    });

    // ── Test 2: recalculateWeights with insufficient samples ────
    test("recalculateWeights: skips with insufficient samples", () => {
      const mockConfig = {
        darwin: {
          windowDays: 60,
          minSamples: 5, // need at least 5
          boostFactor: 1.05,
          decayFactor: 0.95,
          weightFloor: 0.3,
          weightCeiling: 2.5,
        },
      } as any;

      // 3 records (less than 5)
      const perfData = Array.from({ length: 3 }, () => ({
        pnl_usd: 10,
        organic_score: 80,
      })) as any[];

      const result = recalculateWeights(perfData, mockConfig);
      assertEq(result.changes.length, 0, "should make 0 changes due to insufficient samples");
    });

    // ── Test 3: recalculateWeights numeric, boolean, categorical lifts ──
    test("recalculateWeights: applies boosts and decays correctly based on quartile lifts", () => {
      const mockConfig = {
        darwin: {
          windowDays: 60,
          minSamples: 4,
          boostFactor: 1.10, // 10% boost
          decayFactor: 0.90, // 10% decay
          weightFloor: 0.3,
          weightCeiling: 2.5,
        },
      } as any;

      // 4 records total: 2 wins, 2 losses
      // We will mock signals:
      // - 'organic_score' (Numeric): high in wins (90, 95), low in losses (60, 65) -> HIGH lift
      // - 'volatility' (Numeric): same in both (3.0) -> zero lift
      // - 'smart_wallets_present' (Boolean): true in wins (1, 1), false in losses (0, 0) -> HIGH lift
      // - 'holder_count' (Numeric): low in wins (500, 600), high in losses (2000, 2500) -> negative lift (with HIGHER_IS_BETTER = decay)
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
      
      // Top quartile signals should be boosted from 1.0 to 1.10
      // Bottom quartile signals should be decayed from 1.0 to 0.90
      assert(result.changes.length > 0, "should make weight adjustments");
      
      const boosted = result.changes.filter(c => c.action === "boosted").map(c => c.signal);
      const decayed = result.changes.filter(c => c.action === "decayed").map(c => c.signal);

      // organic_score and smart_wallets_present should be boosted since their values in wins are highly predictive of wins
      assert(boosted.includes("organic_score") || boosted.includes("smart_wallets_present"), "should boost highly predictive signals");
      
      // holder_count (has negative lift since wins had small holders and losses had huge holders)
      assert(decayed.includes("holder_count") || decayed.includes("volatility"), "should decay weak or negative lift signals");
    });
  } finally {
    restore();
  }

  console.log(`\n${pass + fail} tests: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

suite();
