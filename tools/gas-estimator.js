/**
 * tools/gas-estimator.js
 *
 * Dynamic gas cost estimation for DLMM deploy + close operations.
 * Used by VP (dry-run) PnL to apply realistic tx costs per position.
 *
 * Methodology:
 *   - CU budget: sum of SDK's documented default constants (no simulation —
 *     a fake position key would cause AccountNotFound, and a real one is not
 *     available before deploy).
 *   - Priority fee: sampled live from getRecentPrioritizationFees (cached 60s).
 *   - Base fee: 5,000 lamports per signature (Solana fixed).
 *   - Rent: tracked separately, fully recovered on close (net cost = 0).
 *
 * Reference SDK constants (from @meteora-ag/dlmm/dist/index.js):
 *   DEFAULT_INIT_POSITION_CU  = 30_000
 *   DEFAULT_INIT_BIN_ARRAY_CU = 350_000
 *   DEFAULT_ADD_LIQUIDITY_CU  = 1_000_000
 *
 * Reference rent constants (from @meteora-ag/dlmm/dist/index.js, line ~11184):
 *   POSITION_FEE            = 0.05740608 SOL
 *   BIN_ARRAY_FEE           = 0.07143744 SOL
 *   TOKEN_ACCOUNT_FEE       = 0.00203928 SOL
 *   BIN_ARRAY_BITMAP_FEE    = 0.01180416 SOL
 *   (Total deploy rent = 0.14472624 SOL, refunded on close)
 *
 * If you bump the @meteora-ag/dlmm version, re-verify these constants by
 * running scripts/measure-gas.js.
 */

// SDK constant CU budgets (sum: deploy tx, close tx)
const INIT_POSITION_CU    = 30_000;    // DEFAULT_INIT_POSITION_CU
const INIT_BIN_ARRAY_CU   = 350_000;   // DEFAULT_INIT_BIN_ARRAY_CU
const ADD_LIQUIDITY_CU    = 1_000_000; // DEFAULT_ADD_LIQUIDITY_CU
const CLOSE_POSITION_CU   = 300_000;   // closePosition2 + removeLiquidity2 typical

const BASE_FEE_LAMPORTS_PER_SIG = 5_000;
const MICRO_LAMPORTS_PER_LAMPORT = 1_000_000;
const LAMPORTS_PER_SOL = 1_000_000_000;

// Rent constants (SOL) — locked at deploy, fully refunded on close
const RENT = Object.freeze({
  position:      0.05740608,
  binArray:      0.07143744,
  tokenAccount:  0.00203928,  // × 2 (token X + token Y ATAs)
  bitmap:        0.01180416,
  get total() {
    return this.position + this.binArray + 2 * this.tokenAccount + this.bitmap;
  },
});

// Cached priority fee (µl/CU) with 60s TTL + in-flight promise dedup
let _pfCache = { value: null, at: 0, inflight: null };
const PF_TTL_MS = 60_000;

/**
 * Sample current median priority fee (µl/CU) from getRecentPrioritizationFees.
 * Returns 0 on failure (loudly logged).
 *
 * @param {Connection} connection
 * @param {object} [opts]
 * @param {boolean} [opts.fresh=false] - bypass cache, force a new RPC call.
 *   Use at close time to get the current network fee, not a 60s-stale one.
 */
export async function samplePriorityFee(connection, opts = {}) {
  const { fresh = false } = opts;
  const now = Date.now();
  if (!fresh && _pfCache.inflight) return _pfCache.inflight;
  if (!fresh && _pfCache.value !== null && now - _pfCache.at < PF_TTL_MS) return _pfCache.value;
  _pfCache.inflight = (async () => {
    try {
      const fees = await connection.getRecentPrioritizationFees();
      if (!fees || fees.length === 0) {
        console.warn("[gas-estimator] getRecentPrioritizationFees returned empty — using 0");
        // Don't poison cache with 0 — let next call retry
        return 0;
      }
      fees.sort((a, b) => a.prioritizationFee - b.prioritizationFee);
      const median = fees[Math.floor(fees.length / 2)].prioritizationFee;
      // Only update cache on successful read
      _pfCache = { value: median, at: Date.now(), inflight: null };
      return median;
    } catch (e) {
      console.warn(`[gas-estimator] getRecentPrioritizationFees failed: ${e.message} — using 0 (cache not poisoned)`);
      // Don't update cache on error — next call will retry
      _pfCache.inflight = null;
      return 0;
    }
  })();
  return _pfCache.inflight;
}

/**
 * Convert CU + base fee + priority fee to SOL cost.
 * @param {number} cu          compute units
 * @param {number} priorityFee microLamports per CU
 * @param {number} signatures  tx signatures (default 1)
 */
export function cuToSolCost(cu, priorityFee, signatures = 1) {
  const priorityLamports = (cu * priorityFee) / MICRO_LAMPORTS_PER_LAMPORT;
  const baseLamports = BASE_FEE_LAMPORTS_PER_SIG * signatures;
  return (priorityLamports + baseLamports) / LAMPORTS_PER_SOL;
}

/**
 * Estimate deploy-tx gas cost (SOL) — single side, standard range.
 */
export async function estimateDeployGasSol(connection, priorityFee) {
  const pf = priorityFee ?? await samplePriorityFee(connection);
  const deployCU = INIT_POSITION_CU + INIT_BIN_ARRAY_CU + ADD_LIQUIDITY_CU;
  return cuToSolCost(deployCU, pf);
}

/**
 * Estimate close-tx gas cost (SOL) — removeLiquidity + closePosition2.
 */
export async function estimateCloseGasSol(connection, priorityFee) {
  const pf = priorityFee ?? await samplePriorityFee(connection);
  return cuToSolCost(CLOSE_POSITION_CU, pf);
}

/**
 * Full-cycle gas (deploy + close) at current priority fee.
 * Returns a breakdown for transparency.
 *
 * @param {Connection} connection
 * @returns {Promise<{ gasSol: number, deploySol: number, closeSol: number, deployCU: number, closeCU: number, priorityFee: number }>}
 */
export async function estimateFullCycleGasSol(connection) {
  const priorityFee = await samplePriorityFee(connection);
  const deploySol = cuToSolCost(INIT_POSITION_CU + INIT_BIN_ARRAY_CU + ADD_LIQUIDITY_CU, priorityFee);
  const closeSol = cuToSolCost(CLOSE_POSITION_CU, priorityFee);
  return {
    gasSol: deploySol + closeSol,
    deploySol,
    closeSol,
    deployCU: INIT_POSITION_CU + INIT_BIN_ARRAY_CU + ADD_LIQUIDITY_CU,
    closeCU: CLOSE_POSITION_CU,
    priorityFee,
  };
}

/**
 * Rent cost breakdown (SOL) — recoverable on close.
 */
export function getRentCostSol() {
  return {
    position: RENT.position,
    binArray: RENT.binArray,
    tokenAccounts: 2 * RENT.tokenAccount,
    bitmap: RENT.bitmap,
    total: RENT.total,
    note: "Fully refunded on position close. Net rent cost = 0 for a complete cycle.",
  };
}

// For tests
export const _internal = {
  INIT_POSITION_CU,
  INIT_BIN_ARRAY_CU,
  ADD_LIQUIDITY_CU,
  CLOSE_POSITION_CU,
  BASE_FEE_LAMPORTS_PER_SIG,
  RENT,
};
