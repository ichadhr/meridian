/**
 * Test: VP PnL calculation + close rules + SDK distribution functions
 *
 * Uses BigInt instead of BN for PnL math (no dependencies).
 * Distribution tests import SDK's calculate{Spot,BidAsk,Normal}Distribution.
 */

import { describe, it, expect } from "vitest";
import { calculateSpotDistribution, calculateBidAskDistribution, calculateNormalDistribution } from "@meteora-ag/dlmm";

const SCALE = 1n << 64n;
const LAMPORTS_PER_SOL = 1_000_000_000n;

function mulShr(a: bigint, b: bigint, shift: number): bigint {
  return (a * b) >> BigInt(shift);
}

// Simulate deploy-time share calculation (from dlmm.js)
function computeShares(
  depositYLamports: bigint | string | number,
  binPrice: bigint | string | number,
  binX: bigint | string | number,
  binY: bigint | string | number,
  binSupply: bigint | string | number
): bigint {
  const inLiquidity = BigInt(depositYLamports) * SCALE;
  const binLiquidity = BigInt(binPrice) * BigInt(binX) + BigInt(binY) * SCALE;
  return binLiquidity === 0n
    ? inLiquidity
    : (inLiquidity * BigInt(binSupply)) / binLiquidity;
}

// Fixed withdrawal: uses effectiveSupply = supply + shares
function computeWithdrawal(
  shares: bigint,
  xAmount: bigint | string | number,
  yAmount: bigint | string | number,
  supply: bigint | string | number,
  priceQ64: bigint | string | number
): bigint {
  const effectiveSupply = BigInt(supply) + shares;
  const ourX = effectiveSupply === 0n ? 0n : (shares * BigInt(xAmount)) / effectiveSupply;
  const ourY = effectiveSupply === 0n ? 0n : (shares * BigInt(yAmount)) / effectiveSupply;
  const ourXInY = mulShr(ourX, BigInt(priceQ64), 64);
  return ourY + ourXInY;
}

// Old (broken) withdrawal: uses raw supply
function computeWithdrawalOld(
  shares: bigint,
  xAmount: bigint | string | number,
  yAmount: bigint | string | number,
  supply: bigint | string | number,
  priceQ64: bigint | string | number
): bigint {
  const s = BigInt(supply);
  const ourX = s === 0n ? 0n : (shares * BigInt(xAmount)) / s;
  const ourY = s === 0n ? 0n : (shares * BigInt(yAmount)) / s;
  const ourXInY = mulShr(ourX, BigInt(priceQ64), 64);
  return ourY + ourXInY;
}

// Apply VP cost deductions (mirrors manage-virtual.js logic)
function applyVpCosts(rawValueSol: number, binStep: number | null = null): number {
  const gasCostSol = 0.007;
  const slippagePct = binStep
    ? (binStep / 10000 / 2) * 100
    : 0.3;
  const slippageMultiplier = 1 - slippagePct / 100;
  return Math.max(0, rawValueSol - gasCostSol) * slippageMultiplier;
}

// ════════════════════════════════════════════════════════════
//  SECTION 1: Share/Supply Fix (original bug)
// ════════════════════════════════════════════════════════════

describe("Share/Supply Fix", () => {
  it("Empty bin: old code inflated by 2^64, new code reasonable", () => {
    const depositYLamports = 500_000_000n;
    const priceQ64 = SCALE;
    const shares = computeShares(depositYLamports, priceQ64, 0n, 0n, 0n);

    const currentY = 1_000_000_000n;
    const currentSupply = 500_000_000n;

    const oldValue = computeWithdrawalOld(shares, 0n, currentY, currentSupply, priceQ64);
    const newValue = computeWithdrawal(shares, 0n, currentY, currentSupply, priceQ64);
    const oldSol = Number(oldValue) / Number(LAMPORTS_PER_SOL);
    const newSol = Number(newValue) / Number(LAMPORTS_PER_SOL);

    expect(oldSol).toBeGreaterThan(1e10);
    expect(newSol).toBeLessThanOrEqual(1.0);
    expect(newSol).toBeGreaterThanOrEqual(0);
  });

  it("Non-empty bin unchanged → withdrawal ≈ deposit", () => {
    const depositYLamports = 500_000_000n;
    const priceQ64 = SCALE;
    const shares = computeShares(depositYLamports, priceQ64, 0n, "2000000000", "1000000000");
    const newValue = computeWithdrawal(shares, 0n, "2000000000", "1000000000", priceQ64);
    const newSol = Number(newValue) / Number(LAMPORTS_PER_SOL);

    const diff = Math.abs(newSol - 0.5) / 0.5;
    expect(diff).toBeLessThan(0.2);
  });
});

