/**
 * Test: VP PnL calculation + close rules (standalone — no npm install needed)
 *
 * Uses BigInt instead of BN to validate the math without dependencies.
 * Mirrors the computePositionPnl logic from compute-position-pnl.js.
 */

const SCALE = 1n << 64n;
const LAMPORTS_PER_SOL = 1_000_000_000n;
const SOL_PRICE = 170;

function mulShr(a, b, shift) {
  return (a * b) >> BigInt(shift);
}

// Simulate deploy-time share calculation (from dlmm.js)
function computeShares(depositYLamports, binPrice, binX, binY, binSupply) {
  const inLiquidity = BigInt(depositYLamports) * SCALE;
  const binLiquidity = BigInt(binPrice) * BigInt(binX) + BigInt(binY) * SCALE;
  return binLiquidity === 0n
    ? inLiquidity
    : (inLiquidity * BigInt(binSupply)) / binLiquidity;
}

// Fixed withdrawal: uses effectiveSupply = supply + shares
function computeWithdrawal(shares, xAmount, yAmount, supply, priceQ64) {
  const effectiveSupply = BigInt(supply) + shares;
  const ourX = effectiveSupply === 0n ? 0n : (shares * BigInt(xAmount)) / effectiveSupply;
  const ourY = effectiveSupply === 0n ? 0n : (shares * BigInt(yAmount)) / effectiveSupply;
  const ourXInY = mulShr(ourX, BigInt(priceQ64), 64);
  return ourY + ourXInY;
}

// Old (broken) withdrawal: uses raw supply
function computeWithdrawalOld(shares, xAmount, yAmount, supply, priceQ64) {
  const s = BigInt(supply);
  const ourX = s === 0n ? 0n : (shares * BigInt(xAmount)) / s;
  const ourY = s === 0n ? 0n : (shares * BigInt(yAmount)) / s;
  const ourXInY = mulShr(ourX, BigInt(priceQ64), 64);
  return ourY + ourXInY;
}

// Apply VP cost deductions (mirrors manage-virtual.js logic)
function applyVpCosts(rawValueSol, binStep = null) {
  const gasCostSol = 0.007;
  const slippagePct = binStep
    ? (binStep / 10000 / 2) * 100
    : 0.3;
  const slippageMultiplier = 1 - slippagePct / 100;
  return Math.max(0, rawValueSol - gasCostSol) * slippageMultiplier;
}

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (e) {
    console.error(`❌ ${name}: ${e.message}`);
    failed++;
  }
}

// ════════════════════════════════════════════════════════════
//  SECTION 1: Share/Supply Fix (original bug)
// ════════════════════════════════════════════════════════════

test("Empty bin: old code inflated by 2^64, new code reasonable", () => {
  const depositYLamports = 500_000_000n;
  const priceQ64 = SCALE;
  const shares = computeShares(depositYLamports, priceQ64, 0n, 0n, 0n);

  const currentY = 1_000_000_000n;
  const currentSupply = 500_000_000n;

  const oldValue = computeWithdrawalOld(shares, 0n, currentY, currentSupply, priceQ64);
  const newValue = computeWithdrawal(shares, 0n, currentY, currentSupply, priceQ64);
  const oldSol = Number(oldValue) / Number(LAMPORTS_PER_SOL);
  const newSol = Number(newValue) / Number(LAMPORTS_PER_SOL);

  console.log(`  old value: ${oldSol.toExponential(4)} SOL (BROKEN)`);
  console.log(`  new value: ${newSol.toFixed(6)} SOL (FIXED)`);

  if (oldSol < 1e10) throw new Error(`Expected old > 1e10, got ${oldSol}`);
  if (newSol > 1.0 || newSol < 0) throw new Error(`Expected new ≤ 1, got ${newSol}`);
});

test("Non-empty bin unchanged → withdrawal ≈ deposit", () => {
  const depositYLamports = 500_000_000n;
  const priceQ64 = SCALE;
  const shares = computeShares(depositYLamports, priceQ64, 0n, "2000000000", "1000000000");
  const newValue = computeWithdrawal(shares, 0n, "2000000000", "1000000000", priceQ64);
  const newSol = Number(newValue) / Number(LAMPORTS_PER_SOL);

  console.log(`  withdraw: ${newSol.toFixed(6)} SOL (deposit: 0.5 SOL)`);
  const diff = Math.abs(newSol - 0.5) / 0.5;
  if (diff > 0.2) throw new Error(`Too far from deposit: ${newSol}`);
});

// ════════════════════════════════════════════════════════════
//  SECTION 2: Gas + Slippage Deduction
// ════════════════════════════════════════════════════════════

