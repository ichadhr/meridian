// ─── Bin helpers extracted from dlmm.ts ────────────────────────
// Active-bin lookup, in-range bin fetching (with 30s cache), and the
// per-bin Y-side BPS distribution used by virtual-position deploys.
//
// This module imports `getPool` from `./pool-cache.js` while importing
// `getDLMM` and `decimalPriceToQ64` from `./dlmm.js`.
// That avoids the circular dependency between core.ts and bins.ts.
//
// The public surface is re-exported from `providers/meteora/index.ts`,
// so external consumers (`core/`, `cli/`, `llm/`, etc.) see no change.

import BN from "bn.js";
import { log } from "../../utils/logger.js";
import { normalizeMint } from "../solana/wallet.js";
import { getDLMM, decimalPriceToQ64 } from "./dlmm.js";
import { getPool } from "./pool-cache.js";

// ─── Bins-in-range cache (30s TTL) ──────────────────────────────
// Key = `${poolAddress}:${minBin}:${maxBin}`. Deploy path passes
// { skipCache: true } to read fresh bins at open.
const BINS_IN_RANGE_CACHE_TTL_MS = 30_000;
let _binsInRangeCache = new Map(); // key -> { data, expiresAt }

export function _resetBinsInRangeCacheForTesting() {
  _binsInRangeCache = new Map();
}

/** Test-only: pre-populate the cache to verify a subsequent call returns cached data. */
export function _setBinsInRangeCacheForTesting(key: string, data: any, ttlMs = BINS_IN_RANGE_CACHE_TTL_MS): void {
  _binsInRangeCache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

/** Test-only: inspect current cache state. */
export function _getBinsInRangeCacheSizeForTesting() {
  return _binsInRangeCache.size;
}

// ─── Get Active Bin ────────────────────────────────────────────
export async function getActiveBin({ pool_address }: { pool_address: string }): Promise<{ binId: number; price: number; pricePerLamport: string }> {
  pool_address = normalizeMint(pool_address);
  const pool = await getPool(pool_address);
  const activeBin = await pool.getActiveBin();

  return {
    binId: activeBin.binId,
    price: pool.fromPricePerLamport(Number(activeBin.price)),
    pricePerLamport: activeBin.price.toString(),
  };
}

// ─── Get Bins In Range ─────────────────────────────────────────
export async function getBinsInRange({ pool_address, lower_bin, upper_bin, skipCache = false }: { pool_address: string; lower_bin: number; upper_bin: number; skipCache?: boolean }): Promise<any> {
  pool_address = normalizeMint(pool_address);
  const pool = await getPool(pool_address);
  // Guard against swapped bounds (SDK may error or return empty if lower > upper)
  const minBin = Math.min(lower_bin, upper_bin);
  const maxBin = Math.max(lower_bin, upper_bin);
  const cacheKey = `${pool_address}:${minBin}:${maxBin}`;

  if (!skipCache) {
    const cached = _binsInRangeCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      log("bins_cache_hit", `key=${cacheKey}`);
      // structuredClone protects bins from caller mutation.
      // Pool parameters (sParameter/vParameter) contain SDK BN instances
      // that lose their prototype on structuredClone — fetch them fresh
      // from the pool object (already fetched above, no extra RPC).
      const clone = structuredClone(cached.data);
      clone.binStep = pool.lbPair.binStep;
      clone.sParameter = pool.lbPair.parameters ?? null;
      clone.vParameter = pool.lbPair.vParameters ?? null;
      return clone;
    }
  }

  const result = await pool.getBinsBetweenLowerAndUpperBound(minBin, maxBin);
  const data = {
    activeBin: result.activeBin,
    // Pool parameters for swap fee calculation (needed by estimateSlippageLamports
    // which uses SDK's swapExactInQuoteAtBin for exact parity with live close).
    binStep: pool.lbPair.binStep,
    sParameter: pool.lbPair.parameters ?? null,
    vParameter: pool.lbPair.vParameters ?? null,
    bins: result.bins.map((b: any) => {
      // SDK sometimes returns b.price as a BN object (Q64.64 integer) and
      // sometimes as a human-readable decimal string. Normalize to a consistent
      // priceQ64 field so callers never have to guess the format.
      let priceQ64 = null;
      const rawPrice = b.price?.toString?.() ?? null;
      // BN.isBN checks constructor.name === 'BN' which can fail across bn.js versions.
      // Fall back to checking BN's internal structure (words array) as a robust backup.
      if (BN.isBN(b.price) || (b.price && typeof b.price === 'object' && Array.isArray(b.price.words))) {
        priceQ64 = b.price.toString(10);
      } else if (rawPrice !== null) {
        priceQ64 = decimalPriceToQ64(rawPrice).toString(10);
      }
      return {
        binId: b.binId,
        xAmount: b.xAmount?.toString?.() ?? null,
        yAmount: b.yAmount?.toString?.() ?? null,
        supply: b.supply?.toString?.() ?? null,
        feeAmountXPerTokenStored: b.feeAmountXPerTokenStored?.toString?.() ?? null,
        feeAmountYPerTokenStored: b.feeAmountYPerTokenStored?.toString?.() ?? null,
        price: rawPrice,
        priceQ64,
        priceHuman: pool.fromPricePerLamport(Number(b.price)),
      };
    }),
  };

  // Store successful result in cache
  _binsInRangeCache.set(cacheKey, { data, expiresAt: Date.now() + BINS_IN_RANGE_CACHE_TTL_MS });
  return data;
}

