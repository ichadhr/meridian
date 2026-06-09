/**
 * Helius wallet balance API — returns SOL, USDC, and SPL token balances with USD values.
 */
import { log } from "../../utils/logger.js";
import { config } from "../../config/index.js";
import { getWallet } from "./wallet.js";

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
    const url = `https://api.helius.xyz/v1/wallet/${walletAddress}/balances?api-key=${HELIUS_KEY}`;
    const res = await fetch(url);

    if (!res.ok) {
      throw new Error(`Helius API error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
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
