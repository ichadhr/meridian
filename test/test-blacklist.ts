/**
 * Test: Token Blacklist and Developer Blocklist (core/token-blacklist.ts)
 */

import fs from "fs";
import {
  isBlacklisted,
  addToBlacklist,
  removeFromBlacklist,
  listBlacklist,
  isDevBlocked,
  getBlockedDevs,
  blockDev,
  unblockDev,
  listBlockedDevs,
} from "../core/token-blacklist.js";

const BLACKLIST_FILE = "./token-blacklist.json";
const BLOCKLIST_FILE = "./dev-blocklist.json";

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
let originalBlacklistContent: string | null = null;
let originalBlocklistContent: string | null = null;

function backup(): void {
  if (fs.existsSync(BLACKLIST_FILE)) {
    originalBlacklistContent = fs.readFileSync(BLACKLIST_FILE, "utf8");
  }
  if (fs.existsSync(BLOCKLIST_FILE)) {
    originalBlocklistContent = fs.readFileSync(BLOCKLIST_FILE, "utf8");
  }
}

function restore(): void {
  if (originalBlacklistContent !== null) {
    fs.writeFileSync(BLACKLIST_FILE, originalBlacklistContent);
  } else if (fs.existsSync(BLACKLIST_FILE)) {
    fs.unlinkSync(BLACKLIST_FILE);
  }

  if (originalBlocklistContent !== null) {
    fs.writeFileSync(BLOCKLIST_FILE, originalBlocklistContent);
  } else if (fs.existsSync(BLOCKLIST_FILE)) {
    fs.unlinkSync(BLOCKLIST_FILE);
  }
}

async function suite(): Promise<void> {
  backup();

  try {
    // Start clean for tests
    if (fs.existsSync(BLACKLIST_FILE)) fs.unlinkSync(BLACKLIST_FILE);
    if (fs.existsSync(BLOCKLIST_FILE)) fs.unlinkSync(BLOCKLIST_FILE);

    // ── Test 1: Token Blacklist CRUD operations ─────────────────────
    await test("blacklist: token CRUD operations", () => {
      const mintA = "EP2m8gTL4rjV75gC3krUX8tKgkWCSHN87D6Jro511111";
      const mintB = "EP2m8gTL4rjV75gC3krUX8tKgkWCSHN87D6Jro522222";

      // 1. Initial check (empty)
      assertEq(isBlacklisted(mintA), false);

      // 2. Add to blacklist
      const addRes = addToBlacklist({ mint: mintA, symbol: "MINTA", reason: "Rug risk" });
      assertEq(addRes.blacklisted, true);
      assertEq(isBlacklisted(mintA), true);

      // 3. Duplicate rejection
      const dupRes = addToBlacklist({ mint: mintA, symbol: "MINTA" });
      assertEq(dupRes.already_blacklisted, true);

      // 4. Listing
      const listRes = listBlacklist();
      assertEq(listRes.count, 1);
      assertEq(listRes.blacklist[0].mint, mintA);
      assertEq(listRes.blacklist[0].symbol, "MINTA");

      // 5. Remove from blacklist
      const removeRes = removeFromBlacklist({ mint: mintA });
      assertEq(removeRes.removed, true);
      assertEq(isBlacklisted(mintA), false);

      // 6. Removing non-existent
      const removeRes2 = removeFromBlacklist({ mint: mintB });
      assertEq(removeRes2.error != null, true);
    });

    // ── Test 2: Developer Blocklist CRUD operations ─────────────────
    await test("blacklist: developer CRUD operations", () => {
      const devA = "DevWalletAddress11111111111111111111111111";
      const devB = "DevWalletAddress22222222222222222222222222";

      // 1. Initial check
      assertEq(isDevBlocked(devA), false);

      // 2. Block developer
      const blockRes = blockDev({ wallet: devA, label: "ScammerA", reason: "Dumped on launch" });
      assertEq(blockRes.blocked, true);
      assertEq(isDevBlocked(devA), true);

      // 3. Duplicate rejection
      const dupRes = blockDev({ wallet: devA });
      assertEq(dupRes.already_blocked, true);

      // 4. Listing
      const listRes = listBlockedDevs();
      assertEq(listRes.count, 1);
      assertEq(listRes.blocked_devs[0].wallet, devA);
      assertEq(listRes.blocked_devs[0].label, "ScammerA");

      // 5. Get blocked devs map
      const mapRes = getBlockedDevs();
      assertEq(mapRes[devA] != null, true);
      assertEq(mapRes[devA].label, "ScammerA");

      // 6. Unblock developer
      const unblockRes = unblockDev({ wallet: devA });
      assertEq(unblockRes.unblocked, true);
      assertEq(isDevBlocked(devA), false);

      // 7. Unblocking non-existent
      const unblockRes2 = unblockDev({ wallet: devB });
      assertEq(unblockRes2.error != null, true);
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
