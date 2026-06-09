/**
 * external/sdk.ts — Unified Provider Interface
 *
 * The ONLY file imported from outside providers/ for I/O operations.
 * Routes to providers, handles fallback, normalizes return shapes.
 *
 * During migration, provider imports will be wired incrementally as files move into external/.
 * Initially, this is a stub that will be populated when provider files are migrated.
 */

// --- Provider imports (wire as providers are migrated) ---
// import { getBalancesHelius } from "./helius/index.js";
// import { getBalancesOkx } from "./okx/index.js";
// import { getBalancesSolana } from "./solana/balance.js";
// import { getTokenPriceJupiter } from "./jupiter/index.js";
// import { getSwapQuoteJupiter, executeSwapJupiter } from "./jupiter/index.js";
// import { getPoolDetail, getTopCandidates } from "./meteora/pool-discovery.js";

// --- Normalized output types ---

export interface NormalizedBalance {
  sol: number;
  usdc: number;
  tokens: Array<{
    mint: string;
    symbol: string;
    amount: number;
    usdValue: number;
  }>;
}

export interface NormalizedPool {
  address: string;
  tokenX: string;
  tokenY: string;
  tvl: number;
  volume24h: number;
  feeRate: number;
  binStep: number;
}

// --- Unified functions (fallback chains populated when providers migrate) ---

/**
 * Get wallet balances across SOL, USDC, and tokens.
 * Fallback chain: Helius → OKX → Solana RPC
 */
export async function getWalletBalance(address: string): Promise<NormalizedBalance> {
  // TODO: wire fallback chain when providers migrate
  // try {
  //   return normalizeBalances(await getBalancesHelius(address));
  // } catch {
  //   try {
  //     return normalizeBalances(await getBalancesOkx(address));
  //   } catch {
  //     return normalizeBalances(await getBalancesSolana(address));
  //   }
  // }
  throw new Error("Not yet wired — awaiting provider migration");
}

/**
 * Get token price from Jupiter.
 * No fallback — Jupiter is the exclusive source.
 */
export async function getTokenPrice(mint: string): Promise<number> {
  // TODO: wire when jupiter provider migrates
  throw new Error("Not yet wired — awaiting provider migration");
}

/**
 * Execute a swap via Jupiter.
 * No fallback — Jupiter is the exclusive source.
 */
export async function executeSwap(
  inputMint: string,
  outputMint: string,
  amount: number,
  slippageBps: number,
): Promise<{ tx: string; amountOut: number }> {
  // TODO: wire when jupiter provider migrates
  throw new Error("Not yet wired — awaiting provider migration");
}
