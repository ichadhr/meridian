/**
 * Helius wallet balance API — returns SOL, USDC, and SPL token balances with USD values.
 */
import { log } from "../../utils/logger.js";
import { config } from "../../config/index.js";
import { getWallet } from "./wallet.js";

const MAX_ATTEMPTS = 4; // 1 initial + 3 retries
const RETRY_BACKOFF_MS = [200, 500, 1000]; // jittered, for retries 1..3

/**
 * Internal: fetch from Helius with retry on transient errors.
 * Throws on final failure.
 */
async function fetchBalancesFromHelius(walletAddress: string, heliusKey: string): Promise<any> {
  const url = `https://api.helius.xyz/v1/wallet/${walletAddress}/balances?api-key=${heliusKey}`;
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        const transient = res.status === 408 || res.status === 429 || res.status >= 500;
        if (!transient || attempt === MAX_ATTEMPTS - 1) {
          throw new Error(`Helius API error: ${res.status} ${res.statusText}`);
        }
        const delay = RETRY_BACKOFF_MS[attempt] + Math.random() * 100;
        log("wallet_warn", `Helius retry ${attempt + 1}/${MAX_ATTEMPTS - 1}: ${res.status} (waiting ${Math.round(delay)}ms)`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      return await res.json();
    } catch (err: any) {
      lastError = err;
      const msg = err?.message ?? String(err);
      const isTransient = /408|429|5\d{2}|timeout|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET|EAI_AGAIN/i.test(msg);
      if (!isTransient || attempt === MAX_ATTEMPTS - 1) throw err;
      const delay = RETRY_BACKOFF_MS[attempt] + Math.random() * 100;
      log("wallet_warn", `Helius retry ${attempt + 1}/${MAX_ATTEMPTS - 1}: ${msg} (waiting ${Math.round(delay)}ms)`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError ?? new Error("Helius fetch failed after retries");
}

export async function getWalletBalances(): Promise<{
  wallet: string | null;
  sol: number;
  sol_price: number;
  sol_usd: number;
  usdc: number;
  tokens: Array<{ mint: string; symbol: string; balance: number; usd: number | null }>;
  total_usd: number;
  error?: string;
}> {
  let walletAddress: string;
  try {
    walletAddress = getWallet().publicKey.toString();
  } catch {
    return {
      wallet: null,
      sol: 0,
      sol_price: 0,
      sol_usd: 0,
      usdc: 0,
      tokens: [],
      total_usd: 0,
      error: "Wallet not configured",
    };
  }

  const HELIUS_KEY = process.env.HELIUS_API_KEY;
  if (!HELIUS_KEY) {
    log("wallet_error", "HELIUS_API_KEY not set in .env");
    return {
      wallet: walletAddress,
      sol: 0,
      sol_price: 0,
      sol_usd: 0,
      usdc: 0,
      tokens: [],
      total_usd: 0,
      error: "Helius API key missing",
    };
  }

  try {
    const data = await fetchBalancesFromHelius(walletAddress, HELIUS_KEY);
    const balances = data.balances || [];

    const solEntry = balances.find(
      (b: any) => b.mint === config.tokens.SOL || b.symbol === "SOL",
    );
    const usdcEntry = balances.find(
      (b: any) => b.mint === config.tokens.USDC || b.symbol === "USDC",
    );

    const solBalance = solEntry?.balance || 0;
    const solPrice = solEntry?.pricePerToken || 0;
    const solUsd = solEntry?.usdValue || 0;
    const usdcBalance = usdcEntry?.balance || 0;

    const enrichedTokens = balances.map((b: any) => ({
      mint: b.mint,
      symbol: b.symbol || b.mint.slice(0, 8),
      balance: b.balance,
      usd: b.usdValue ? Math.round(b.usdValue * 100) / 100 : null,
    }));

    return {
      wallet: walletAddress,
      sol: Math.round(solBalance * 1e6) / 1e6,
      sol_price: Math.round(solPrice * 100) / 100,
      sol_usd: Math.round(solUsd * 100) / 100,
      usdc: Math.round(usdcBalance * 100) / 100,
      tokens: enrichedTokens,
      total_usd: Math.round((data.totalUsdValue || 0) * 100) / 100,
    };
  } catch (error: any) {
    log("wallet_error", error.message);
    return {
      wallet: walletAddress,
      sol: 0,
      sol_price: 0,
      sol_usd: 0,
      usdc: 0,
      tokens: [],
      total_usd: 0,
      error: error.message,
    };
  }
}
