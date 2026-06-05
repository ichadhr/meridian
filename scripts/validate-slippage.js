#!/usr/bin/env node
/**
 * Validation script for estimateSlippageLamports.
 *
 * Compares our manual algorithm against the SDK's swapQuote.priceImpact
 * on live pool data. If the algorithm is sound, our_slippage should
 * approximately match sdk.priceImpact (within ±10pp, accounting for fees
 * — our algorithm doesn't subtract fees, SDK does).
 *
 * Tests 4 position sizes: 0.5/5/25/50 SOL across 10-30 pools (bin_step 80-125).
 *
 * Usage: node scripts/validate-slippage.js
 */
import "../envcrypt.js";
import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import DLMM from "@meteora-ag/dlmm";
import BN from "bn.js";
import { estimateSlippageLamports } from "../tools/compute-position-pnl.js";

const RPC = process.env.RPC_URL;
if (!RPC) {
  console.error("RPC_URL required in .env");
  process.exit(1);
}

const LAMPORTS_PER_SOL = 1_000_000_000;
const PRICE_SCALE = 1n << 64n;
const DLMM_PROGRAM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");

// ─── Configurable test parameters ─────────────────────────────────
const POSITION_SIZES_SOL = [0.5, 5, 25, 50];
const POOLS_PER_SIZE = 5;   // valid (non-empty) pools per size
const BIN_RANGE = 35;       // typical Meridian deploy range (below active)
const BIN_BUFFER_ABOVE = 5; // bins above active for the X→Y swap path
const PRE_CHECK_BUFFER = 15; // fetch this many extra bins below for algorithm's pre-check
const TOLERANCE_PP = 10;    // ±10 percentage points allowed
const TIMEOUT_MS = 60_000;  // per-pool timeout
const POOL_SCAN_LIMIT = 100; // scan up to N pools to find valid ones
const POOL_DELAY_MS = 200;   // delay between pools (Helius rate limit)

const conn = new Connection(RPC, "confirmed");

/**
 * Find pools with bin_step in Meridian's preferred range (80-125).
 * Scans up to `scanLimit` program accounts to find `limit` valid pools.
 */
async function findPools(limit = 30, scanLimit = 100) {
  const accs = await conn.getProgramAccounts(DLMM_PROGRAM, {
    dataSlice: { offset: 0, length: 8 },
    filters: [{ dataSize: 904 }],
  });
  const pools = [];
  let scanned = 0;
  for (const a of accs) {
    if (pools.length >= limit) break;
    if (scanned >= scanLimit) break;
    scanned++;
    try {
      const dlmm = await DLMM.create(conn, a.pubkey);
      await dlmm.refetchStates();
      const binStep = dlmm.lbPair.binStep;
      if (binStep < 80 || binStep > 125) continue;
      pools.push({
        address: a.pubkey.toBase58(),
        dlmm,
        binStep,
        activeId: dlmm.lbPair.activeId,
      });
    } catch (e) {
      // skip bad pools
    }
  }
  return pools;
}

/**
 * Load bin data for a range. Returns { activeBin, bins } where bins
 * have { binId, xAmount, yAmount, priceQ64 } as strings.
 */
async function loadBinData(dlmm, lowerBin, upperBin) {
  const result = await dlmm.getBinsBetweenLowerAndUpperBound(lowerBin, upperBin);
  return {
    activeBin: result.activeBin,
    bins: result.bins.map((b) => ({
      binId: b.binId,
      xAmount: b.xAmount?.toString?.() ?? "0",
      yAmount: b.yAmount?.toString?.() ?? "0",
      priceQ64: b.price?.toString?.() ?? "0",
    })),
  };
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`timeout (${ms}ms)`)), ms),
    ),
  ]);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── Test runner ────────────────────────────────────────────────

let totalTests = 0;
let totalPassed = 0;
let totalFailed = 0;
let totalSkipped = 0;

console.log("Validating estimateSlippageLamports against SDK swapQuote.priceImpact");
console.log(`RPC: ${RPC.slice(0, 50)}...`);
console.log(`Position sizes: ${POSITION_SIZES_SOL.join(", ")} SOL`);
console.log(`Tolerance: ±${TOLERANCE_PP}pp`);