// ─── VP Strategy Distribution ──────────────────────────────────
// Computes per-bin Y-side BPS (basis points out of 10000) allocation for
// virtual position deploys. Delegates to the Meteora SDK's distribution
// functions — the same logic addLiquidityByStrategy uses on-chain — so VP
// share allocations match what a live deploy would produce exactly.
//
// The SDK functions are loaded lazily on first call via getDLMM() (exported
// from dlmm.ts). deployPosition calls getDLMM() at the top of the function,
// so the SDK is hot by the time this is invoked.

/**
 * Compute per-bin Y-side BPS allocation for a VP deploy.
 *
 * Delegates to Meteora SDK's calculateSpotDistribution,
 * calculateBidAskDistribution, and calculateNormalDistribution.
 * These produce the exact same BPS weights that a real
 * addLiquidityByStrategy call would use on-chain.
 *
 * @param {string} strategy   "spot" | "bid_ask" | "curve"
 * @param {number} activeBinId  The pool's current active bin ID
 * @param {number[]} binIds  Sorted array of bin IDs in the position range
 * @returns {Promise<Map<number, number>>}  Map of binId → yBps (basis points, totaling ~10000)
 */
export async function computeVpYDistribution(strategy: string, activeBinId: number, binIds: number[]): Promise<Map<number, number>> {
  const result = new Map();
  if (binIds.length === 0) return result;

  // Y-side bins = bins ≤ active bin (single-side SOL goes to Y side only)
  const yBins = binIds.filter(id => id <= activeBinId);
  if (yBins.length === 0) {
    for (const id of binIds) result.set(id, 0);
    return result;
  }

  const { calculateSpotDistribution, calculateBidAskDistribution, calculateNormalDistribution } = await getDLMM();

  let distribution;
  if (strategy === "spot" || !strategy) {
    distribution = calculateSpotDistribution(activeBinId, binIds);
  } else if (strategy === "bid_ask") {
    distribution = calculateBidAskDistribution(activeBinId, binIds);
  } else if (strategy === "curve") {
    distribution = calculateNormalDistribution(activeBinId, binIds);
  } else {
    log("deploy", `VP: unknown strategy "${strategy}", falling back to spot`);
    distribution = calculateSpotDistribution(activeBinId, binIds);
  }

  for (const d of distribution) {
    result.set(d.binId, Number(d.yAmountBpsOfTotal.toString()));
  }

  // X-side bins (above active) get 0 — VP only deposits Y
  for (const id of binIds) {
    if (!result.has(id)) result.set(id, 0);
  }

  return result;
}