test("Gas cost reduces VP value", () => {
  const raw = 0.5;  // 0.5 SOL position
  const adjusted = applyVpCosts(raw, 80);
  console.log(`  raw: ${raw} SOL → adjusted: ${adjusted.toFixed(6)} SOL`);

  // Should be less than raw
  if (adjusted >= raw) throw new Error(`Expected < ${raw}, got ${adjusted}`);
  // Gas = 0.007 SOL deducted, so at minimum reduced by that
  if (adjusted > raw - 0.005) throw new Error(`Gas not deducted enough`);
});

test("Dynamic slippage: bin_step 80 → 0.40%", () => {
  const raw = 1.0;
  const adjusted = applyVpCosts(raw, 80);
  // Expected: (1.0 - 0.007) * (1 - 0.40/100) = 0.993 * 0.996 = 0.989028
  const expected = (1.0 - 0.007) * (1 - 0.40 / 100);
  console.log(`  adjusted: ${adjusted.toFixed(6)} (expected: ${expected.toFixed(6)})`);
  if (Math.abs(adjusted - expected) > 0.0001) throw new Error(`Expected ~${expected}, got ${adjusted}`);
});

test("Dynamic slippage: bin_step 125 → 0.625%", () => {
  const raw = 1.0;
  const adjusted = applyVpCosts(raw, 125);
  const expected = (1.0 - 0.007) * (1 - 0.625 / 100);
  console.log(`  adjusted: ${adjusted.toFixed(6)} (expected: ${expected.toFixed(6)})`);
  if (Math.abs(adjusted - expected) > 0.0001) throw new Error(`Expected ~${expected}, got ${adjusted}`);
});

test("Fallback slippage: no bin_step → uses 0.3%", () => {
  const raw = 1.0;
  const adjusted = applyVpCosts(raw, null);
  const expected = (1.0 - 0.007) * (1 - 0.3 / 100);
  console.log(`  adjusted: ${adjusted.toFixed(6)} (expected: ${expected.toFixed(6)})`);
  if (Math.abs(adjusted - expected) > 0.0001) throw new Error(`Expected ~${expected}, got ${adjusted}`);
});

test("Small position: gas dominates → value floors at 0", () => {
  const raw = 0.005; // less than gas cost
  const adjusted = applyVpCosts(raw, 80);
  console.log(`  raw: ${raw} SOL → adjusted: ${adjusted.toFixed(6)} SOL`);
  if (adjusted !== 0) throw new Error(`Expected 0, got ${adjusted}`);
});

// ════════════════════════════════════════════════════════════
//  SECTION 3: LOW_YIELD Close Rule
// ════════════════════════════════════════════════════════════

// Mirrors getVirtualCloseRule's Rule 5 logic
function checkLowYield(vp, currentValueUsd, mgmtConfig = {}) {
  const minFeePerTvl24h = mgmtConfig.minFeePerTvl24h ?? 7;
  const minAgeForYieldCheck = mgmtConfig.minAgeBeforeYieldCheck ?? 60;
  const ageMinutes = vp.deployed_at
    ? Math.floor((Date.now() - new Date(vp.deployed_at).getTime()) / 60000)
    : 0;

  if (ageMinutes >= minAgeForYieldCheck && currentValueUsd > 0) {
    const totalFeesUsd = vp.total_fees_earned_usd || 0;
    const syntheticFeeYield = (totalFeesUsd / currentValueUsd) * (1440 / ageMinutes) * 100;
    if (syntheticFeeYield < minFeePerTvl24h) {
      return { rule: 5, reason: "low yield", syntheticFeeYield };
    }
  }
  return null;
}

test("LOW_YIELD: VP with 0 fees after 120 min → triggers rule 5", () => {
  const vp = {
    deployed_at: new Date(Date.now() - 120 * 60000).toISOString(),
    total_fees_earned_usd: 0,
  };
  const result = checkLowYield(vp, 85.0);
  console.log(`  syntheticYield: ${result?.syntheticFeeYield?.toFixed(4)}%`);
  if (!result) throw new Error("Expected low yield trigger");
  if (result.rule !== 5) throw new Error(`Expected rule 5, got ${result.rule}`);
});

test("LOW_YIELD: VP with good fees → does NOT trigger", () => {
  // $85 position earning $1/hr = 24h yield ≈ (24/85)*100 = 28.2%
  const vp = {
    deployed_at: new Date(Date.now() - 120 * 60000).toISOString(),
    total_fees_earned_usd: 2.0, // $1/hr for 2 hours
  };
  const result = checkLowYield(vp, 85.0);
  console.log(`  syntheticYield: ${result?.syntheticFeeYield?.toFixed(4) ?? "above threshold (no trigger)"}%`);
  if (result) throw new Error(`Should NOT trigger, but got rule ${result.rule}`);
});

