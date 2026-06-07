// core/token-blacklist.ts — Token blacklist + dev deployer blocklist
import fs from "fs";
import { log } from "../utils/logger.js";
import type { BlacklistEntry, BlocklistEntry } from "../types/index.js";

const BLACKLIST_FILE = "./token-blacklist.json";
const BLOCKLIST_FILE = "./dev-blocklist.json";

// ─── Token Blacklist ───────────────────────────────────────────

function loadBlacklist(): Record<string, BlacklistEntry> {
  if (!fs.existsSync(BLACKLIST_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(BLACKLIST_FILE, "utf8"));
  } catch (error) {
    log("blacklist_error", `Invalid ${BLACKLIST_FILE}: ${(error as Error).message}`);
    throw new Error(`Safety blacklist is unreadable: ${BLACKLIST_FILE}`);
  }
}

function saveBlacklist(data: Record<string, BlacklistEntry>): void {
  fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(data, null, 2));
}

export function isBlacklisted(mint: string): boolean {
  if (!mint) return false;
  const db = loadBlacklist();
  return !!db[mint];
}

export function addToBlacklist({ mint, symbol, reason }: { mint: string; symbol?: string; reason?: string }): Record<string, unknown> {
  if (!mint) return { error: "mint required" };

  const db = loadBlacklist();

  if (db[mint]) {
    return {
      already_blacklisted: true,
      mint,
      symbol: db[mint].symbol,
      reason: db[mint].reason,
    };
  }

  db[mint] = {
    symbol: symbol || "UNKNOWN",
    reason: reason || "no reason provided",
    added_at: new Date().toISOString(),
    added_by: "agent",
  };

  saveBlacklist(db);
  log("blacklist", `Blacklisted ${symbol || mint}: ${reason}`);
  return { blacklisted: true, mint, symbol, reason };
}

export function removeFromBlacklist({ mint }: { mint: string }): Record<string, unknown> {
  if (!mint) return { error: "mint required" };

  const db = loadBlacklist();

  if (!db[mint]) {
    return { error: `Mint ${mint} not found on blacklist` };
  }

  const entry = db[mint];
  delete db[mint];
  saveBlacklist(db);
  log("blacklist", `Removed ${entry.symbol || mint} from blacklist`);
  return { removed: true, mint, was: entry };
}

export function listBlacklist(): { count: number; blacklist: Array<{ mint: string } & BlacklistEntry> } {
  const db = loadBlacklist();
  const entries = Object.entries(db).map(([mint, info]) => ({
    mint,
    ...info,
  }));

  return {
    count: entries.length,
    blacklist: entries,
  };
}

// ─── Dev Blocklist ─────────────────────────────────────────────

function loadBlocklist(): Record<string, BlocklistEntry> {
  if (!fs.existsSync(BLOCKLIST_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(BLOCKLIST_FILE, "utf8"));
  } catch (error) {
    log("dev_blocklist_error", `Invalid ${BLOCKLIST_FILE}: ${(error as Error).message}`);
    throw new Error(`Safety blocklist is unreadable: ${BLOCKLIST_FILE}`);
  }
}

function saveBlocklist(data: Record<string, BlocklistEntry>): void {
  fs.writeFileSync(BLOCKLIST_FILE, JSON.stringify(data, null, 2));
}

export function isDevBlocked(devWallet: string): boolean {
  if (!devWallet) return false;
  return !!loadBlocklist()[devWallet];
}

export function getBlockedDevs(): Record<string, BlocklistEntry> {
  return loadBlocklist();
}

export function blockDev({ wallet, reason, label }: { wallet: string; reason?: string; label?: string }): Record<string, unknown> {
  if (!wallet) return { error: "wallet required" };
  const db = loadBlocklist();
  if (db[wallet]) return { already_blocked: true, wallet, label: db[wallet].label, reason: db[wallet].reason };
  db[wallet] = {
    label: label || "unknown",
    reason: reason || "no reason provided",
    added_at: new Date().toISOString(),
  };
  saveBlocklist(db);
  log("dev_blocklist", `Blocked deployer ${label || wallet}: ${reason}`);
  return { blocked: true, wallet, label, reason };
}

export function unblockDev({ wallet }: { wallet: string }): Record<string, unknown> {
  if (!wallet) return { error: "wallet required" };
  const db = loadBlocklist();
  if (!db[wallet]) return { error: `Wallet ${wallet} not on dev blocklist` };
  const entry = db[wallet];
  delete db[wallet];
  saveBlocklist(db);
  log("dev_blocklist", `Removed deployer ${entry.label || wallet} from blocklist`);
  return { unblocked: true, wallet, was: entry };
}

export function listBlockedDevs(): { count: number; blocked_devs: Array<{ wallet: string } & BlocklistEntry> } {
  const db = loadBlocklist();
  const entries = Object.entries(db).map(([wallet, info]) => ({ wallet, ...info }));
  return { count: entries.length, blocked_devs: entries };
}
