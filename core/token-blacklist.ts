// core/token-blacklist.ts — Token blacklist + dev deployer blocklist
import fs from "fs";
import { log } from "../utils/logger.js";
import type { BlacklistEntry, BlocklistEntry } from "../types/index.js";

const BLACKLIST_FILE = "./token-blacklist.json";
const BLOCKLIST_FILE = "./dev-blocklist.json";

// ─── Shared Helpers ────────────────────────────────────────────

function loadJsonRecord<T>(file: string, label: string): Record<string, T> {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    log("error", `Invalid ${file}: ${(error as Error).message}`);
    throw new Error(`Safety ${label} is unreadable: ${file}`);
  }
}

function saveJsonRecord<T>(file: string, data: Record<string, T>): void {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ─── Token Blacklist ───────────────────────────────────────────

export function isBlacklisted(mint: string): boolean {
  if (!mint) return false;
  const db = loadJsonRecord<BlacklistEntry>(BLACKLIST_FILE, "blacklist");
  return !!db[mint];
}

export function addToBlacklist({ mint, symbol, reason }: { mint: string; symbol?: string; reason?: string }): Record<string, unknown> {
  if (!mint) return { error: "mint required" };

  const db = loadJsonRecord<BlacklistEntry>(BLACKLIST_FILE, "blacklist");

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

  saveJsonRecord(BLACKLIST_FILE, db);
  log("blacklist", `Blacklisted ${symbol || mint}: ${reason}`);
  return { blacklisted: true, mint, symbol, reason };
}

export function removeFromBlacklist({ mint }: { mint: string }): Record<string, unknown> {
  if (!mint) return { error: "mint required" };

  const db = loadJsonRecord<BlacklistEntry>(BLACKLIST_FILE, "blacklist");

  if (!db[mint]) {
    return { error: `Mint ${mint} not found on blacklist` };
  }

  const entry = db[mint];
  delete db[mint];
  saveJsonRecord(BLACKLIST_FILE, db);
  log("blacklist", `Removed ${entry.symbol || mint} from blacklist`);
  return { removed: true, mint, was: entry };
}

export function listBlacklist(): { count: number; blacklist: Array<{ mint: string } & BlacklistEntry> } {
  const db = loadJsonRecord<BlacklistEntry>(BLACKLIST_FILE, "blacklist");
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

export function isDevBlocked(devWallet: string): boolean {
  if (!devWallet) return false;
  return !!loadJsonRecord<BlocklistEntry>(BLOCKLIST_FILE, "blocklist")[devWallet];
}

export function getBlockedDevs(): Record<string, BlocklistEntry> {
  return loadJsonRecord<BlocklistEntry>(BLOCKLIST_FILE, "blocklist");
}

export function blockDev({ wallet, reason, label }: { wallet: string; reason?: string; label?: string }): Record<string, unknown> {
  if (!wallet) return { error: "wallet required" };
  const db = loadJsonRecord<BlocklistEntry>(BLOCKLIST_FILE, "blocklist");
  if (db[wallet]) return { already_blocked: true, wallet, label: db[wallet].label, reason: db[wallet].reason };
  db[wallet] = {
    label: label || "unknown",
    reason: reason || "no reason provided",
    added_at: new Date().toISOString(),
  };
  saveJsonRecord(BLOCKLIST_FILE, db);
  log("dev_blocklist", `Blocked deployer ${label || wallet}: ${reason}`);
  return { blocked: true, wallet, label, reason };
}

export function unblockDev({ wallet }: { wallet: string }): Record<string, unknown> {
  if (!wallet) return { error: "wallet required" };
  const db = loadJsonRecord<BlocklistEntry>(BLOCKLIST_FILE, "blocklist");
  if (!db[wallet]) return { error: `Wallet ${wallet} not on dev blocklist` };
  const entry = db[wallet];
  delete db[wallet];
  saveJsonRecord(BLOCKLIST_FILE, db);
  log("dev_blocklist", `Removed deployer ${entry.label || wallet} from blocklist`);
  return { unblocked: true, wallet, was: entry };
}

export function listBlockedDevs(): { count: number; blocked_devs: Array<{ wallet: string } & BlocklistEntry> } {
  const db = loadJsonRecord<BlocklistEntry>(BLOCKLIST_FILE, "blocklist");
  const entries = Object.entries(db).map(([wallet, info]) => ({ wallet, ...info }));
  return { count: entries.length, blocked_devs: entries };
}
