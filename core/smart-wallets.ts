import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "../utils/logger.js";
import { loadJsonRecord, saveJsonRecord } from "../config/index.js";
import type { SmartWallet, SmartWalletsDB } from "../types/index.js";
import { SMART_WALLETS_FILE } from "../config/paths.js";


function loadWallets(): SmartWalletsDB {
  return loadJsonRecord<SmartWalletsDB>(SMART_WALLETS_FILE, { wallets: [] });
}

function saveWallets(data: SmartWalletsDB): void {
  saveJsonRecord(SMART_WALLETS_FILE, data);
}

const SOLANA_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function addSmartWallet({
  name,
  address,
  category = "alpha",
  type = "lp",
}: {
  name: string;
  address: string;
  category?: string;
  type?: string;
}): { success: boolean; error?: string; wallet?: SmartWallet } {
  if (!SOLANA_PUBKEY_RE.test(address)) {
    return { success: false, error: "Invalid Solana address format" };
  }
  const data = loadWallets();
  const existing = data.wallets.find((w) => w.address === address);
  if (existing) {
    return { success: false, error: `Already tracked as "${existing.name}"` };
  }
  data.wallets.push({ name, address, category, type, addedAt: new Date().toISOString() });
  saveWallets(data);
  log("smart_wallets", `Added wallet: ${name} (${category}, type=${type})`);
  return { success: true, wallet: { name, address, category, type } };
}

export function removeSmartWallet({ address }: { address: string }): { success: boolean; error?: string; removed?: string } {
  const data = loadWallets();
  const wallet = data.wallets.find((w) => w.address === address);
  if (!wallet) return { success: false, error: "Wallet not found" };
  data.wallets = data.wallets.filter((w) => w.address !== address);
  saveWallets(data);
  log("smart_wallets", `Removed wallet: ${wallet.name}`);
  return { success: true, removed: wallet.name };
}

export function listSmartWallets(): { total: number; wallets: SmartWallet[] } {
  const { wallets } = loadWallets();
  return { total: wallets.length, wallets };
}

// Cache wallet positions for 5 minutes to avoid hammering RPC
const _cache = new Map<string, { positions: Array<Record<string, unknown>>; fetchedAt: number }>();
const CACHE_TTL = 5 * 60 * 1000;

export async function checkSmartWalletsOnPool({
  pool_address,
}: {
  pool_address: string;
}): Promise<{
  pool: string;
  tracked_wallets: number;
  in_pool: Array<{ name: string; category: string; address: string }>;
  confidence_boost: boolean;
  signal: string;
}> {
  const { wallets: allWallets } = loadWallets();
  // Only check LP-type wallets — holder wallets don't have positions
  const wallets = allWallets.filter((w) => !w.type || w.type === "lp");
  if (wallets.length === 0) {
    return {
      pool: pool_address,
      tracked_wallets: 0,
      in_pool: [],
      confidence_boost: false,
      signal: "No smart wallets tracked yet — neutral signal",
    };
  }

  const { getWalletPositions } = await import("../providers/meteora/index.js");

  const results = await Promise.all(
    wallets.map(async (wallet) => {
      try {
        const cached = _cache.get(wallet.address);
        if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
          return { wallet, positions: cached.positions };
        }
        const { positions } = await getWalletPositions({ wallet_address: wallet.address });
        _cache.set(wallet.address, { positions: (positions || []) as Array<Record<string, unknown>>, fetchedAt: Date.now() });
        return { wallet, positions: (positions || []) as Array<Record<string, unknown>> };
      } catch {
        return { wallet, positions: [] as Array<Record<string, unknown>> };
      }
    })
  );

  const inPool = results
    .filter((r) => r.positions.some((p) => p.pool === pool_address))
    .map((r) => ({ name: r.wallet.name, category: r.wallet.category, address: r.wallet.address }));

  return {
    pool: pool_address,
    tracked_wallets: wallets.length,
    in_pool: inPool,
    confidence_boost: inPool.length > 0,
    signal: inPool.length > 0
      ? `${inPool.length}/${wallets.length} smart wallet(s) are in this pool: ${inPool.map((w) => w.name).join(", ")} — STRONG signal`
      : `0/${wallets.length} smart wallets in this pool — neutral, rely on fundamentals`,
  };
}