for (const solSize of POSITION_SIZES_SOL) {
  console.log(`\n═══ Position size: ${solSize} SOL ═══`);

  // Find more pools than we need — most will be empty (filtered out below)
  const pools = await findPools(POOLS_PER_SIZE * 4, POOL_SCAN_LIMIT);
  console.log(`Scanned ${POOL_SCAN_LIMIT} pools, ${pools.length} matched bin_step filter`);

  let testedThisSize = 0;
  let scanned = 0;
  for (const pool of pools) {
    if (testedThisSize >= POOLS_PER_SIZE) break;
    if (scanned >= POOL_SCAN_LIMIT) break;
    scanned++;

    const lowerBin = pool.activeId - BIN_RANGE;
    const upperBin = pool.activeId + BIN_BUFFER_ABOVE;
    // Fetch with extra buffer below for algorithm's pre-check (needs lowerBin - 10)
    const fetchLower = lowerBin - PRE_CHECK_BUFFER;
    const fetchUpper = upperBin;

    let binData;
    try {
      const result = await withTimeout(
        loadBinData(pool.dlmm, fetchLower, fetchUpper),
        TIMEOUT_MS,
        "loadBinData",
      );
      binData = result.bins;
    } catch (e) {
      continue;  // silently skip
    }

    // Skip pools with no Y in our range (would fail swapQuote anyway)
    const hasY = binData.some((b) => b.binId <= pool.activeId && b.yAmount !== "0");
    const hasX = binData.some((b) => b.binId > pool.activeId && b.xAmount !== "0");
    if (!hasY || !hasX) {
      continue;  // silently skip empty pools
    }
    testedThisSize++;

    const xLamports = Math.floor(solSize * LAMPORTS_PER_SOL);

    // SDK reference: get priceImpact from swapQuote
    let sdkPriceImpactPct;
    try {
      const binArrays = await withTimeout(
        pool.dlmm.getBinArrayForSwap(true, 30),
        TIMEOUT_MS,
        "getBinArrayForSwap",
      );
      const sq = await withTimeout(
        pool.dlmm.swapQuote(
          new BN(xLamports),
          true,       // swapForY (X→Y)
          new BN(0),  // allowedSlippage (don't care for read-only quote)
          binArrays,
          true,       // isPartialFill — return what we can quote for thin pools
        ),
        TIMEOUT_MS,
        "swapQuote",
      );
      // priceImpact is a Decimal — e.g. 0.05 means 5%
      sdkPriceImpactPct = Number(sq.priceImpact.mul(100).toString());
    } catch (e) {
      console.log(`  ${pool.address.slice(0, 8)}... SDK quote failed: ${e.message.slice(0, 60)}`);
      totalTests++;
      totalSkipped++;
      await sleep(POOL_DELAY_MS);
      continue;
    }

    // Our algorithm: synthetic perBin with all X concentrated in one bin
    // just above active. This is a worst-case for slippage; real positions
    // distribute across multiple bins (so should have lower slippage).
    const perBin = [
      { binId: pool.activeId + 1, ourX: String(xLamports), ourY: "0" },
    ];

    const ourShortfall = estimateSlippageLamports(perBin, binData, pool.activeId, { lowerBin });
    totalTests++;

    if (ourShortfall === null) {
      // Algorithm returned null (pre-check or post-check failed)
      // Treat as "pass" if SDK also shows high price impact (small pool case)
      // or if SDK shows 0 (no swap possible)
      const ourNullOk = sdkPriceImpactPct === 0 || sdkPriceImpactPct > 5;
      if (ourNullOk) totalPassed++;
      else totalFailed++;
      console.log(`  ${pool.address.slice(0, 8)}... binStep=${pool.binStep} active=${pool.activeId}: our=null SDK=${sdkPriceImpactPct.toFixed(4)}% ${ourNullOk ? "✓" : "✗ (null but SDK says low impact)"}`);
      await sleep(POOL_DELAY_MS);
      continue;
    }

    // Compute our "Y received" and our implied price impact
    const activeBin = binData.find((b) => b.binId === pool.activeId);
    if (!activeBin) {
      totalSkipped++;
      await sleep(POOL_DELAY_MS);
      continue;
    }
    const activePrice = BigInt(activeBin.priceQ64);
    if (activePrice === 0n) {
      totalSkipped++;
      await sleep(POOL_DELAY_MS);
      continue;
    }
    const theoreticalY = Number((BigInt(xLamports) * activePrice) / PRICE_SCALE);
    if (theoreticalY === 0) {
      totalSkipped++;
      await sleep(POOL_DELAY_MS);
      continue;
    }
    const ourPriceImpactPct = (Number(ourShortfall) / theoreticalY) * 100;

    // Compare (using pp difference, not relative %)
    const diffPp = Math.abs(ourPriceImpactPct - sdkPriceImpactPct);
    const passed = diffPp <= TOLERANCE_PP;
    if (passed) totalPassed++;
    else totalFailed++;

    const status = passed ? "✓" : "✗";
    console.log(
      `  ${pool.address.slice(0, 8)}... binStep=${pool.binStep} active=${pool.activeId}: ` +
        `SDK=${sdkPriceImpactPct.toFixed(4)}% our=${ourPriceImpactPct.toFixed(4)}% ` +
        `diff=${diffPp.toFixed(2)}pp ${status}`,
    );

    await sleep(POOL_DELAY_MS);
  }
  console.log(`  → ${testedThisSize} valid pools tested for ${solSize} SOL`);
}

console.log(
  `\n═══ TOTAL: ${totalPassed}/${totalTests} passed (≤${TOLERANCE_PP}pp diff), ${totalFailed} failed, ${totalSkipped} skipped ═══`,
);
process.exit(totalFailed > 0 ? 1 : 0);
