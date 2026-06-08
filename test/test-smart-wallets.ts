/**
 * Test: Smart Wallet LP tracking and caching (smart-wallets.ts)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  addSmartWallet,
  removeSmartWallet,
  listSmartWallets,
  checkSmartWalletsOnPool,
} from "../smart-wallets.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WALLETS_PATH = path.join(__dirname, "..", "smart-wallets.json");

let pass = 0;
let fail = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`✅ ${name}`);
    pass++;
  } catch (e: any) {
    console.log(`❌ ${name}: ${e.message}`);
    fail++;
  }
}

function assertEq<T>(actual: T, expected: T, msg = ""): void {
  if (actual !== expected) {
    throw new Error(`${msg} expected=${expected} actual=${actual}`);
  }
}

function assert(cond: boolean, msg = "assertion failed"): void {
  if (!cond) throw new Error(msg);
}

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

async function suite(): Promise<void> {
  process.env.RPC_URL = "http://localhost";
  backup();

  try {
    // Clean start
    if (fs.existsSync(WALLETS_PATH)) fs.unlinkSync(WALLETS_PATH);

    // ── Test 1: Sol address format checks & duplicate rejection ────
    await test("smart wallets CRUD: address validation and duplicate check", () => {
      // 1. Invalid address format
      const resInvalid = addSmartWallet({ name: "BadWallet", address: "invalid-sol-address-xyz" });
      assertEq(resInvalid.success, false);
      assertEq(resInvalid.error, "Invalid Solana address format");

      // 2. Valid address addition
      const validAddress = "BjwJRDaWhWWt8eq5Qh5UtsAVmcummRyLvV7vrQA89ppg";
      const resValid = addSmartWallet({ name: "AlphaLP1", address: validAddress });
      assertEq(resValid.success, true);
      assertEq(resValid.wallet?.name, "AlphaLP1");

      // 3. Duplicate rejection
      const resDup = addSmartWallet({ name: "AlphaLP2", address: validAddress });
      assertEq(resDup.success, false);
      assert(resDup.error!.includes("Already tracked as"));

      // 4. Listing
      const listed = listSmartWallets();
      assertEq(listed.total, 1);
      assertEq(listed.wallets[0].name, "AlphaLP1");

      // 5. Removal
      const resRemove = removeSmartWallet({ address: validAddress });
      assertEq(resRemove.success, true);
      assertEq(resRemove.removed, "AlphaLP1");

      const listed2 = listSmartWallets();
      assertEq(listed2.total, 0);
    });

    // ── Test 2: checkSmartWalletsOnPool signal calculations ───────
    await test("checkSmartWalletsOnPool: generates neutral vs strong signals", async () => {
      if (fs.existsSync(WALLETS_PATH)) fs.unlinkSync(WALLETS_PATH);

      const poolAddr = "So11111111111111111111111111111111111111112";

      // 1. No smart wallets tracked -> neutral signal
      const resEmpty = await checkSmartWalletsOnPool({ pool_address: poolAddr });
      assertEq(resEmpty.tracked_wallets, 0);
      assertEq(resEmpty.confidence_boost, false);
      assertEq(resEmpty.signal.includes("No smart wallets tracked"), true);

      // 2. Add LP wallet
      const lpWalletAddr = "6eR5rRdexbht8aiiQmYq7yKb7EhdD3af22B4mHDmCp8x";
      addSmartWallet({ name: "TopLPer", address: lpWalletAddr, category: "alpha", type: "lp" });

      const origFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        return {
          ok: true,
          json: async () => ({
            positions: []
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
        assertEq(resSignal.tracked_wallets, 1, "should track 1 lp wallet");
        assertEq(resSignal.confidence_boost, true, "should trigger confidence boost");
        assertEq(resSignal.in_pool.length, 1);
        assertEq(resSignal.in_pool[0].name, "TopLPer");
        assert(resSignal.signal.includes("STRONG signal"), "should report strong signal");
      } finally {
        globalThis.fetch = origFetch;
        Connection.prototype.getProgramAccounts = origGetProgramAccounts;
      }
    });

    // ── Test 3: cache TTL checks ─────────────────────────────────
    await test("checkSmartWalletsOnPool: respects 5-min caching TTL", async () => {
      if (fs.existsSync(WALLETS_PATH)) fs.unlinkSync(WALLETS_PATH);

      const poolAddr = "So11111111111111111111111111111111111111112";
      const lpWalletAddr = "BjwJRDaWhWWt8eq5Qh5UtsAVmcummRyLvV7vrQA89ppg";
      addSmartWallet({ name: "TopLPer", address: lpWalletAddr, category: "alpha", type: "lp" });

      let fetchCount = 0;
      const origFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        return {
          ok: true,
          json: async () => ({
            positions: []
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
        assertEq(fetchCount, 1);

        // Second fetch -> cache hit (fetchCount stays 1)
        await checkSmartWalletsOnPool({ pool_address: poolAddr });
        assertEq(fetchCount, 1, "should hit cache, not make new fetch");

        // Force time advance by 6 minutes (TTL is 5 mins)
        const origNow = Date.now;
        const start = Date.now();
        Date.now = () => start + 6 * 60 * 1000;

        try {
          // Third fetch -> cache expired -> hits network/RPC (fetchCount = 2)
          await checkSmartWalletsOnPool({ pool_address: poolAddr });
          assertEq(fetchCount, 2, "should re-fetch after 5-min cache TTL expires");
        } finally {
          Date.now = origNow;
        }

      } finally {
        globalThis.fetch = origFetch;
        Connection.prototype.getProgramAccounts = origGetProgramAccounts;
      }
    });

  } finally {
    restore();
  }

  console.log(`\n${pass + fail} tests: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

suite().catch((err) => {
  console.error(err);
  process.exit(1);
});
