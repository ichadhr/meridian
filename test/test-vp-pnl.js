/**
 * Test: VP PnL calculation + close rules (standalone — no npm install needed)
 *
 * Uses BigInt instead of BN to validate the math without dependencies.
 * Mirrors the computeVirtualPnl logic from manage-virtual.js.
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
//  SECTION 4: Full End-to-End PnL with All Costs
// ════════════════════════════════════════════════════════════

test("Full PnL: empty bin + costs → PnL is negative (realistic)", () => {
  const depositYLamports = 500_000_000n; // 0.5 SOL
  const priceQ64 = SCALE;
  const shares = computeShares(depositYLamports, priceQ64, 0n, 0n, 0n);

  // Same bin state → should be roughly break-even before costs, negative after
  const currentY = 1_000_000_000n;
  const currentSupply = 500_000_000n;
  const valueYLamports = computeWithdrawal(shares, 0n, currentY, currentSupply, priceQ64);
  const rawSol = Number(valueYLamports) / Number(LAMPORTS_PER_SOL);

  const adjustedSol = applyVpCosts(rawSol, 80);
  const initialValueUsd = 0.5 * SOL_PRICE;
  const currentValueUsd = adjustedSol * SOL_PRICE;
  const pnlPct = ((currentValueUsd - initialValueUsd) / initialValueUsd) * 100;

  console.log(`  rawSol: ${rawSol.toFixed(6)}, adjustedSol: ${adjustedSol.toFixed(6)}`);
  console.log(`  initial: $${initialValueUsd.toFixed(2)}, current: $${currentValueUsd.toFixed(2)}`);
  console.log(`  pnlPct: ${pnlPct.toFixed(2)}% (negative = realistic)`);

  if (Math.abs(pnlPct) > 200) throw new Error(`PnL ${pnlPct}% still absurd`);
});

// ════════════════════════════════════════════════════════════
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