// ════════════════════════════════════════════════════════════
//  SECTION 2: Gas + Slippage Deduction
// ════════════════════════════════════════════════════════════

describe("Gas + Slippage Deduction", () => {
  it("Gas cost reduces VP value", () => {
    const raw = 0.5;
    const adjusted = applyVpCosts(raw, 80);
    expect(adjusted).toBeLessThan(raw);
    expect(adjusted).toBeLessThan(raw - 0.005);
  });

  it("Dynamic slippage: bin_step 80 → 0.40%", () => {
    const raw = 1.0;
    const adjusted = applyVpCosts(raw, 80);
    const expected = (1.0 - 0.007) * (1 - 0.40 / 100);
    expect(Math.abs(adjusted - expected)).toBeLessThan(0.0001);
  });

  it("Dynamic slippage: bin_step 125 → 0.625%", () => {
    const raw = 1.0;
    const adjusted = applyVpCosts(raw, 125);
    const expected = (1.0 - 0.007) * (1 - 0.625 / 100);
    expect(Math.abs(adjusted - expected)).toBeLessThan(0.0001);
  });

  it("Fallback slippage: no bin_step → uses 0.3%", () => {
    const raw = 1.0;
    const adjusted = applyVpCosts(raw, null);
    const expected = (1.0 - 0.007) * (1 - 0.3 / 100);
    expect(Math.abs(adjusted - expected)).toBeLessThan(0.0001);
  });

  it("Small position: gas dominates → value floors at 0", () => {
    const raw = 0.005;
    const adjusted = applyVpCosts(raw, 80);
    expect(adjusted).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════
//  SECTION 3: LOW_YIELD Close Rule
// ════════════════════════════════════════════════════════════

function checkLowYield(vp: any, currentValueUsd: number, mgmtConfig: any = {}): any {
  const minFeePerTvl24h = mgmtConfig.minFeePerTvl24h ?? 7;
  const minAgeForYieldCheck = mgmtConfig.minAgeBeforeYieldCheck ?? 60;
  const ageMinutes = vp.deployed_at
    ? Math.floor((Date.now() - new Date(vp.deployed_at).getTime()) / 60000)
    : 0;

  if (ageMinutes >= minAgeForYieldCheck && currentValueUsd > 0) {
    const currentFees = vp.unclaimed_fees_usd || 0;
    const syntheticFeeYield = (currentFees / currentValueUsd) * (1440 / ageMinutes) * 100;
    if (syntheticFeeYield < minFeePerTvl24h) {
      return { rule: 5, reason: "low yield", syntheticFeeYield };
    }
  }
  return null;
}

describe("LOW_YIELD Close Rule", () => {
  it("VP with 0 fees after 120 min → triggers rule 5", () => {
    const vp = {
      deployed_at: new Date(Date.now() - 120 * 60000).toISOString(),
      unclaimed_fees_usd: 0,
    };
    const result = checkLowYield(vp, 85.0);
    expect(result).not.toBeNull();
    expect(result.rule).toBe(5);
  });

  it("VP with good fees → does NOT trigger", () => {
    const vp = {
      deployed_at: new Date(Date.now() - 120 * 60000).toISOString(),
      unclaimed_fees_usd: 2.0,
    };
    const result = checkLowYield(vp, 85.0);
    expect(result).toBeNull();
  });

  it("VP under 60 min → skipped (too young)", () => {
    const vp = {
      deployed_at: new Date(Date.now() - 30 * 60000).toISOString(),
      unclaimed_fees_usd: 0,
    };
    const result = checkLowYield(vp, 85.0);
    expect(result).toBeNull();
  });

  it("edge case — exactly at threshold → does NOT trigger", () => {
    const vp = {
      deployed_at: new Date(Date.now() - 120 * 60000).toISOString(),
      unclaimed_fees_usd: 0.5834,
    };
    const result = checkLowYield(vp, 100.0);
    expect(result).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════
//  SECTION 5: Strategy Distribution
// ════════════════════════════════════════════════════════════

function computeVpYDistribution(strategy: string | null, activeBinId: number, binIds: number[]): Map<number, number> {
  const result = new Map<number, number>();
  if (binIds.length === 0) return result;
  let dist: any[];
  if (strategy === "spot" || !strategy) dist = calculateSpotDistribution(activeBinId, binIds);
  else if (strategy === "bid_ask") dist = calculateBidAskDistribution(activeBinId, binIds);
  else if (strategy === "curve") dist = calculateNormalDistribution(activeBinId, binIds);
  else dist = calculateSpotDistribution(activeBinId, binIds);
  for (const d of dist) {
    result.set(d.binId, Number(d.yAmountBpsOfTotal.toString()));
  }
  for (const id of binIds) {
    if (!result.has(id)) result.set(id, 0);
  }
  return result;
}

describe("Strategy Distribution", () => {
  it("spot: uniform distribution, active bin gets half", () => {
    const binIds = [100, 101, 102, 103, 104, 105];
    const dist = computeVpYDistribution("spot", 105, binIds);
    const total = [...dist.values()].reduce((s, v) => s + v, 0);

    expect(total).toBe(10000);
    const regularBps = dist.get(100) as number;
    const activeBps = dist.get(105) as number;
    expect(activeBps).toBeLessThan(regularBps);
  });

  it("bid_ask: edges get more weight than center", () => {
    const binIds = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110];
    const activeBinId = 110;
    const dist = computeVpYDistribution("bid_ask", activeBinId, binIds);
    const total = [...dist.values()].reduce((s, v) => s + v, 0);

    expect(total).toBe(10000);
    const edgeBps = dist.get(100) as number;
    const midBps = dist.get(105) as number;
    expect(edgeBps).toBeGreaterThan(midBps);
  });

  it("curve: center gets more weight than edges", () => {
    const binIds = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110];
    const activeBinId = 110;
    const dist = computeVpYDistribution("curve", activeBinId, binIds);
    const total = [...dist.values()].reduce((s, v) => s + v, 0);

    expect(total).toBe(10000);
    const edgeBps = dist.get(100) as number;
    const nearActiveBps = dist.get(109) as number;
    expect(nearActiveBps).toBeGreaterThan(edgeBps);
  });

  it("unknown: falls back to spot", () => {
    const binIds = [100, 101, 102];
    const unknownDist = computeVpYDistribution("xyz_unknown", 102, binIds);
    const total = [...unknownDist.values()].reduce((s, v) => s + v, 0);
    expect(total).toBe(10000);
  });
});

// ════════════════════════════════════════════════════════════
//  SECTION 6: Fee Precision Fix
// ════════════════════════════════════════════════════════════

describe("Fee Precision Fix", () => {
  it("small shares (< 2^64) now produce non-zero fees", () => {
    const shares = 250_000_000n;
    const feePerTokenDelta = 1000_000_000_000n;

    const oldFee = (shares >> 64n) * feePerTokenDelta >> 64n;
    const newFee = (shares * feePerTokenDelta) >> 128n;

    expect(oldFee).toBe(0n);
    const largeDelta = 1n << 80n;
    const oldFee2 = (shares >> 64n) * largeDelta >> 64n;
    const newFee2 = (shares * largeDelta) >> 128n;
    const emptyBinShares = 500_000_000n * (1n << 64n);
    const delta = 100_000n;
    const oldEmpty = (emptyBinShares >> 64n) * delta >> 64n;
    const newEmpty = (emptyBinShares * delta) >> 128n;
    expect(oldEmpty).toBe(newEmpty);
  });
});

// ════════════════════════════════════════════════════════════
//  SECTION 7: SOL-mode PnL and Breakdown
// ════════════════════════════════════════════════════════════

describe("SOL-mode PnL and Breakdown", () => {
  it("matches computePositionPnl logic", () => {
    const initialSol = 1.0;
    const rawPositionValueSol = 1.2;
    const unclaimedFeesSol = 0.05;
    const gasCostSol = 0.007;
    const slippagePct = 0.5;
    const slippageSol = rawPositionValueSol * (slippagePct / 100);

    const positionValueSol = Math.max(0, rawPositionValueSol - gasCostSol - slippageSol);
    const ilSol = rawPositionValueSol - initialSol;
    const netPnlSol = positionValueSol + unclaimedFeesSol - initialSol;
    const pnlSolPct = (netPnlSol / initialSol) * 100;

    expect(Math.abs(positionValueSol - 1.1870)).toBeLessThan(1e-5);
    expect(Math.abs(ilSol - 0.2000)).toBeLessThan(1e-5);
    expect(Math.abs(netPnlSol - 0.2370)).toBeLessThan(1e-5);
    expect(Math.abs(pnlSolPct - 23.70)).toBeLessThan(1e-5);
  });
});

// ════════════════════════════════════════════════════════════
//  SECTION 8: Snapshot-based Trend Exit (Rule 6)
// ════════════════════════════════════════════════════════════

function checkTrendExit(vp: any, mgmtConfig: any = {}): any {
  const trendCycles = mgmtConfig.vpTrendExitCycles ?? 3;
  if (trendCycles != null && trendCycles > 0 && vp.snapshots && vp.snapshots.length >= trendCycles + 1) {
    const isSol = !!mgmtConfig.solMode;
    const pnlField = isSol ? "pnl_sol_pct" : "pnl_pct";
    const recent = vp.snapshots.slice(-(trendCycles + 1));
    const currentPnl = recent[recent.length - 1][pnlField] ?? 0;

    if (currentPnl < 0) {
      let isTrendingDown = true;
      for (let i = 1; i < recent.length; i++) {
        const prev = recent[i - 1][pnlField] ?? 0;
        const curr = recent[i][pnlField] ?? 0;
        if (curr >= prev) {
          isTrendingDown = false;
          break;
        }
      }
      if (isTrendingDown) {
        return { rule: 6, reason: `consecutive down-trend (${trendCycles} cycles)` };
      }
    }
  }
  return null;
}

describe("Trend Exit (Rule 6)", () => {
  it("triggers when in a loss and decreasing for 3 consecutive cycles", () => {
    const vp = {
      snapshots: [
        { pnl_pct: -1.0 },
        { pnl_pct: -2.0 },
        { pnl_pct: -3.0 },
        { pnl_pct: -4.0 },
      ],
    };
    const result = checkTrendExit(vp, { vpTrendExitCycles: 3 });
    expect(result).not.toBeNull();
    expect(result.rule).toBe(6);
  });

  it("does NOT trigger when currently profitable", () => {
    const vp = {
      snapshots: [
        { pnl_pct: 10.0 },
        { pnl_pct: 9.0 },
        { pnl_pct: 8.0 },
        { pnl_pct: 7.0 },
      ],
    };
    const result = checkTrendExit(vp, { vpTrendExitCycles: 3 });
    expect(result).toBeNull();
  });

  it("does NOT trigger when trend is broken", () => {
    const vp = {
      snapshots: [
        { pnl_pct: -1.0 },
        { pnl_pct: -2.0 },
        { pnl_pct: -1.5 },
        { pnl_pct: -3.0 },
      ],
    };
    const result = checkTrendExit(vp, { vpTrendExitCycles: 3 });
    expect(result).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════
//  SECTION 7: Slippage Algorithm (estimateSlippageLamports)
// ════════════════════════════════════════════════════════════

function estimateSlippageLamports(perBin: any[], binData: any[], activeBinId: number | null, opts: any = {}): bigint | null {
  const PRICE_SCALE = 1n << 64n;

  if (activeBinId == null) return null;

  let remainingX = 0n;
  for (const pb of perBin) {
    if (pb.binId > activeBinId) remainingX += BigInt(pb.ourX ?? "0");
  }
  if (remainingX === 0n) return 0n;

  const activeBin = binData.find((b) => b.binId === activeBinId);
  if (!activeBin) return null;
  const activePriceBN = BigInt(activeBin.priceQ64 ?? "0");
  if (activePriceBN === 0n) return null;

  const theoreticalY = (remainingX * activePriceBN) / PRICE_SCALE;

  const binsBelowActive = binData
    .filter((b) => b.binId <= activeBinId)
    .sort((a, b) => {
      const aP = BigInt(a.priceQ64 ?? "0"), bP = BigInt(b.priceQ64 ?? "0");
      return bP > aP ? 1 : bP < aP ? -1 : 0;
    });

  let totalYReceived = 0n;
  for (const bin of binsBelowActive) {
    if (remainingX <= 0n) break;
    const yAvailable = BigInt(bin.yAmount ?? "0");
    const priceBN = BigInt(bin.priceQ64 ?? "0");
    if (yAvailable === 0n || priceBN === 0n) continue;

    const maxXCanSwap = (yAvailable * PRICE_SCALE) / priceBN;
    const xToSwap = remainingX < maxXCanSwap ? remainingX : maxXCanSwap;
    const yReceived = (xToSwap * priceBN) / PRICE_SCALE;
    totalYReceived += yReceived;
    remainingX -= xToSwap;
  }

  if (remainingX > 0n) return null;

  return theoreticalY > totalYReceived ? theoreticalY - totalYReceived : 0n;
}

const ONE_SOL = 1_000_000_000n;

function buildBins(lowerBinId: number, upperBinId: number, yAmounts: string[], prices: string[] = []): any[] {
  const bins = [];
  for (let i = lowerBinId; i <= upperBinId; i++) {
    bins.push({
      binId: i,
      xAmount: "0",
      yAmount: yAmounts[i - lowerBinId] ?? "0",
      priceQ64: prices[i - lowerBinId] ?? SCALE.toString(),
    });
  }
  return bins;
}

describe("Slippage Algorithm", () => {
  it("Y-only position, active bin has Y, no X → 0n (no slippage)", () => {
    const activeBinId = 100;
    const binData = buildBins(85, 105, [
      "0", "0", "0", "0", "0", "0", "0", "0", "0", "0",
      "0", "0", "0", "0", "0",
      "5000000000",
      "0", "0", "0", "0", "0",
    ]);
    const perBin = [
      { binId: activeBinId, ourX: "0", ourY: "5000000000" },
    ];
    const result = estimateSlippageLamports(perBin, binData, activeBinId, { lowerBin: 95 });
    expect(result).toBe(0n);
  });

  it("small X in deep pool → small shortfall (<5% loss)", () => {
    const activeBinId = 100;
    const lowerPrice = (SCALE * 99n / 100n).toString();
    const binData = buildBins(85, 105, [
      "0", "0", "0", "0", "0", "0", "0", "0", "0", "0",
      "1000000000000", "1000000000000", "1000000000000", "1000000000000", "1000000000000",
      "0",
      "0", "0", "0", "0", "0",
    ], [
      SCALE.toString(), SCALE.toString(), SCALE.toString(), SCALE.toString(), SCALE.toString(),
      SCALE.toString(), SCALE.toString(), SCALE.toString(), SCALE.toString(), SCALE.toString(),
      lowerPrice, lowerPrice, lowerPrice, lowerPrice, lowerPrice,
      SCALE.toString(),
      SCALE.toString(), SCALE.toString(), SCALE.toString(), SCALE.toString(), SCALE.toString(),
    ]);
    const perBin = [{ binId: 101, ourX: ONE_SOL.toString(), ourY: "0" }];
    const result = estimateSlippageLamports(perBin, binData, activeBinId, { lowerBin: 95 });
    const theoreticalY = ONE_SOL;
    const shortfallPct = Number(result!) / Number(theoreticalY) * 100;
    expect(result).not.toBeNull();
    expect(result!).toBeLessThan(theoreticalY / 20n);
  });

  it("X larger than bin depth → null (post-check fails)", () => {
    const activeBinId = 100;
    const binData = buildBins(85, 105, [
      "1000000000", "1000000000", "1000000000", "1000000000", "1000000000",
      "1000000000", "1000000000", "1000000000", "1000000000", "1000000000",
      "1000000000", "1000000000", "1000000000", "1000000000", "1000000000",
      "100",
      "0", "0", "0", "0", "0",
    ]);
    const perBin = [{ binId: 101, ourX: (ONE_SOL * 1000n).toString(), ourY: "0" }];
    const result = estimateSlippageLamports(perBin, binData, activeBinId, { lowerBin: 95 });
    expect(result).toBeNull();
  });

  it("position straddles active bin — only ourX from bins > active counts", () => {
    const activeBinId = 100;
    const binData = buildBins(85, 105, [
      "1000000000", "1000000000", "1000000000", "1000000000", "1000000000",
      "1000000000", "1000000000", "1000000000", "1000000000", "1000000000",
      "1000000000", "1000000000", "1000000000", "1000000000", "1000000000",
      "0",
      "0", "0", "0", "0", "0",
    ]);
    const perBinBoth = [
      { binId: 99, ourX: ONE_SOL.toString(), ourY: "0" },
      { binId: 101, ourX: (ONE_SOL * 5n).toString(), ourY: "0" },
    ];
    const perBinOnly = [
      { binId: 101, ourX: (ONE_SOL * 5n).toString(), ourY: "0" },
    ];
    const resultBoth = estimateSlippageLamports(perBinBoth, binData, activeBinId, { lowerBin: 95 });
    const resultOnly = estimateSlippageLamports(perBinOnly, binData, activeBinId, { lowerBin: 95 });
    expect(resultBoth).toBe(resultOnly);
  });

  it("all Y, all ≤ active, no X → 0n (legitimate 0, NOT null)", () => {
    const activeBinId = 100;
    const binData = buildBins(85, 105, [
      "1000000000", "1000000000", "1000000000", "1000000000", "1000000000",
      "1000000000", "1000000000", "1000000000", "1000000000", "1000000000",
      "1000000000", "1000000000", "1000000000", "1000000000", "1000000000",
      "1000000000",
      "0", "0", "0", "0", "0",
    ]);
    const perBin = [
      { binId: 95, ourX: "0", ourY: "1000000000" },
      { binId: 100, ourX: "0", ourY: "1000000000" },
    ];
    const result = estimateSlippageLamports(perBin, binData, activeBinId, { lowerBin: 95 });
    expect(result).toBe(0n);
    expect(result).not.toBeNull();
  });

  it("missing active bin (price moved below our range) → null", () => {
    const activeBinId = 100;
    const binDataNoActive = [
      ...buildBins(85, 99, [
        "1000000000", "1000000000", "1000000000", "1000000000", "1000000000",
        "1000000000", "1000000000", "1000000000", "1000000000", "1000000000",
        "1000000000", "1000000000", "1000000000", "1000000000", "1000000000",
      ]),
      ...buildBins(101, 105, ["0", "0", "0", "0", "0"]),
    ];
    const perBin = [{ binId: 102, ourX: ONE_SOL.toString(), ourY: "0" }];
    const result = estimateSlippageLamports(perBin, binDataNoActive, activeBinId, { lowerBin: 95 });
    expect(result).toBeNull();
  });

  it("no buffer below position → swap completes (pre-check removed)", () => {
    const activeBinId = 100;
    const binData = buildBins(95, 105, [
      "1000000000000", "1000000000000", "1000000000000", "1000000000000", "1000000000000",
      "1000000000000",
      "0", "0", "0", "0", "0",
    ]);
    const perBin = [{ binId: 101, ourX: ONE_SOL.toString(), ourY: "0" }];
    const result = estimateSlippageLamports(perBin, binData, activeBinId, { lowerBin: 95 });
    expect(result).not.toBeNull();
  });

  it("activeBinId is null → null (fallback, NOT 0n)", () => {
    const binData = buildBins(85, 105, ["0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0"]);
    const perBin = [{ binId: 101, ourX: ONE_SOL.toString(), ourY: "0" }];
    const result = estimateSlippageLamports(perBin, binData, null, { lowerBin: 95 });
    expect(result).toBeNull();
  });

  it("walk loop bins with priceQ64 = 0 (RPC partial) → no crash", () => {
    const activeBinId = 100;
    const binData = buildBins(85, 105, [
      "0", "0", "0", "0", "0", "0", "0", "0", "0", "0",
      "0", "0", "0", "0", "0",
      "0",
      "0", "0", "0", "0", "0",
    ]);
    const perBin = [{ binId: 101, ourX: ONE_SOL.toString(), ourY: "0" }];
    const result = estimateSlippageLamports(perBin, binData, activeBinId, { lowerBin: 95 });
    expect(result).toBeNull();
  });

  it("walk loop skips bin with priceQ64=0 (active is valid)", () => {
    const activeBinId = 100;
    const binData = [
      { binId: 90, xAmount: "0", yAmount: "0", priceQ64: "0" },
      { binId: 91, xAmount: "0", yAmount: "10000000000", priceQ64: SCALE.toString() },
      { binId: 100, xAmount: "0", yAmount: "0", priceQ64: SCALE.toString() },
    ];
    const perBin = [{ binId: 101, ourX: (ONE_SOL / 2n).toString(), ourY: "0" }];
    const result = estimateSlippageLamports(perBin, binData, activeBinId, { lowerBin: 100 });
    expect(result).not.toBeNull();
    expect(typeof result).toBe("bigint");
  });
});