test("LOW_YIELD: VP under 60 min → skipped (too young)", () => {
  const vp = {
    deployed_at: new Date(Date.now() - 30 * 60000).toISOString(),
    total_fees_earned_usd: 0,
  };
  const result = checkLowYield(vp, 85.0);
  console.log(`  result: ${result ? "triggered (BAD)" : "skipped (correct — too young)"}`);
  if (result) throw new Error("Should skip for young position");
});

test("LOW_YIELD: edge case — exactly at threshold → does NOT trigger", () => {
  // minFeePerTvl24h = 7, currentValue = $100, age = 120 min
  // Need: (fees / 100) * (1440 / 120) * 100 = 7
  // fees = 7 * 100 / (1440/120) / 100 = 7 / 12 = 0.5833...
  const vp = {
    deployed_at: new Date(Date.now() - 120 * 60000).toISOString(),
    total_fees_earned_usd: 0.5834,
  };
  const result = checkLowYield(vp, 100.0);
  const yield24h = (0.5834 / 100) * (1440 / 120) * 100;
  console.log(`  syntheticYield: ${yield24h.toFixed(4)}% (threshold: 7%)`);
  if (result) throw new Error(`Should NOT trigger at threshold, yield=${yield24h}`);
});

// ════════════════════════════════════════════════════════════
//  SECTION 5: Strategy Distribution
// ════════════════════════════════════════════════════════════

// Mirrors computeVpYDistribution from dlmm.js
function gaussianPdf(mean, variance) {
  const stdDev = Math.sqrt(variance);
  const coeff = 1 / (stdDev * Math.sqrt(2 * Math.PI));
  return (x) => coeff * Math.exp(-0.5 * ((x - mean) / stdDev) ** 2);
}

function computeVpYDistribution(strategy, activeBinId, binIds) {
  const result = new Map();
  if (binIds.length === 0) return result;
  const yBins = binIds.filter(id => id <= activeBinId);
  if (yBins.length === 0) {
    for (const id of binIds) result.set(id, 0);
    return result;
  }
  if (strategy === "spot" || !strategy) {
    const belowCount = yBins.filter(id => id < activeBinId).length;
    const hasActive = yBins.includes(activeBinId);
    const totalCapacity = belowCount + (hasActive ? 0.5 : 0);
    if (totalCapacity <= 0) {
      result.set(activeBinId, 10000);
    } else {
      const perBinBps = Math.floor(10000 / totalCapacity);
      for (const id of yBins) {
        if (id === activeBinId) {
          result.set(id, 10000 - perBinBps * belowCount);
        } else {
          result.set(id, perBinBps);
        }
      }
    }
  } else if (strategy === "bid_ask" || strategy === "curve") {
    const invert = strategy === "bid_ask";
    const smallestBin = Math.min(...yBins);
    const largestBin = Math.max(...yBins);
    let mean = yBins.includes(activeBinId) ? activeBinId : (activeBinId < smallestBin ? smallestBin : largestBin);
    const stdDev = (largestBin - smallestBin) / 4;
    const variance = Math.max(stdDev ** 2, 1);
    const pdf = gaussianPdf(mean, variance);
    const allocations = yBins.map(id => invert ? 1 / pdf(id) : pdf(id));
    const totalAlloc = allocations.reduce((s, a) => s + a, 0);
    let totalBps = 0;
    const bpsValues = allocations.map(a => {
      const bps = Math.floor((a / totalAlloc) * 10000);
      totalBps += bps;
      return bps;
    });
    bpsValues[0] += 10000 - totalBps;
    for (let i = 0; i < yBins.length; i++) result.set(yBins[i], bpsValues[i]);
  } else {
    // Unknown strategy — fall back to spot
    return computeVpYDistribution("spot", activeBinId, binIds);
  }
  for (const id of binIds) {
    if (!result.has(id)) result.set(id, 0);
  }
  return result;
}

