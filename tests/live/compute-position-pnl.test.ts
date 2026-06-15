/**
 * Test: computePositionPnl (smoke test of extracted PnL helper)
 *
 * Verifies:
 *   1. computePositionPnl is importable from new location
 *   2. Returns object with expected fields and types
 *   3. Returns finite numbers for pnl fields
 *   4. estimateSlippageLamports also importable
 *
 * The detailed PnL math is covered by tests/live/vp-pnl.test.ts (a spec test that
 * re-implements the algorithm in BigInt). This test ensures the production
 * function is runnable from the new location and produces the expected
 * output shape.
 */

import { describe, it, expect } from "vitest";
import { computePositionPnl, estimateSlippageLamports } from "../../core/index.js";
// Pre-import SDK so the dynamic import in compute-position-pnl.js resolves
// (its `.then()` callback sets _swapExactInQuoteAtBin in the next microtask).
import * as meteoraSdk from "@meteora-ag/dlmm";
// Silence "unused import" — referenced for its side effect (module load).
void meteoraSdk;

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

describe("computePositionPnl", () => {
  it("is importable from new file", () => {
    expect(typeof computePositionPnl).toBe("function");
    expect(typeof estimateSlippageLamports).toBe("function");
  });

  it("returns object with all expected fields", () => {
    const pnl = computePositionPnl(syntheticVp, syntheticBins, 170, { activeBinId: 100 });
    expect(pnl).not.toBeNull();
    // Core numeric fields
    for (const f of [
      "positionValueSol", "unclaimedFeesSol", "unclaimedFeesUsd",
      "pnlUsd", "pnlPct", "currentValueUsd", "initialValueUsd",
      "rawPnlSol", "feesSol", "deployGasSol", "closeGasSol", "gasCostSol",
      "slippageSol", "totalCostSol", "netPnlSol", "pnlSolPct",
      "ilUsd", "feesUsd", "gasCostUsd", "slippageCostUsd", "totalCostUsd",
    ]) {
      expect(f in pnl).toBe(true);
      expect(Number.isFinite((pnl as any)[f])).toBe(true);
    }
    // perBin should be an array
    expect(Array.isArray(pnl.perBin)).toBe(true);
    expect(pnl.perBin.length).toBe(1);
  });

  it("SOL mode math is consistent", () => {
    const pnl = computePositionPnl(syntheticVp, syntheticBins, 170, { activeBinId: 100 });
    // We deployed 0.5 SOL, value should be ~0.5 SOL minus gas/slippage
    expect(pnl.positionValueSol).toBeGreaterThan(0);
    expect(pnl.positionValueSol).toBeLessThan(1);
    expect(pnl.positionValueSol).toBeLessThan(syntheticVp.amount_sol);
    // Net PnL should be negative or zero (we paid gas, no price change)
    expect(pnl.netPnlSol).toBeLessThanOrEqual(0);
    // USD value should be positive
    expect(pnl.currentValueUsd).toBeGreaterThan(0);
  });

  it("empty bin_shares returns zero position value", () => {
    const emptyVp = { ...syntheticVp, bin_shares: [] };
    const pnl = computePositionPnl(emptyVp, [], 170, { activeBinId: 100 });
    expect(pnl.positionValueSol).toBe(0);
    expect(pnl.perBin.length).toBe(0);
  });

  it("estimateSlippageLamports: Y-only position returns 0n", () => {
    const perBin = [{ binId: 100, ourX: "0", ourY: "500000000" }] as any;
    const result = estimateSlippageLamports(perBin, syntheticBins, 100);
    expect(result).toBe(0n);
  });

  it("estimateSlippageLamports: SDK path succeeds with proper poolParams shape", async () => {
    // Yield so the `.then()` callback in compute-position-pnl.js runs
    await new Promise<void>((resolve) => setImmediate(resolve));

    // X in bin above active, deep Y+X in bin at active → forces SDK swap walk
    const perBin = [
      { binId: 101, ourX: "100000000", ourY: "0" }, // 0.1 SOL X to swap
    ] as any;
    const activeBinId = 100;
    const binData = [
      // Active bin: NON-ZERO xAmount (critical: triggers the bug path)
      { binId: 100, xAmount: "1000000", yAmount: "10000000000", priceQ64: SCALE_Q64, price: "1.0" },
      // Bin above active: empty
      { binId: 101, xAmount: "0", yAmount: "0", priceQ64: SCALE_Q64, price: "1.0" },
    ];
    // Anchor-decoded pool params (camelCase).
    const poolParams = {
      binStep: 100,
      sParameter: {
        baseFactor: 1000,
        baseFeePowerFactor: 1,
        variableFeeControl: 0,
        protocolShare: 0,
      },
      vParameter: { volatilityAccumulator: 0 },
    };

    const result = estimateSlippageLamports(perBin, binData, activeBinId, { poolParams });

    // Assert: exact shortfall value.
    expect(result).toBe(1000000n); // 1% of inAmount (base fee)
  });
});
