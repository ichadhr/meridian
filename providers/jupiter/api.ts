/**
 * Jupiter API — swap execution and SOL price fetching.
 */
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { log } from "../../utils/logger.js";
import { config } from "../../config/index.js";
import { getConnection, getWallet, normalizeMint } from "../solana/wallet.js";
import { getWalletBalances } from "../solana/balance.js";
import { JUPITER_PRICE, JUPITER_SWAP } from "../../config/urls.js";

const DEFAULT_JUPITER_API_KEY = "b15d42e9-e0e4-4f90-a424-ae41ceeaa382";

/** Valid SOL price range — outside this means garbage data */
const MIN_SOL_PRICE = 1;
const MAX_SOL_PRICE = 1000;

function getJupiterApiKey(): string {
  return config.jupiter.apiKey || process.env.JUPITER_API_KEY || DEFAULT_JUPITER_API_KEY;
}

function getJupiterReferralParams(): {
  referralAccount: string;
  referralFee: number;
} | null {
  const referralAccount = String(config.jupiter.referralAccount || "").trim();
  const referralFee = Number(config.jupiter.referralFeeBps || 0);
  if (!referralAccount || !Number.isFinite(referralFee) || referralFee <= 0) {
    return null;
  }
  if (referralFee < 50 || referralFee > 255) {
    log("swap_warn", `Ignoring Jupiter referral fee ${referralFee}; Ultra requires 50-255 bps`);
    return null;
  }
  try {
    new PublicKey(referralAccount);
  } catch {
    log("swap_warn", "Ignoring invalid Jupiter referral account");
    return null;
  }
  return { referralAccount, referralFee: Math.round(referralFee) };
}

/**
 * Swap tokens via Jupiter Swap API V2 (order → sign → execute).
 */
const SOL_MINT = "So11111111111111111111111111111111111111112";

export async function swapToken({
  input_mint,
  output_mint,
  amount,
}: {
  input_mint: string;
  output_mint: string;
  amount: number;
}): Promise<Record<string, unknown>> {
  input_mint = normalizeMint(input_mint);
  output_mint = normalizeMint(output_mint);

  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_swap: { input_mint, output_mint, amount },
      message: "DRY RUN — no transaction sent",
    };
  }

  try {
    log("swap", `${amount} of ${input_mint} → ${output_mint}`);
    const wallet = getWallet();
    const connection = getConnection();

    let decimals = 9; // SOL default
    if (input_mint !== config.tokens.SOL) {
      const mintInfo = await connection.getParsedAccountInfo(new PublicKey(input_mint));
      decimals =
        (mintInfo.value?.data as any)?.parsed?.info?.decimals ?? 9;
    }
    const amountStr = Math.floor(amount * 10 ** decimals).toString();

    const search = new URLSearchParams({
      inputMint: input_mint,
      outputMint: output_mint,
      amount: amountStr,
      taker: wallet.publicKey.toString(),
    });
    const referralParams = getJupiterReferralParams();
    if (referralParams) {
      search.set("referralAccount", referralParams.referralAccount);
      search.set("referralFee", String(referralParams.referralFee));
    }
    const orderUrl = `${JUPITER_SWAP}/order?${search.toString()}`;
    const jupiterApiKey = getJupiterApiKey();

    const orderRes = await fetch(orderUrl, {
      headers: jupiterApiKey ? { "x-api-key": jupiterApiKey } : {},
    });
    if (!orderRes.ok) {
      const body = await orderRes.text();
      throw new Error(`Swap V2 order failed: ${orderRes.status} ${body}`);
    }

    const order = await orderRes.json();
    if (order.errorCode || order.errorMessage) {
      throw new Error(
        `Swap V2 order error: ${order.errorMessage || order.errorCode}`,
      );
    }

    const { transaction: unsignedTx, requestId } = order;

    const tx = VersionedTransaction.deserialize(
      Buffer.from(unsignedTx, "base64"),
    );
    tx.sign([wallet]);
    const signedTx = Buffer.from(tx.serialize()).toString("base64");

    const execRes = await fetch(`${JUPITER_SWAP}/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(jupiterApiKey ? { "x-api-key": jupiterApiKey } : {}),
      },
      body: JSON.stringify({ signedTransaction: signedTx, requestId }),
    });
    if (!execRes.ok) {
      throw new Error(
        `Swap V2 execute failed: ${execRes.status} ${await execRes.text()}`,
      );
    }

    const result = await execRes.json();
    if (result.status === "Failed") {
      throw new Error(`Swap failed on-chain: code=${result.code}`);
    }

    log("swap", `SUCCESS tx: ${result.signature}`);
    if (referralParams && order.feeBps !== referralParams.referralFee) {
      log(
        "swap_warn",
        `Jupiter referral fee requested ${referralParams.referralFee} bps but order applied ${order.feeBps ?? "unknown"} bps`,
      );
    }

    return {
      success: true,
      tx: result.signature,
      input_mint,
      output_mint,
      amount_in: result.inputAmountResult,
      amount_out: result.outputAmountResult,
      referral_account: referralParams?.referralAccount || null,
      referral_fee_bps_requested: referralParams?.referralFee || 0,
      fee_bps_applied: order.feeBps ?? null,
      fee_mint: order.feeMint ?? null,
    };
  } catch (error: any) {
    log("swap_error", error.message);
    return { success: false, error: error.message };
  }
}

const SOL_PRICE_CACHE_TTL_MS = 30_000;
let _cachedSolPrice: number | null = null;
let _cachedSolPriceAt = 0;

export function _resetSolPriceCacheForTesting(): void {
  _cachedSolPrice = null;
  _cachedSolPriceAt = 0;
}

/**
 * Fetch validated SOL/USD price with Jupiter primary + fallback chain.
 * Returns a validated price in [MIN_SOL_PRICE, MAX_SOL_PRICE] or null if unavailable.
 */
export async function fetchSolPrice(): Promise<number | null> {
  if (
    _cachedSolPrice != null &&
    Date.now() - _cachedSolPriceAt < SOL_PRICE_CACHE_TTL_MS
  ) {
    return _cachedSolPrice;
  }

  try {
    const res = await fetch(`${JUPITER_PRICE}?ids=${config.tokens.SOL}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json();
      const price = data?.[config.tokens.SOL]?.usdPrice;
      if (
        typeof price === "number" &&
        Number.isFinite(price) &&
        price >= MIN_SOL_PRICE &&
        price <= MAX_SOL_PRICE
      ) {
        _cachedSolPrice = price;
        _cachedSolPriceAt = Date.now();
        return price;
      }
      log("wallet_error", `Jupiter returned invalid SOL price: ${price}`);
    } else {
      log("wallet_error", `Jupiter price API error: ${res.status}`);
    }
  } catch (err: any) {
    log("wallet_error", `Jupiter price fetch failed: ${err.message}`);
  }

  try {
    const balances = await getWalletBalances();
    if (
      typeof balances.sol_price === "number" &&
      Number.isFinite(balances.sol_price) &&
      balances.sol_price >= MIN_SOL_PRICE &&
      balances.sol_price <= MAX_SOL_PRICE
    ) {
      _cachedSolPrice = balances.sol_price;
      _cachedSolPriceAt = Date.now();
      return balances.sol_price;
    }
    log("wallet_error", `Helius returned invalid SOL price: ${balances.sol_price}`);
  } catch (err: any) {
    log("wallet_error", `Helius balance fetch failed: ${err.message}`);
  }

  return null;
}