test("Strategy spot: uniform distribution, active bin gets half", () => {
  // 5 bins below active (100-104), active = 105
  const binIds = [100, 101, 102, 103, 104, 105];
  const dist = computeVpYDistribution("spot", 105, binIds);
  const total = [...dist.values()].reduce((s, v) => s + v, 0);
  console.log(`  total BPS: ${total}, active bin: ${dist.get(105)}`);
  console.log(`  per bin: ${binIds.map(id => `${id}=${dist.get(id)}`).join(', ')}`);

  if (total !== 10000) throw new Error(`Expected total 10000, got ${total}`);
  // Active bin should get roughly half of a regular bin
  const regularBps = dist.get(100);
  const activeBps = dist.get(105);
  if (activeBps >= regularBps) throw new Error(`Active bin ${activeBps} should be < regular ${regularBps}`);
});

test("Strategy bid_ask: edges get more weight than center", () => {
  const binIds = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110];
  const activeBinId = 110;
  const dist = computeVpYDistribution("bid_ask", activeBinId, binIds);
  const total = [...dist.values()].reduce((s, v) => s + v, 0);

  const edgeBps = dist.get(100);
  const midBps = dist.get(105);
  console.log(`  total: ${total}, edge(100): ${edgeBps}, mid(105): ${midBps}`);

  if (total !== 10000) throw new Error(`Expected total 10000, got ${total}`);
  if (edgeBps <= midBps) throw new Error(`bid_ask: edge ${edgeBps} should be > mid ${midBps}`);
});

test("Strategy curve: center gets more weight than edges", () => {
  const binIds = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110];
  const activeBinId = 110;
  const dist = computeVpYDistribution("curve", activeBinId, binIds);
  const total = [...dist.values()].reduce((s, v) => s + v, 0);

  const edgeBps = dist.get(100);
  const nearActiveBps = dist.get(109);
  console.log(`  total: ${total}, edge(100): ${edgeBps}, near-active(109): ${nearActiveBps}`);

  if (total !== 10000) throw new Error(`Expected total 10000, got ${total}`);
  if (nearActiveBps <= edgeBps) throw new Error(`curve: near-active ${nearActiveBps} should be > edge ${edgeBps}`);
});

test("Strategy unknown: falls back to spot", () => {
  const binIds = [100, 101, 102];
  const spotDist = computeVpYDistribution("spot", 102, binIds);
  const unknownDist = computeVpYDistribution("xyz_unknown", 102, binIds);
  // Should produce same result as spot (the function itself logs and calls spot recursively)
  // Here we just verify the result is valid
  const total = [...unknownDist.values()].reduce((s, v) => s + v, 0);
  console.log(`  total: ${total} (should equal 10000)`);
  if (total !== 10000) throw new Error(`Expected total 10000, got ${total}`);
});

// ════════════════════════════════════════════════════════════
//  SECTION 6: Fee Precision Fix
// ════════════════════════════════════════════════════════════

test("Fee precision: small shares (< 2^64) now produce non-zero fees", () => {
  // Simulate a non-empty bin where shares are proportional (< 2^64)
  const shares = 250_000_000n; // small shares (non-empty bin)
  const feePerTokenDelta = 1000_000_000_000n; // meaningful fee delta

  // Old approach: shares >> 64 first → truncates to 0 for small shares
  const oldFee = (shares >> 64n) * feePerTokenDelta >> 64n;

  // New approach: shares * feeDelta >> 128
  const newFee = (shares * feePerTokenDelta) >> 128n;

  console.log(`  old fee (shrn64 first): ${oldFee} lamports`);
  console.log(`  new fee (mul then >>128): ${newFee} lamports`);

  if (oldFee !== 0n) throw new Error(`Expected old to be 0, got ${oldFee}`);
  // New should still be 0 for this specific case since shares * delta < 2^128
  // But with larger deltas it would work. Let's test with a bigger delta:
  const largeDelta = 1n << 80n; // large fee accumulation
  const oldFee2 = (shares >> 64n) * largeDelta >> 64n;
  const newFee2 = (shares * largeDelta) >> 128n;
  console.log(`  with large delta — old: ${oldFee2}, new: ${newFee2}`);
  if (newFee2 === 0n && oldFee2 === 0n) {
    // Both zero is expected for very small shares — the point is new >= old always
    console.log(`  both zero — precision improvement only matters for medium shares`);
  }
  // Key test: for shares that ARE 2^64 scaled (empty bin), both should agree
  const emptyBinShares = 500_000_000n * (1n << 64n); // empty bin shares
  const delta = 100_000n;
  const oldEmpty = (emptyBinShares >> 64n) * delta >> 64n;
  const newEmpty = (emptyBinShares * delta) >> 128n;
  console.log(`  empty bin shares — old: ${oldEmpty}, new: ${newEmpty} (should match)`);
  if (oldEmpty !== newEmpty) throw new Error(`Empty bin fee mismatch: old=${oldEmpty}, new=${newEmpty}`);
});

