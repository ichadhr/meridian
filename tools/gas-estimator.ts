/**
 * tools/gas-estimator.ts
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
 */

// SDK constants — dynamically loaded alongside other SDK imports
let _POSITION_FEE: number | null = null;
let _BIN_ARRAY_FEE: number | null = null;
let _TOKEN_ACCOUNT_FEE: number | null = null;
let _BIN_ARRAY_BITMAP_FEE: number | null = null;
let _sdkLoaded = false;

async function ensureSdkLoaded(): Promise<void> {
  if (_sdkLoaded) return;
  const mod = await import("@meteora-ag/dlmm");
  _POSITION_FEE = (mod as any).POSITION_FEE;
  _BIN_ARRAY_FEE = (mod as any).BIN_ARRAY_FEE;
  _TOKEN_ACCOUNT_FEE = (mod as any).TOKEN_ACCOUNT_FEE;
  _BIN_ARRAY_BITMAP_FEE = (mod as any).BIN_ARRAY_BITMAP_FEE;
  _sdkLoaded = true;
}

// CU budgets (internal to SDK — verified against source, see header comment)
const INIT_POSITION_CU = 30_000;
const INIT_BIN_ARRAY_CU = 350_000;
const ADD_LIQUIDITY_CU = 1_000_000;
const CLOSE_POSITION_CU = 300_000;

const BASE_FEE_LAMPORTS_PER_SIG = 5_000;
const MICRO_LAMPORTS_PER_LAMPORT = 1_000_000;
const LAMPORTS_PER_SOL = 1_000_000_000;

// Rent constants (SOL) — loaded from SDK at runtime via ensureSdkLoaded().
// Locked at deploy, fully refunded on close.
const RENT = Object.defineProperties(
  {},
  {
    position: {
      get() {
        return _POSITION_FEE;
      },
    },
    binArray: {
      get() {
        return _BIN_ARRAY_FEE;
      },
    },
    tokenAccount: {
      get() {
        return _TOKEN_ACCOUNT_FEE;
      },
    },
    bitmap: {
      get() {
        return _BIN_ARRAY_BITMAP_FEE;
      },
    },
    total: {
      get() {
        return (
          (_POSITION_FEE as number) +
          (_BIN_ARRAY_FEE as number) +
          2 * (_TOKEN_ACCOUNT_FEE as number) +
          (_BIN_ARRAY_BITMAP_FEE as number)
        );
      },
    },
  },
) as {
  position: number | null;
  binArray: number | null;
  tokenAccount: number | null;
  bitmap: number | null;
  total: number | null;
};

// Cached priority fee (µl/CU) with 60s TTL + in-flight promise dedup
let _pfCache: {
  value: number | null;
  at: number;
  inflight: Promise<number> | null;
} = { value: null, at: 0, inflight: null };
const PF_TTL_MS = 60_000;

interface Connection {
  getRecentPrioritizationFees(): Promise<Array<{ prioritizationFee: number }>>;
}

/**
 * Sample current median priority fee (µl/CU) from getRecentPrioritizationFees.
 * Returns 0 on failure (loudly logged).
 */
export async function samplePriorityFee(
  connection: Connection,
  opts: { fresh?: boolean } = {},
): Promise<number> {
  const { fresh = false } = opts;
  const now = Date.now();
  if (!fresh && _pfCache.inflight) return _pfCache.inflight;
  if (!fresh && _pfCache.value !== null && now - _pfCache.at < PF_TTL_MS) return _pfCache.value;
  _pfCache.inflight = (async () => {
    try {
      const fees = await connection.getRecentPrioritizationFees();
      if (!fees || fees.length === 0) {
        console.warn(
          "[gas-estimator] getRecentPrioritizationFees returned empty — using 0",
        );
        return 0;
      }
      fees.sort((a, b) => a.prioritizationFee - b.prioritizationFee);
      const median = fees[Math.floor(fees.length / 2)].prioritizationFee;
      _pfCache = { value: median, at: Date.now(), inflight: null };
      return median;
    } catch (e: any) {
      console.warn(
        `[gas-estimator] getRecentPrioritizationFees failed: ${e.message} — using 0 (cache not poisoned)`,
      );
      _pfCache.inflight = null;
      return 0;
    }
  })();
  return _pfCache.inflight;
}

/**
 * Convert CU + base fee + priority fee to SOL cost.
 */
export function cuToSolCost(cu: number, priorityFee: number, signatures = 1): number {
  const priorityLamports = (cu * priorityFee) / MICRO_LAMPORTS_PER_LAMPORT;
  const baseLamports = BASE_FEE_LAMPORTS_PER_SIG * signatures;
  return (priorityLamports + baseLamports) / LAMPORTS_PER_SOL;
}

/**
 * Estimate deploy-tx gas cost (SOL) — single side, standard range.
 */
export async function estimateDeployGasSol(
  connection: Connection,
  priorityFee?: number,
): Promise<number> {
  const pf = priorityFee ?? (await samplePriorityFee(connection));
  const deployCU = INIT_POSITION_CU + INIT_BIN_ARRAY_CU + ADD_LIQUIDITY_CU;
  return cuToSolCost(deployCU, pf);
}

/**
 * Estimate close-tx gas cost (SOL) — removeLiquidity + closePosition2.
 */
export async function estimateCloseGasSol(
  connection: Connection,
  priorityFee?: number,
): Promise<number> {
  const pf = priorityFee ?? (await samplePriorityFee(connection));
  return cuToSolCost(CLOSE_POSITION_CU, pf);
}

/**
 * Full-cycle gas (deploy + close) at current priority fee.
 * Returns a breakdown for transparency.
 */
export async function estimateFullCycleGasSol(connection: Connection): Promise<{
  gasSol: number;
  deploySol: number;
  closeSol: number;
  deployCU: number;
  closeCU: number;
  priorityFee: number;
}> {
  const priorityFee = await samplePriorityFee(connection);
  const deploySol = cuToSolCost(
    INIT_POSITION_CU + INIT_BIN_ARRAY_CU + ADD_LIQUIDITY_CU,
    priorityFee,
  );
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
 * NOTE: SDK constants are loaded lazily; call after ensureSdkLoaded() or accept nulls.
 */
export function getRentCostSol(): {
  position: number | null;
  binArray: number | null;
  tokenAccounts: number | null;
  bitmap: number | null;
  total: number | null;
  note: string;
} {
  return {
    position: RENT.position,
    binArray: RENT.binArray,
    tokenAccounts: 2 * (RENT.tokenAccount as number),
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
