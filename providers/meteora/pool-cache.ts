// providers/meteora/pool-cache.ts
// In-memory cache for DLMM SDK pool objects and Meteora pool metadata.
// Separate from pool-discovery.ts (which finds/filters pools) and dlmm.ts
// (which uses pools for deploy/close/positions).

import { PublicKey } from "@solana/web3.js";
import { log } from "../../utils/logger.js";
import { getConnection } from "../solana/wallet.js";
import { getDLMM } from "./dlmm.js";

const poolCache = new Map<string, any>();
const poolMetadataCache = new Map<string, any>();

/**
 * Invalidate one or all cached pool SDK objects.
 * Called after deploy to force fresh fee/position data next time.
 */
export function invalidatePoolCache(address?: string): void {
  if (address) {
    poolCache.delete(address);
  } else {
    poolCache.clear();
  }
}

/**
 * Get a DLMM SDK pool object (cached, 5-min TTL).
 * Used by deploy, close, and bin-range lookups.
 */
export async function getPool(poolAddress: PublicKey | string): Promise<any> {
  const key = poolAddress.toString();
  if (!poolCache.has(key)) {
    const { DLMM } = await getDLMM();
    const pool = await DLMM.create(getConnection(), new PublicKey(poolAddress));
    poolCache.set(key, pool);
  }
  return poolCache.get(key);
}

setInterval(() => poolCache.clear(), 5 * 60 * 1000);

/**
 * Get pool metadata (name, token symbols) from the Meteora datapi, cached.
 * Returns a lightweight object; falls back gracefully on fetch errors.
 */
export async function getPoolMetadata(poolAddress: PublicKey | string): Promise<any> {
  const key = String(poolAddress);
  if (poolMetadataCache.has(key)) {
    return poolMetadataCache.get(key);
  }

  try {
    const res = await fetch(`https://dlmm.datapi.meteora.ag/pools/${key}`);
    if (!res.ok) {
      throw new Error(`Pool metadata API ${res.status}`);
    }

    const data = await res.json();
    const tokenX = data?.token_x?.symbol || null;
    const tokenY = data?.token_y?.symbol || null;
    const pair = data?.name || (tokenX && tokenY ? `${tokenX}-${tokenY}` : null);
    const meta = {
      address: data?.address || key,
      name: pair,
      token_x_symbol: tokenX,
      token_y_symbol: tokenY,
    };
    poolMetadataCache.set(key, meta);
    return meta;
  } catch (error: any) {
    log("pool_meta_warn", `Pool metadata lookup failed for ${key.slice(0, 8)}: ${error.message}`);
    const fallback = { address: key, name: null, token_x_symbol: null, token_y_symbol: null };
    poolMetadataCache.set(key, fallback);
    return fallback;
  }
}

setInterval(() => poolMetadataCache.clear(), 15 * 60 * 1000);