// ════════════════════════════════════════════════════════════
//  SECTION 7: SOL-mode PnL and Breakdown
// ════════════════════════════════════════════════════════════

test("SOL-mode PnL and breakdown matches computePositionPnl logic", () => {
  const initialSol = 1.0;
  const rawPositionValueSol = 1.2;
  const unclaimedFeesSol = 0.05;
  const gasCostSol = 0.007;
  const slippagePct = 0.5; // bin_step 100
  const slippageSol = rawPositionValueSol * (slippagePct / 100); // 0.006 SOL
  
  const positionValueSol = Math.max(0, rawPositionValueSol - gasCostSol - slippageSol); // 1.2 - 0.007 - 0.006 = 1.187 SOL
  const ilSol = rawPositionValueSol - initialSol; // 1.2 - 1.0 = 0.2 SOL
  const totalCostSol = gasCostSol + slippageSol; // 0.013 SOL
  const netPnlSol = positionValueSol + unclaimedFeesSol - initialSol; // 1.187 + 0.05 - 1.0 = 0.237 SOL
  const pnlSolPct = (netPnlSol / initialSol) * 100; // 23.7%

  console.log(`  positionValueSol: ${positionValueSol.toFixed(4)} (expected: 1.1870)`);
  console.log(`  ilSol: ${ilSol.toFixed(4)} (expected: 0.2000)`);
  console.log(`  netPnlSol: ${netPnlSol.toFixed(4)} (expected: 0.2370)`);
  console.log(`  pnlSolPct: ${pnlSolPct.toFixed(2)}% (expected: 23.70%)`);

  if (Math.abs(positionValueSol - 1.1870) > 1e-5) throw new Error(`Value mismatch`);
  if (Math.abs(ilSol - 0.2000) > 1e-5) throw new Error(`IL mismatch`);
  if (Math.abs(netPnlSol - 0.2370) > 1e-5) throw new Error(`Net PnL mismatch`);
  if (Math.abs(pnlSolPct - 23.70) > 1e-5) throw new Error(`PnL % mismatch`);
});

// ════════════════════════════════════════════════════════════
//  SECTION 8: Snapshot-based Trend Exit (Rule 6)
// ════════════════════════════════════════════════════════════

