/**
 * Test: Smart Wallet LP tracking and caching (smart-wallets.ts)
 */

import fs from "fs";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  addSmartWallet,
  removeSmartWallet,
  listSmartWallets,
  checkSmartWalletsOnPool,
} from "../../core/index.js";
import { SMART_WALLETS_FILE as WALLETS_PATH } from "../../config/paths.js";

// ── Backup & Restore ─────────────────────────────────────────────
let originalWalletsContent: string | null = null;

function backup(): void {
  if (fs.existsSync(WALLETS_PATH)) {
    originalWalletsContent = fs.readFileSync(WALLETS_PATH, "utf8");
  }
}

function restore(): void {
  if (originalWalletsContent !== null) {
    fs.writeFileSync(WALLETS_PATH, originalWalletsContent);
  } else if (fs.existsSync(WALLETS_PATH)) {
    fs.unlinkSync(WALLETS_PATH);
  }
}

describe("Smart Wallets", () => {
  beforeAll(() => {
    process.env.RPC_URL = "http://localhost";
    backup();
  });

  afterAll(() => {
    restore();
  });

  beforeEach(() => {
    if (fs.existsSync(WALLETS_PATH)) fs.unlinkSync(WALLETS_PATH);
  });

  it("address validation and duplicate check", () => {
    // 1. Invalid address format
    const resInvalid = addSmartWallet({ name: "BadWallet", address: "invalid-sol-address-xyz" });
    expect(resInvalid.success).toBe(false);
    expect(resInvalid.error).toBe("Invalid Solana address format");

    // 2. Valid address addition
    const validAddress = "BjwJRDaWhWWt8eq5Qh5UtsAVmcummRyLvV7vrQA89ppg";
    const resValid = addSmartWallet({ name: "AlphaLP1", address: validAddress });
    expect(resValid.success).toBe(true);
    expect(resValid.wallet?.name).toBe("AlphaLP1");

    // 3. Duplicate rejection
    const resDup = addSmartWallet({ name: "AlphaLP2", address: validAddress });
    expect(resDup.success).toBe(false);
    expect(resDup.error).toContain("Already tracked as");

    // 4. Listing
    const listed = listSmartWallets();
    expect(listed.total).toBe(1);
    expect(listed.wallets[0].name).toBe("AlphaLP1");

    // 5. Removal
    const resRemove = removeSmartWallet({ address: validAddress });
    expect(resRemove.success).toBe(true);
    expect(resRemove.removed).toBe("AlphaLP1");

    const listed2 = listSmartWallets();
    expect(listed2.total).toBe(0);
  });

  it("checkSmartWalletsOnPool: generates neutral vs strong signals", async () => {
    const poolAddr = "So11111111111111111111111111111111111111112";

    // 1. No smart wallets tracked -> neutral signal
    const resEmpty = await checkSmartWalletsOnPool({ pool_address: poolAddr });
    expect(resEmpty.tracked_wallets).toBe(0);
    expect(resEmpty.confidence_boost).toBe(false);
    expect(resEmpty.signal).toContain("No smart wallets tracked");

    // 2. Add LP wallet
    const lpWalletAddr = "6eR5rRdexbht8aiiQmYq7yKb7EhdD3af22B4mHDmCp8x";
    addSmartWallet({ name: "TopLPer", address: lpWalletAddr, category: "alpha", type: "lp" });

    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return {
        ok: true,
        json: async () => ({
          positions: [],
        }),
      };
    }) as any;

    const origGetProgramAccounts = Connection.prototype.getProgramAccounts;
    const poolPubKey = new PublicKey(poolAddr);
    const buf = Buffer.alloc(80);
    buf.set(poolPubKey.toBuffer(), 8);

    Connection.prototype.getProgramAccounts = (async (programId: any) => {
      return [
        {
          pubkey: new PublicKey("BjwJRDaWhWWt8eq5Qh5UtsAVmcummRyLvV7vrQA89ppg"),
          account: {
            data: buf,
            executable: false,
            lamports: 1000,
            owner: programId,
          },
        },
      ];
    }) as any;

    try {
      const resSignal = await checkSmartWalletsOnPool({ pool_address: poolAddr });
      expect(resSignal.tracked_wallets).toBe(1);
      expect(resSignal.confidence_boost).toBe(true);
      expect(resSignal.in_pool.length).toBe(1);
      expect(resSignal.in_pool[0].name).toBe("TopLPer");
      expect(resSignal.signal).toContain("STRONG signal");
    } finally {
      globalThis.fetch = origFetch;
      Connection.prototype.getProgramAccounts = origGetProgramAccounts;
    }
  });

  it("checkSmartWalletsOnPool: respects 5-min caching TTL", async () => {
    const poolAddr = "So11111111111111111111111111111111111111112";
    const lpWalletAddr = "BjwJRDaWhWWt8eq5Qh5UtsAVmcummRyLvV7vrQA89ppg";
    addSmartWallet({ name: "TopLPer", address: lpWalletAddr, category: "alpha", type: "lp" });

    let fetchCount = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return {
        ok: true,
        json: async () => ({
          positions: [],
        }),
      };
    }) as any;

    const origGetProgramAccounts = Connection.prototype.getProgramAccounts;
    const poolPubKey = new PublicKey(poolAddr);
    const buf = Buffer.alloc(80);
    buf.set(poolPubKey.toBuffer(), 8);

    Connection.prototype.getProgramAccounts = (async (programId: any) => {
      fetchCount++;
      return [
        {
          pubkey: new PublicKey("BjwJRDaWhWWt8eq5Qh5UtsAVmcummRyLvV7vrQA89ppg"),
          account: {
            data: buf,
            executable: false,
            lamports: 1000,
            owner: programId,
          },
        },
      ];
    }) as any;

    try {
      // First fetch -> hits network/RPC (fetchCount = 1)
      await checkSmartWalletsOnPool({ pool_address: poolAddr });
      expect(fetchCount).toBe(1);

      // Second fetch -> cache hit (fetchCount stays 1)
      await checkSmartWalletsOnPool({ pool_address: poolAddr });
      expect(fetchCount).toBe(1);

      // Force time advance by 6 minutes (TTL is 5 mins)
      const origNow = Date.now;
      const start = Date.now();
      Date.now = () => start + 6 * 60 * 1000;

      try {
        // Third fetch -> cache expired -> hits network/RPC (fetchCount = 2)
        await checkSmartWalletsOnPool({ pool_address: poolAddr });
        expect(fetchCount).toBe(2);
      } finally {
        Date.now = origNow;
      }
    } finally {
      globalThis.fetch = origFetch;
      Connection.prototype.getProgramAccounts = origGetProgramAccounts;
    }
  });
});
