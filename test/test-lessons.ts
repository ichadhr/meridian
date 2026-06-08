/**
 * Test: Lessons, learning engine, and threshold evolution (lessons.ts)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
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
  getLessonsForPrompt,
  getPerformanceSummary,
} from "../lessons.js";
import { config } from "../config/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LESSONS_FILE = "./lessons.json";
const USER_CONFIG_PATH = path.join(__dirname, "..", "user-config.json");

let pass = 0;
let fail = 0;

function test(name: string, fn: () => void | Promise<void>): void | Promise<void> {
  try {
    const res = fn();
    if (res instanceof Promise) {
      return res
        .then(() => {
          console.log(`✅ ${name}`);
          pass++;
        })
        .catch((e) => {
          console.log(`❌ ${name}: ${e.message}`);
          fail++;
        });
    } else {
      console.log(`✅ ${name}`);
      pass++;
    }
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
let originalLessonsContent: string | null = null;
let originalUserConfigContent: string | null = null;

function backup(): void {
  if (fs.existsSync(LESSONS_FILE)) {
    originalLessonsContent = fs.readFileSync(LESSONS_FILE, "utf8");
  }
  if (fs.existsSync(USER_CONFIG_PATH)) {
    originalUserConfigContent = fs.readFileSync(USER_CONFIG_PATH, "utf8");
  }
}

function restore(): void {
  if (originalLessonsContent !== null) {
    fs.writeFileSync(LESSONS_FILE, originalLessonsContent);
  } else if (fs.existsSync(LESSONS_FILE)) {
    fs.unlinkSync(LESSONS_FILE);
  }

  if (originalUserConfigContent !== null) {
    fs.writeFileSync(USER_CONFIG_PATH, originalUserConfigContent);
  } else if (fs.existsSync(USER_CONFIG_PATH)) {
    fs.unlinkSync(USER_CONFIG_PATH);
  }
}

async function suite(): Promise<void> {
  backup();

  try {
    // Start with a clean database
    clearAllLessons();
    clearPerformance();

    // ── Test 1: Manual lessons CRUD & sanitization ────────────────
    await test("lessons CRUD: adding, pinning, listing, filtering, keyword removal", () => {
      // 1. Add unsanitized lesson
      const rawText = "Avoid: <scam> pools\nwith newlines\tand backticks `test`";
      addLesson(rawText, ["scam", "avoid"], { pinned: false });

      const listed = listLessons({ tag: "scam" });
      assertEq(listed.total, 1, "should have added 1 lesson");

      // Verify sanitization: html brackets, newlines/tabs replaced with space, backticks removed
      const ruleText = listed.lessons[0].rule;
      assert(!ruleText.includes("<"), "should remove HTML open bracket");
      assert(!ruleText.includes(">"), "should remove HTML close bracket");
      assert(!ruleText.includes("\n"), "should replace newlines");
      assert(!ruleText.includes("`"), "should remove backticks");
      assert(ruleText.includes("scam pools with newlines and backticks"), `Unexpected rule text: ${ruleText}`);

      // 2. Pin and unpin
      const id = listed.lessons[0].id;
      const pinResult = pinLesson(id);
      assertEq(pinResult.found, true);
      assertEq(pinResult.pinned, true);

      const listedPinned = listLessons({ pinned: true });
      assertEq(listedPinned.total, 1, "should find 1 pinned lesson");

      const unpinResult = unpinLesson(id);
      assertEq(unpinResult.found, true);
      assertEq(unpinResult.pinned, false);

      const listedPinned2 = listLessons({ pinned: true });
      assertEq(listedPinned2.total, 0, "should have 0 pinned lessons now");

      // 3. Keyword removal
      addLesson("Test keyword removal for alpha wallets", ["alpha"]);
      const alphaCount = listLessons({ tag: "alpha" }).total;
      assertEq(alphaCount, 1);

      const removedCount = removeLessonsByKeyword("alpha");
      assertEq(removedCount, 1, "should have removed 1 lesson");

      const alphaCount2 = listLessons({ tag: "alpha" }).total;
      assertEq(alphaCount2, 0, "should have 0 lessons after keyword removal");
    });

    // ── Test 2: suspiciousUnitMix filter ─────────────────────────
    await test("recordPerformance: suspiciousUnitMix records are skipped", async () => {
      clearPerformance();
      
      const suspiciousRecord = {
        position: "pk_suspicious_1",
        pool: "Pool1",
        pool_name: "SUSP-SOL",
        base_mint: "MintSuspicious1",
        amount_sol: 0.5,
        initial_value_usd: 85.0,  // USD
        final_value_usd: 0.8,     // Absurdly low (looks like SOL instead of USD)
        fees_earned_usd: 0.01,
        minutes_held: 10,
        minutes_in_range: 8,
        close_reason: "OOR too long",
      };

      await recordPerformance(suspiciousRecord);
      const summary = getPerformanceSummary();
      assert(summary === null, "should have skipped recording performance (unit mix)");
    });

    // ── Test 3: suspiciousAbsurdClosedPnl filter ──────────────────
    await test("recordPerformance: suspiciousAbsurdClosedPnl records are skipped", async () => {
      clearPerformance();

      const absurdRecord = {
        position: "pk_absurd_1",
        pool: "Pool2",
        pool_name: "ABSURD-SOL",
        base_mint: "MintAbsurd1",
        amount_sol: 0.5,
        initial_value_usd: 85.0,
        final_value_usd: 2.0,      // USD (causes -97% loss)
        fees_earned_usd: 0.05,
        minutes_held: 20,
        minutes_in_range: 15,
        close_reason: "Manual close", // not "stop loss"
      };

      await recordPerformance(absurdRecord);
      const summary = getPerformanceSummary();
      assert(summary === null, "should have skipped recording performance (absurd loss)");
    });

    // ── Test 4: evolveThresholds - raise minFeeActiveTvlRatio floor ──
    await test("evolveThresholds: nudges up minFeeActiveTvlRatio when winners earn high fees", () => {
      const mockConfig = {
        screening: {
          minFeeActiveTvlRatio: 0.1,  // current floor
          minOrganic: 60,
        },
      } as any;

      // 5 closed positions (all winners with fee_tvl_ratio = 0.5)
      const perfData = Array.from({ length: 5 }, (_, i) => ({
        pnl_pct: 10.0,
        fee_tvl_ratio: 0.5,
        organic_score: 80,
      })) as any[];

      const result = evolveThresholds(perfData, mockConfig);
      assert(result !== null);
      assert(result!.changes.minFeeActiveTvlRatio !== undefined, "should evolve fee ratio");
      
      // floor should nudge up from 0.1 towards 0.5 * 0.85 = 0.425
      // limit of max change per step is 20% of current floor (0.1 * 1.20 = 0.12)
      assertEq(result!.changes.minFeeActiveTvlRatio, 0.12, "should nudge up by 20% max change limit");
    });

    // ── Test 5: evolveThresholds - raise minOrganic floor ───────
    await test("evolveThresholds: nudges up minOrganic when losers have low organic scores", () => {
      const mockConfig = {
        screening: {
          minFeeActiveTvlRatio: 0.1,
          minOrganic: 60, // current floor
        },
      } as any;

      // 5 closed positions: 2 winners (organic=85), 3 losers (organic=65)
      // avg winner organic = 85, avg loser organic = 65. Difference (20) >= 10.
      // minWinnerOrganic = 85. Target = 85 - 3 = 82.
      // Current floor is 60. Max nudge is 20% of 60 = 12. New = 72.
      const perfData = [
        { pnl_pct: 5.0, fee_tvl_ratio: 0.1, organic_score: 85 },
        { pnl_pct: 6.0, fee_tvl_ratio: 0.1, organic_score: 85 },
        { pnl_pct: -6.0, fee_tvl_ratio: 0.1, organic_score: 65 },
        { pnl_pct: -7.0, fee_tvl_ratio: 0.1, organic_score: 65 },
        { pnl_pct: -8.0, fee_tvl_ratio: 0.1, organic_score: 65 },
      ] as any[];

      const result = evolveThresholds(perfData, mockConfig);
      assert(result !== null);
      assert(result!.changes.minOrganic !== undefined, "should evolve minOrganic");
      
      const evolvedOrganic = result!.changes.minOrganic;
      assert(evolvedOrganic > 60 && evolvedOrganic <= 72, `Expected evolvedOrganic to be between 61 and 72, got ${evolvedOrganic}`);
    });
  } finally {
    restore();
  }

  console.log(`\n${pass + fail} tests: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

suite().catch((err) => {
  console.error(err);
  process.exit(1);
});
