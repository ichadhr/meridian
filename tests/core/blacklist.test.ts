import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
} from "../../core/index.js";
import { TOKEN_BLACKLIST_FILE as BLACKLIST_FILE, DEV_BLOCKLIST_FILE as BLOCKLIST_FILE } from "../../config/paths.js";

let originalBlacklistContent: string | null = null;
let originalBlocklistContent: string | null = null;

beforeAll(() => {
  if (fs.existsSync(BLACKLIST_FILE)) {
    originalBlacklistContent = fs.readFileSync(BLACKLIST_FILE, "utf8");
  }
  if (fs.existsSync(BLOCKLIST_FILE)) {
    originalBlocklistContent = fs.readFileSync(BLOCKLIST_FILE, "utf8");
  }
  // Clean start
  if (fs.existsSync(BLACKLIST_FILE)) fs.unlinkSync(BLACKLIST_FILE);
  if (fs.existsSync(BLOCKLIST_FILE)) fs.unlinkSync(BLOCKLIST_FILE);
});

afterAll(() => {
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
});

describe("Token Blacklist", () => {
  it("CRUD operations", () => {
    const mintA = "EP2m8gTL4rjV75gC3krUX8tKgkWCSHN87D6Jro511111";
    const mintB = "EP2m8gTL4rjV75gC3krUX8tKgkWCSHN87D6Jro522222";

    expect(isBlacklisted(mintA)).toBe(false);

    const addRes = addToBlacklist({ mint: mintA, symbol: "MINTA", reason: "Rug risk" });
    expect(addRes.blacklisted).toBe(true);
    expect(isBlacklisted(mintA)).toBe(true);

    const dupRes = addToBlacklist({ mint: mintA, symbol: "MINTA" });
    expect(dupRes.already_blacklisted).toBe(true);

    const listRes = listBlacklist();
    expect(listRes.count).toBe(1);
    expect(listRes.blacklist[0].mint).toBe(mintA);
    expect(listRes.blacklist[0].symbol).toBe("MINTA");

    const removeRes = removeFromBlacklist({ mint: mintA });
    expect(removeRes.removed).toBe(true);
    expect(isBlacklisted(mintA)).toBe(false);

    const removeRes2 = removeFromBlacklist({ mint: mintB });
    expect(removeRes2.error).toBeDefined();
  });
});

describe("Developer Blocklist", () => {
  it("CRUD operations", () => {
    const devA = "DevWalletAddress11111111111111111111111111";
    const devB = "DevWalletAddress22222222222222222222222222";

    expect(isDevBlocked(devA)).toBe(false);

    const blockRes = blockDev({ wallet: devA, label: "ScammerA", reason: "Dumped on launch" });
    expect(blockRes.blocked).toBe(true);
    expect(isDevBlocked(devA)).toBe(true);

    const dupRes = blockDev({ wallet: devA });
    expect(dupRes.already_blocked).toBe(true);

    const listRes = listBlockedDevs();
    expect(listRes.count).toBe(1);
    expect(listRes.blocked_devs[0].wallet).toBe(devA);
    expect(listRes.blocked_devs[0].label).toBe("ScammerA");

    const mapRes = getBlockedDevs();
    expect(mapRes[devA]).toBeDefined();
    expect(mapRes[devA].label).toBe("ScammerA");

    const unblockRes = unblockDev({ wallet: devA });
    expect(unblockRes.unblocked).toBe(true);
    expect(isDevBlocked(devA)).toBe(false);

    const unblockRes2 = unblockDev({ wallet: devB });
    expect(unblockRes2.error).toBeDefined();
  });
});
