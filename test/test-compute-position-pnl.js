/**
 * Test: computePositionPnl (smoke test of extracted PnL helper)
 *
 * Verifies:
 *   1. computePositionPnl is importable from new location
 *   2. Returns object with expected fields and types
 *   3. Returns finite numbers for pnl fields
 *   4. estimateSlippageLamports also importable
 *
 * The detailed PnL math is covered by test-vp-pnl.js (a spec test that
 * re-implements the algorithm in BigInt). This test ensures the production
 * function is runnable from the new location and produces the expected
 * output shape.
 */

import { computePositionPnl, estimateSlippageLamports } from "../tools/compute-position-pnl.js";

let pass = 0;
let fail = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`✅ ${name}`);
    pass++;
  } catch (e) {
    console.log(`❌ ${name}: ${e.message}`);
    fail++;
  }
}

function assertEq(actual, expected, msg = "") {
  if (actual !== expected) {
    throw new Error(`${msg} expected=${expected} actual=${actual}`);
  }
}

function assert(cond, msg = "assertion failed") {
  if (!cond) throw new Error(msg);
}

// Minimal synthetic VP and bin data
// Single bin at binId=100, with token Y (SOL) only
const SCALE_Q64 = (1n << 64n).toString(); // "18446744073709551616"
const syntheticVp = {
  id: "vp-test-001",
  pair: "TEST-SOL",
  pool: "TestPool111111111111111111111111111111111",
  amount_sol: 0.5,
  initial_value_usd: 85, // 0.5 SOL * $170
  lower_bin: 95,
  upper_bin: 105,
  bin_shares: [
    { binId: 100, shares: "500000000", feeXPerTokenComplete: "0", feeYPerTokenComplete: "0" },
  ],
  deploy_gas_sol: 0.005,
  close_gas_sol: 0.002,
};

const syntheticBins = [
  {
    binId: 100,
    xAmount: "0", // No X in this bin
    yAmount: "500000000", // 0.5 SOL lamports
    supply: "1000000000", // 1 SOL lamports total supply
    feeAmountXPerTokenStored: "0",
    feeAmountYPerTokenStored: "0",
    priceQ64: SCALE_Q64, // 1.0 in Q64.64
    price: "1.0",
  },
];

async function suite() {
  // ── Test 1: imports work ─────────────────────────────────────
  await test("computePositionPnl: importable from new file", async () => {
    assertEq(typeof computePositionPnl, "function", "should be a function");
    assertEq(typeof estimateSlippageLamports, "function", "should be a function");
  });

  // ── Test 2: returns expected field shape ─────────────────────
  await test("computePositionPnl: returns object with all expected fields", async () => {
    const pnl = computePositionPnl(syntheticVp, syntheticBins, 170, { activeBinId: 100 });
    assert(pnl != null, "pnl should not be null");
    // Core numeric fields
    for (const f of [
      "positionValueSol", "unclaimedFeesSol", "unclaimedFeesUsd",
      "pnlUsd", "pnlPct", "currentValueUsd", "initialValueUsd",
      "rawPnlSol", "feesSol", "deployGasSol", "closeGasSol", "gasCostSol",
      "slippageSol", "totalCostSol", "netPnlSol", "pnlSolPct",
      "ilUsd", "feesUsd", "gasCostUsd", "slippageCostUsd", "totalCostUsd",
    ]) {
      assert(f in pnl, `pnl.${f} should be present`);
      assert(Number.isFinite(pnl[f]), `pnl.${f} should be a finite number (got ${pnl[f]})`);
    }
    // perBin should be an array
    assert(Array.isArray(pnl.perBin), "pnl.perBin should be an array");
    assertEq(pnl.perBin.length, 1, "perBin should have 1 entry (we deployed to 1 bin)");
  });

  // ── Test 3: SOL mode math sanity ─────────────────────────────
  await test("computePositionPnl: SOL mode math is consistent", async () => {
    const pnl = computePositionPnl(syntheticVp, syntheticBins, 170, { activeBinId: 100 });
    // We deployed 0.5 SOL, value should be ~0.5 SOL minus gas/slippage
    assert(pnl.positionValueSol > 0 && pnl.positionValueSol < 1,
      `positionValueSol should be <1 SOL, got ${pnl.positionValueSol}`);
    assert(pnl.positionValueSol < syntheticVp.amount_sol,
      `positionValueSol should be less than initial (gas/slippage), got ${pnl.positionValueSol}`);
    // Net PnL should be negative or zero (we paid gas, no price change)
    assert(pnl.netPnlSol <= 0,
      `netPnlSol should be ≤ 0 (gas costs), got ${pnl.netPnlSol}`);
    // USD value should be positive
    assert(pnl.currentValueUsd > 0, `currentValueUsd should be > 0, got ${pnl.currentValueUsd}`);
  });

  // ── Test 4: works with empty bin_shares ──────────────────────
  await test("computePositionPnl: empty bin_shares returns zero position value", async () => {
    const emptyVp = { ...syntheticVp, bin_shares: [] };
    const pnl = computePositionPnl(emptyVp, [], 170, { activeBinId: 100 });
    assertEq(pnl.positionValueSol, 0, "no shares → zero position value");
    assertEq(pnl.perBin.length, 0, "no shares → empty perBin");
  });

  // ── Test 5: estimateSlippageLamports returns 0n for Y-only ──
  await test("estimateSlippageLamports: Y-only position (no X to swap) returns 0n", async () => {
    const perBin = [{ binId: 100, ourX: "0", ourY: "500000000" }];
    const result = estimateSlippageLamports(perBin, syntheticBins, 100);
    assertEq(result, 0n, "Y-only position should have 0n slippage");
  });
}

suite().then(() => {
  console.log(`\n${pass + fail} tests: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
});
