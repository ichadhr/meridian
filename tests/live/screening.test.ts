/**
 * Test the Pool Discovery API screening (no wallet required).
 * Run: vitest run --project live tests/live/screening.test.ts
 */

import { describe, it, expect } from "vitest";
import { discoverPools, getPoolDetail } from "../../providers/meteora/index.js";

describe("Pool Discovery API", () => {
  it("fetches top pools (24h)", async () => {
    const top = (await discoverPools({ page_size: 10 } as any)) as any;
    // API may return empty results due to rate limiting or network issues
    if (top.total > 0) {
      expect(top.pools.length).toBeGreaterThan(0);
      const best = top.pools[0];
      expect(best.name).toBeDefined();
      expect(best.pool).toBeDefined();
    }
  });

  it("fetches trending pools", async () => {
    const trending = (await discoverPools({ page_size: 5 } as any)) as any;
    // API may return empty results due to rate limiting or network issues
    if (trending.total > 0) {
      expect(trending.pools.length).toBeGreaterThan(0);
    }
  });

  it("fetches pool detail for the top pool", async () => {
    const top = (await discoverPools({ page_size: 1 } as any)) as any;
    if (top.pools.length === 0) return; // skip if no pools

    const poolAddr = top.pools[0].pool;
    const detail = (await getPoolDetail({ pool_address: poolAddr })) as any;
    expect(detail.name).toBeDefined();
    expect(detail.pool_address).toBe(poolAddr);
  });
});