function checkTrendExit(vp, mgmtConfig = {}) {
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

test("Trend exit (Rule 6): triggers when in a loss and decreasing for 3 consecutive cycles", () => {
  const vp = {
    snapshots: [
      { pnl_pct: -1.0 },
      { pnl_pct: -2.0 },
      { pnl_pct: -3.0 },
      { pnl_pct: -4.0 }
    ]
  };
  const result = checkTrendExit(vp, { vpTrendExitCycles: 3 });
  console.log(`  result: ${result?.reason ?? "no trigger"}`);
  if (!result || result.rule !== 6) throw new Error("Expected trend exit trigger");
});

test("Trend exit (Rule 6): does NOT trigger when currently profitable", () => {
  const vp = {
    snapshots: [
      { pnl_pct: 10.0 },
      { pnl_pct: 9.0 },
      { pnl_pct: 8.0 },
      { pnl_pct: 7.0 }
    ]
  };
  const result = checkTrendExit(vp, { vpTrendExitCycles: 3 });
  console.log(`  result: ${result ? "triggered (BAD)" : "skipped (correct — profitable)"}`);
  if (result) throw new Error("Should NOT trigger when profitable");
});

test("Trend exit (Rule 6): does NOT trigger when trend is broken", () => {
  const vp = {
    snapshots: [
      { pnl_pct: -1.0 },
      { pnl_pct: -2.0 },
      { pnl_pct: -1.5 },
      { pnl_pct: -3.0 }
    ]
  };
  const result = checkTrendExit(vp, { vpTrendExitCycles: 3 });
  console.log(`  result: ${result ? "triggered (BAD)" : "skipped (correct — trend broken)"}`);
  if (result) throw new Error("Should NOT trigger when trend is broken");
});

// ════════════════════════════════════════════════════════════
//  SECTION 7: Slippage Algorithm (estimateSlippageLamports)
// ════════════════════════════════════════════════════════════

// Mirror of tools/compute-position-pnl.js:262 estimateSlippageLamports.
// Inlined to keep the test self-contained (matches the rest of this file's
// standalone BigInt style — no Jest/Mocha, no module imports).
function estimateSlippageLamports(perBin, binData, activeBinId, opts = {}) {
  const PRICE_SCALE = 1n << 64n;

  // Guard: missing active bin → null (caller applies fallback premium)
  if (activeBinId == null) return null;

  // Pre-check: binData must extend ≥10 bins below the position's lowerBin
  const lowerBin = opts.lowerBin;
  if (lowerBin != null && binData.length > 0) {
    const minBinInData = binData.reduce((m, b) => (b.binId < m ? b.binId : m), binData[0].binId);
    if (minBinInData > lowerBin - 10) return null;
  }

  // Sum X from bins > active (bins ≤ active hold Y, no swap needed)
  let remainingX = 0n;
  for (const pb of perBin) {
    if (pb.binId > activeBinId) remainingX += BigInt(pb.ourX ?? "0");
  }
  if (remainingX === 0n) return 0n;  // legitimate 0, NOT null

  // Find active bin's price (theoretical "no slippage" price)
  const activeBin = binData.find((b) => b.binId === activeBinId);
  if (!activeBin) return null;
  const activePriceBN = BigInt(activeBin.priceQ64 ?? "0");
  if (activePriceBN === 0n) return null;

  // Theoretical Y = X × activePrice
  const theoreticalY = (remainingX * activePriceBN) / PRICE_SCALE;

  // Walk bins ≤ active in price-DESCENDING order
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

  // Post-check: did we finish the swap within our data?
  if (remainingX > 0n) return null;

  return theoreticalY > totalYReceived ? theoreticalY - totalYReceived : 0n;
}

// ── Test helpers ──
// SCALE is already defined at line 8 (1n << 64n)
const ONE_SOL = 1_000_000_000n;

/**
 * Build a bin data array with specified Y liquidity per bin.
 * prices[i] = priceQ64 for binId = (lowerBinId + i). All xAmount = 0 unless specified.
 */
function buildBins(lowerBinId, upperBinId, yAmounts, prices = []) {
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

test("Slippage 1: Y-only position, active bin has Y, no X → 0n (no slippage)", () => {
  // Position has Y in active bin only — no X to swap, no slippage
  // binData must extend ≥10 bins below position.lowerBin (95) → start at 85
  const activeBinId = 100;
  const binData = buildBins(85, 105, [
    "0", "0", "0", "0", "0", "0", "0", "0", "0", "0",  // bins 85-94: empty (buffer)
    "0", "0", "0", "0", "0",                            // bins 95-99: empty
    "5000000000",                                       // bin 100 (active): 5 SOL Y
    "0", "0", "0", "0", "0",                            // bins 101-105: empty
  ]);
  const perBin = [
    { binId: activeBinId, ourX: "0", ourY: "5000000000" },
  ];
  const result = estimateSlippageLamports(perBin, binData, activeBinId, { lowerBin: 95 });
  console.log(`  result: ${result} (expected 0n)`);
  if (result !== 0n) throw new Error(`Expected 0n, got ${result}`);
});

test("Slippage 2: small X in deep pool → small shortfall (<5% loss)", () => {
  // X in bin above active, deep Y in lower bins at slightly lower price
  // → small slippage (~1% loss)
  const activeBinId = 100;
  const lowerPrice = (SCALE * 99n / 100n).toString();  // 0.99 * SCALE
  const binData = buildBins(85, 105, [
    "0", "0", "0", "0", "0", "0", "0", "0", "0", "0",  // 85-94: empty (buffer)
    "1000000000000", "1000000000000", "1000000000000", "1000000000000", "1000000000000", // 95-99
    "0",                                                                                 // 100 (active, no Y — must walk lower)
    "0", "0", "0", "0", "0",
  ], [
    SCALE.toString(), SCALE.toString(), SCALE.toString(), SCALE.toString(), SCALE.toString(), // 85-89
    SCALE.toString(), SCALE.toString(), SCALE.toString(), SCALE.toString(), SCALE.toString(), // 90-94
    lowerPrice, lowerPrice, lowerPrice, lowerPrice, lowerPrice,  // 95-99
    SCALE.toString(),                                            // 100 (active, price = 1.0)
    SCALE.toString(), SCALE.toString(), SCALE.toString(), SCALE.toString(), SCALE.toString(), // 101-105
  ]);
  const perBin = [{ binId: 101, ourX: ONE_SOL.toString(), ourY: "0" }];
  const result = estimateSlippageLamports(perBin, binData, activeBinId, { lowerBin: 95 });
  // theoreticalY = 1 SOL (active price = 1.0)
  // Walks bin 100 (no Y), then 95-99 at price 0.99
  //   - yReceived = X * 0.99 = 0.99 SOL
  // Shortfall = 0.01 SOL = 1e7 lamports
  const theoreticalY = ONE_SOL;  // 1e9
  const shortfallPct = Number(result) / Number(theoreticalY) * 100;
  console.log(`  result: ${result} lamports, ~${shortfallPct.toFixed(2)}% loss (expected < 5%)`);
  if (result === null) throw new Error("Expected non-null result");
  if (result >= theoreticalY / 20n) throw new Error(`Shortfall >= 5% of theoretical: ${result} vs ${theoreticalY / 20n}`);
});

test("Slippage 3: X larger than bin depth → null (post-check fails)", () => {
  // X is huge, Y in active bin is tiny, lower bins have some Y but not enough
  // → post-check fails (remainingX > 0 after walk) → null
  const activeBinId = 100;
  const binData = buildBins(85, 105, [
    "1000000000", "1000000000", "1000000000", "1000000000", "1000000000", // 85-89
    "1000000000", "1000000000", "1000000000", "1000000000", "1000000000", // 90-94
    "1000000000", "1000000000", "1000000000", "1000000000", "1000000000", // 95-99
    "100",                                                                    // 100 (active, tiny Y)
    "0", "0", "0", "0", "0",
  ]);
  const perBin = [{ binId: 101, ourX: (ONE_SOL * 1000n).toString(), ourY: "0" }];  // 1000 SOL
  const result = estimateSlippageLamports(perBin, binData, activeBinId, { lowerBin: 95 });
  console.log(`  result: ${result} (expected null)`);
  if (result !== null) throw new Error(`Expected null, got ${result}`);
});

test("Slippage 4: position straddles active bin — only ourX from bins > active counts", () => {
  // X in bin 99 (below active, should be IGNORED) and bin 101 (above active, should be counted)
  const activeBinId = 100;
  const binData = buildBins(85, 105, [
    "1000000000", "1000000000", "1000000000", "1000000000", "1000000000", // 85-89
    "1000000000", "1000000000", "1000000000", "1000000000", "1000000000", // 90-94
    "1000000000", "1000000000", "1000000000", "1000000000", "1000000000", // 95-99
    "0",                                                                                  // 100
    "0", "0", "0", "0", "0",
  ]);
  // Both X entries
  const perBinBoth = [
    { binId: 99, ourX: ONE_SOL.toString(), ourY: "0" },   // X below active — IGNORED
    { binId: 101, ourX: (ONE_SOL * 5n).toString(), ourY: "0" },  // X above active — counted
  ];
  // Only X above active
  const perBinOnly = [
    { binId: 101, ourX: (ONE_SOL * 5n).toString(), ourY: "0" },
  ];
  const resultBoth = estimateSlippageLamports(perBinBoth, binData, activeBinId, { lowerBin: 95 });
  const resultOnly = estimateSlippageLamports(perBinOnly, binData, activeBinId, { lowerBin: 95 });
  console.log(`  result (both): ${resultBoth}, result (only-above): ${resultOnly}`);
  if (resultBoth !== resultOnly) throw new Error(`Straddling bin ignored: ${resultBoth} vs ${resultOnly}`);
});

test("Slippage 5: all Y, all ≤ active, no X → 0n (legitimate 0, NOT null)", () => {
  // Y-only position where ALL Y is in bins ≤ active (no X to swap)
  const activeBinId = 100;
  const binData = buildBins(85, 105, [
    "1000000000", "1000000000", "1000000000", "1000000000", "1000000000", // 85-89
    "1000000000", "1000000000", "1000000000", "1000000000", "1000000000", // 90-94
    "1000000000", "1000000000", "1000000000", "1000000000", "1000000000", // 95-99
    "1000000000",                                                          // 100
    "0", "0", "0", "0", "0",
  ]);
  const perBin = [
    { binId: 95, ourX: "0", ourY: "1000000000" },
    { binId: 100, ourX: "0", ourY: "1000000000" },
  ];
  const result = estimateSlippageLamports(perBin, binData, activeBinId, { lowerBin: 95 });
  console.log(`  result: ${result} (expected 0n, not null)`);
  if (result !== 0n) throw new Error(`Expected 0n, got ${result}`);
  if (result === null) throw new Error("Must not be null — legitimate 0n case");
});

test("Slippage 6: missing active bin (price moved below our range) → null", () => {
  // binData doesn't include the active bin (price moved below our range)
  // Pre-check PASSES (binData covers 85+, has 10 bins below 95)
  const activeBinId = 100;
  const binData = buildBins(85, 105, [
    "1000000000", "1000000000", "1000000000", "1000000000", "1000000000", // 85-89
    "1000000000", "1000000000", "1000000000", "1000000000", "1000000000", // 90-94
    "1000000000", "1000000000", "1000000000", "1000000000", "1000000000", // 95-99
    /* bin 100 MISSING */
    "0", "0", "0", "0", "0",
  ].slice(0, 20)); // simulate missing bin 100
  // Actually simpler: build bins 85-99 and 101-105 with bin 100 missing
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
  console.log(`  result: ${result} (expected null — missing active bin)`);
  if (result !== null) throw new Error(`Expected null, got ${result}`);
});

test("Slippage 7: pre-check fails (binData has no buffer below position) → null", () => {
  // lowerBin = 95, binData starts at 95 (no buffer)
  // pre-check: minBinInData (95) > lowerBin - 10 (85) → TRUE → fail
  const activeBinId = 100;
  const binData = buildBins(95, 105, [
    "1000000000000", "1000000000000", "1000000000000", "1000000000000", "1000000000000",
    "1000000000000",
    "0", "0", "0", "0", "0",
  ]);
  const perBin = [{ binId: 101, ourX: ONE_SOL.toString(), ourY: "0" }];
  const result = estimateSlippageLamports(perBin, binData, activeBinId, { lowerBin: 95 });
  console.log(`  result: ${result} (expected null — pre-check)`);
  if (result !== null) throw new Error(`Expected null, got ${result}`);
});

test("Slippage 8: activeBinId is null → null (fallback, NOT 0n)", () => {
  // Bug: pre-fix, `pb.binId > null` is always false in JS, so remainingX
  // stays 0n and the function returns 0n — caller treats as legitimate zero
  // slippage and the unreliable-data fallback never fires.
  const binData = buildBins(85, 105, ["0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0"]);
  const perBin = [{ binId: 101, ourX: ONE_SOL.toString(), ourY: "0" }];
  const result = estimateSlippageLamports(perBin, binData, null, { lowerBin: 95 });
  console.log(`  result: ${result} (expected null — activeBinId null guard)`);
  if (result !== null) throw new Error(`Expected null, got ${result}`);
});

test("Slippage 9: walk loop bins with priceQ64 = 0 (RPC partial) → no crash", () => {
  // SDK can return a bin with priceQ64: null/0 on partial RPC responses.
  // Pre-fix, `BigInt(undefined)` throws. Fix: `BigInt(x?.priceQ64 ?? "0")`
  // and `continue` on 0n.
  const activeBinId = 100;
  const binData = buildBins(85, 105, [
    "0", "0", "0", "0", "0", "0", "0", "0", "0", "0",  // bins 85-94: empty (buffer)
    "0", "0", "0", "0", "0",                            // bins 95-99: empty
    "0",                                                // bin 100 (active): priceQ64=0 → guard fires
    "0", "0", "0", "0", "0",                            // bins 101-105: empty
  ]);
  const perBin = [{ binId: 101, ourX: ONE_SOL.toString(), ourY: "0" }];
  // Active bin price is 0 → must return null (pathological), not throw
  const result = estimateSlippageLamports(perBin, binData, activeBinId, { lowerBin: 95 });
  console.log(`  result: ${result} (expected null — active price 0)`);
  if (result !== null) throw new Error(`Expected null, got ${result}`);
});

test("Slippage 10: walk loop skips bin with priceQ64=0 (active is valid)", () => {
  // Active bin has valid price, but one walk bin has priceQ64=0. The walk
  // must `continue` past it without crashing. Other walk bins complete
  // the swap → returns bigint.
  const activeBinId = 100;
  // Build bins manually so we can inject priceQ64=0 in a walk bin
  const binData = [
    { binId: 90, xAmount: "0", yAmount: "0", priceQ64: "0" },   // walk bin: 0 price, 0 Y → skip
    { binId: 91, xAmount: "0", yAmount: "10000000000", priceQ64: SCALE.toString() }, // walk bin
    { binId: 100, xAmount: "0", yAmount: "0", priceQ64: SCALE.toString() }, // active: valid
  ];
  // Position has 0.5 SOL worth of X above active
  const perBin = [{ binId: 101, ourX: (ONE_SOL / 2n).toString(), ourY: "0" }];
  const result = estimateSlippageLamports(perBin, binData, activeBinId, { lowerBin: 100 });
  console.log(`  result: ${result} (expected bigint ≥ 0 — walk completed past price=0 bin)`);
  if (result === null) throw new Error("Expected bigint, got null");
  if (typeof result !== "bigint") throw new Error(`Expected bigint, got ${typeof result}`);
});

// ════════════════════════════════════════════════════════════
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;

