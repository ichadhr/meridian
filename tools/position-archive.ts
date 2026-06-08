/**
 * Position Archive — JSONL-based append-only archive for closed positions.
 *
 * Provides unified read/write for both paper (simulated) and live position
 * closes. Used internally by getPerformanceHistory, virtual-digest, and
 * dry-run-report — NOT exposed as a direct LLM tool.
 *
 * Format: archives/{source}-archive-YYYY-MM.jsonl
 *   source = "vp" (paper) | "live"
 *   One JSON object per line, append-only, O(1) write.
 */

import fs from "fs";
import path from "path";
import { log } from "../utils/logger.js";

// ── Paths ────────────────────────────────────────────────────────────────
export const ARCHIVE_DIR = "./archives";

function ensureDir(): void {
  if (!fs.existsSync(ARCHIVE_DIR)) {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  }
}

function archivePath(source: string, month: string): string {
  const prefix = source === "paper" ? "vp" : "live";
  return `${ARCHIVE_DIR}/${prefix}-archive-${month}.jsonl`;
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function monthFromRecord(record: Record<string, unknown>): string {
  if (record && typeof record.closed_at === "string") {
    const m = record.closed_at.match(/^(\d{4}-\d{2})/);
    if (m) return m[1];
  }
  return currentMonth();
}

// ── Cache ────────────────────────────────────────────────────────────────
let _cache: { records: ArchiveRecord[]; loadedAt: number; hours: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

function cacheIsValid(hours: number): boolean {
  return _cache != null && _cache.hours === hours && (Date.now() - _cache.loadedAt < CACHE_TTL_MS);
}

function invalidateCache(): void {
  _cache = null;
}

// ── Field normalization ─────────────────────────────────────────────────
const KNOWN_FIELDS = [
  "source", "id", "pool", "pool_name", "pair", "base_mint",
  "strategy", "lower_bin", "upper_bin", "active_bin_at_deploy",
  "bin_step", "amount_sol", "initial_value_usd", "sol_price_at_deploy",
  "deployed_at", "closed_at", "minutes_held", "minutes_in_range",
  "range_efficiency", "close_reason", "close_pnl_pct", "close_pnl_usd",
  "close_pnl_sol_pct", "close_pnl_sol", "close_il_sol", "close_fees_sol",
  "close_cost_sol", "close_il_usd", "close_fees_usd", "close_cost_usd",
  "total_fees_earned_usd", "volatility", "fee_tvl_ratio", "organic_score",
  "signal_snapshot", "bin_shares", "tx_hashes", "relay",
] as const;

export interface ArchiveRecord {
  source?: string;
  id?: string | number;
  pool?: string;
  pool_name?: string;
  pair?: string;
  base_mint?: string;
  strategy?: string;
  lower_bin?: number;
  upper_bin?: number;
  active_bin_at_deploy?: number;
  bin_step?: number;
  amount_sol?: number;
  initial_value_usd?: number;
  sol_price_at_deploy?: number;
  deployed_at?: string;
  closed_at?: string;
  minutes_held?: number;
  minutes_in_range?: number;
  range_efficiency?: number;
  close_reason?: string;
  close_pnl_pct?: number;
  close_pnl_usd?: number;
  close_pnl_sol_pct?: number;
  close_pnl_sol?: number;
  close_il_sol?: number;
  close_fees_sol?: number;
  close_cost_sol?: number;
  close_il_usd?: number;
  close_fees_usd?: number;
  close_cost_usd?: number;
  total_fees_earned_usd?: number;
  volatility?: number;
  fee_tvl_ratio?: number;
  organic_score?: number;
  signal_snapshot?: unknown;
  bin_shares?: unknown;
  tx_hashes?: unknown;
  relay?: unknown;
  [key: string]: unknown;
}

export function cleanRecord(raw: Record<string, unknown>): ArchiveRecord {
  const r: Record<string, unknown> = {};
  for (const k of KNOWN_FIELDS) {
    r[k] = raw[k] !== undefined ? raw[k] : null;
  }
  if (r.minutes_held == null && r.deployed_at && r.closed_at) {
    r.minutes_held = Math.max(0, Math.round(
      (new Date(r.closed_at as string).getTime() - new Date(r.deployed_at as string).getTime()) / 60000,
    ));
  }
  return r as ArchiveRecord;
}

// ── Write ────────────────────────────────────────────────────────────────

export function appendArchiveRecord(source: string, rawRecord: Record<string, unknown>, month?: string): boolean {
  ensureDir();
  const file = archivePath(source, month || monthFromRecord(rawRecord));
  const record = cleanRecord({ ...rawRecord, source });
  try {
    fs.appendFileSync(file, JSON.stringify(record) + "\n");
    invalidateCache();
    return true;
  } catch (e: any) {
    log("position_archive", `Failed to append ${source} record: ${e.message}`);
    return false;
  }
}

export function appendArchiveRecordIfNew(
  source: string,
  rawRecord: Record<string, unknown>,
  month?: string,
): boolean | null {
  if (!rawRecord || rawRecord.id == null) return null;
  ensureDir();
  const targetMonth = month || monthFromRecord(rawRecord);
  const file = archivePath(source, targetMonth);
  const targetId = String(rawRecord.id);
  try {
    if (fs.existsSync(file)) {
      const content = fs.readFileSync(file, "utf8");
      for (const line of content.split("\n")) {
        if (!line) continue;
        try {
          const r = JSON.parse(line);
          if (r && r.id != null && String(r.id) === targetId) return false;
        } catch { /* skip malformed line */ }
      }
    }
    const record = cleanRecord({ ...rawRecord, source });
    fs.appendFileSync(file, JSON.stringify(record) + "\n");
    invalidateCache();
    return true;
  } catch (e: any) {
    log("position_archive", `Failed to append ${source} record (id=${targetId}, month=${targetMonth}): ${e.message}`);
    return null;
  }
}

export function dedupeArchive(source: string, month?: string): number {
  ensureDir();
  const file = archivePath(source, month || currentMonth());
  if (!fs.existsSync(file)) return 0;
  try {
    const content = fs.readFileSync(file, "utf8");
    const lines = content.split("\n");
    const seen = new Set<string>();
    const deduped: string[] = [];
    let removed = 0;
    for (const line of lines) {
      if (!line) { deduped.push(line); continue; }
      try {
        const r = JSON.parse(line);
        if (r && r.id != null) {
          const id = String(r.id);
          if (seen.has(id)) { removed++; continue; }
          seen.add(id);
        }
        deduped.push(line);
      } catch {
        deduped.push(line);
      }
    }
    if (removed > 0) {
      const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
      fs.writeFileSync(tmp, deduped.join("\n"));
      fs.renameSync(tmp, file);
      invalidateCache();
      log("position_archive", `Removed ${removed} duplicate(s) from ${file}`);
    }
    return removed;
  } catch (e: any) {
    log("position_archive", `Failed to dedupe ${file}: ${e.message}`);
    return 0;
  }
}

export function dedupeAllArchives(source: string): number {
  ensureDir();
  const prefix = source === "paper" ? "vp" : "live";
  const files = fs.readdirSync(ARCHIVE_DIR)
    .filter((f) => new RegExp(`^${prefix}-archive-(\\d{4}-\\d{2})\\.jsonl$`).test(f));
  let total = 0;
  for (const f of files) {
    const month = f.match(/-(\d{4}-\d{2})\.jsonl$/)?.[1];
    if (month) total += dedupeArchive(source, month);
  }
  return total;
}

// ── Read ─────────────────────────────────────────────────────────────────

export async function readArchive({
  source,
  hours = 168,
  pool = null,
  limit = 100,
}: {
  source?: string;
  hours?: number;
  pool?: string | null;
  limit?: number;
} = {}): Promise<ArchiveRecord[]> {
  if (cacheIsValid(hours)) {
    let results = _cache!.records;
    if (source) results = results.filter((r) => r.source === source);
    if (pool) results = results.filter((r) => r.pool === pool);
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    results = results.filter((r) => r.closed_at && new Date(r.closed_at).getTime() >= cutoff);
    results.sort((a, b) => (b.closed_at || "").localeCompare(a.closed_at || ""));
    return results.slice(0, limit);
  }

  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  const cutoffMonth = new Date(cutoff).toISOString().slice(0, 7);
  const allRecords: ArchiveRecord[] = [];

  for (const src of ["paper", "live"]) {
    try {
      ensureDir();
      const files = fs.readdirSync(ARCHIVE_DIR)
        .filter((f) => {
          const prefix = src === "paper" ? "vp" : "live";
          const m = f.match(new RegExp(`^${prefix}-archive-(\\d{4}-\\d{2})\\.jsonl$`));
          return m && m[1] >= cutoffMonth;
        })
        .sort();

      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(ARCHIVE_DIR, file), "utf8");
          const lines = content.trim().split("\n").filter(Boolean);
          for (const line of lines) {
            try {
              const record = JSON.parse(line);
              if (record.closed_at && new Date(record.closed_at).getTime() >= cutoff) {
                allRecords.push(record);
              }
            } catch { /* skip bad line */ }
          }
        } catch (e: any) {
          log("position_archive", `Failed to read ${file}: ${e.message}`);
        }
      }
    } catch (e: any) {
      log("position_archive", `Failed to list archive dir: ${e.message}`);
    }
  }

  _cache = { records: allRecords, loadedAt: Date.now(), hours };

  let results = allRecords;
  if (source) results = results.filter((r) => r.source === source);
  results.sort((a, b) => (b.closed_at || "").localeCompare(a.closed_at || ""));
  results = results.slice(0, limit);

  return results;
}

// ── Migration ────────────────────────────────────────────────────────────

export function migrateOldArchives(): void {
  const files = fs.readdirSync(".").filter(
    (f) => f.startsWith("dry-run-state-archive-") && f.endsWith(".json"),
  );
  if (files.length === 0) return;

  ensureDir();
  const hasArchive = fs.readdirSync(ARCHIVE_DIR).some(
    (f) => /^(vp|live)-archive-\d{4}-\d{2}\.jsonl$/.test(f),
  );
  if (hasArchive) {
    log("position_archive", `JSONL archives exist — skipping migration`);
    return;
  }

  let migrated = 0;
  for (const file of files) {
    const monthMatch = file.match(/(\d{4}-\d{2})/);
    if (!monthMatch) continue;
    const month = monthMatch[1];
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const vp of data.virtual_positions || []) {
        if (vp.status === "closed" && vp.closed_at) {
          const outPath = archivePath("paper", month);
          const record = cleanRecord({ ...vp, source: "paper" });
          fs.appendFileSync(outPath, JSON.stringify(record) + "\n");
          migrated++;
        }
      }
    } catch (e: any) {
      log("position_archive", `Migration: failed to process ${file}: ${e.message}`);
    }
  }
  log("position_archive", `Migration complete: ${migrated} records migrated from ${files.length} archive file(s)`);
}

export function purgeCorruptedArchiveRecords(): void {
  ensureDir();
  const PNL_ABSURD_THRESHOLD = 100_000;
  try {
    const files = fs.readdirSync(ARCHIVE_DIR).filter(
      (f) => /^vp-archive-\d{4}-\d{2}\.jsonl$/.test(f),
    );
    let totalPurged = 0;
    for (const file of files) {
      const filePath = path.join(ARCHIVE_DIR, file);
      try {
        const content = fs.readFileSync(filePath, "utf8");
        const lines = content.trim().split("\n").filter(Boolean);
        const validLines: string[] = [];
        let purgedInFile = 0;
        for (const line of lines) {
          try {
            const record = JSON.parse(line);
            if (record.close_pnl_pct != null && Math.abs(record.close_pnl_pct) > PNL_ABSURD_THRESHOLD) {
              purgedInFile++;
              continue;
            }
            validLines.push(line);
          } catch {
            validLines.push(line);
          }
        }
        if (purgedInFile > 0) {
          fs.writeFileSync(filePath, validLines.join("\n") + (validLines.length ? "\n" : ""));
          totalPurged += purgedInFile;
          log("position_archive", `Purged ${purgedInFile} corrupted records from ${file}`);
        }
      } catch (e: any) {
        log("position_archive", `Failed to process ${file} during purge: ${e.message}`);
      }
    }
    if (totalPurged > 0) {
      invalidateCache();
      log("position_archive", `Archive purge complete: ${totalPurged} corrupted records removed`);
    }
  } catch (e: any) {
    log("position_archive", `Archive purge failed: ${e.message}`);
  }
}

export function compileVpStats(records: ArchiveRecord[]): string {
  if (!records || records.length === 0) {
    return "📊 **VP Performance Summary (Last 30 Days)**\nNo closed virtual positions found in the archive.";
  }

  let total = records.length;
  let wins = 0;
  let totalPnLUsd = 0;
  let totalPnLSol = 0;
  let totalHoldMinutes = 0;

  let totalILUsd = 0;
  let totalILSol = 0;
  let totalFeesUsd = 0;
  let totalFeesSol = 0;
  let totalCostUsd = 0;
  let totalCostSol = 0;

  const reasons: Record<string, number> = {};

  for (const r of records) {
    const pnlPct = r.close_pnl_pct ?? 0;
    if (pnlPct > 0) wins++;

    totalPnLUsd += r.close_pnl_usd ?? 0;
    totalPnLSol += r.close_pnl_sol ?? 0;
    totalHoldMinutes += r.minutes_held ?? 0;

    totalILUsd += r.close_il_usd ?? 0;
    totalILSol += r.close_il_sol ?? 0;
    totalFeesUsd += r.close_fees_usd ?? r.total_fees_earned_usd ?? 0;
    totalFeesSol += r.close_fees_sol ?? 0;
    totalCostUsd += r.close_cost_usd ?? 0;
    totalCostSol += r.close_cost_sol ?? 0;

    const reason = r.close_reason || "unknown";
    reasons[reason] = (reasons[reason] || 0) + 1;
  }

  const winRate = (wins / total) * 100;
  const avgHoldMinutes = totalHoldMinutes / total;
  const avgHoldHours = avgHoldMinutes / 60;
  const avgPnLUsd = totalPnLUsd / total;
  const avgPnLSol = totalPnLSol / total;

  const avgILUsd = totalILUsd / total;
  const avgILSol = totalILSol / total;
  const avgFeesUsd = totalFeesUsd / total;
  const avgFeesSol = totalFeesSol / total;
  const avgCostUsd = totalCostUsd / total;
  const avgCostSol = totalCostSol / total;

  const reasonLines = Object.entries(reasons)
    .sort((a, b) => b[1] - a[1])
    .map(([r, count]) => `  • ${r}: ${count} (${((count / total) * 100).toFixed(1)}%)`)
    .join("\n");

  return [
    `📈 **VP Performance Summary (Last 30 Days)**`,
    `• **Total Closed**: ${total}`,
    `• **Win Rate**: ${winRate.toFixed(1)}% (${wins}/${total} wins)`,
    `• **Avg Hold Time**: ${avgHoldHours.toFixed(1)} hours (${Math.round(avgHoldMinutes)} mins)`,
    `• **Aggregate PnL**: $${totalPnLUsd.toFixed(2)} | ◎${totalPnLSol.toFixed(4)}`,
    `• **Avg PnL per Position**: $${avgPnLUsd.toFixed(2)} | ◎${avgPnLSol.toFixed(4)}`,
    ``,
    `🔍 **Average Position Breakdown**:`,
    `  • IL: $${avgILUsd.toFixed(2)} | ◎${avgILSol.toFixed(4)}`,
    `  • Fees: $${avgFeesUsd.toFixed(2)} | ◎${avgFeesSol.toFixed(4)}`,
    `  • Cost: $${avgCostUsd.toFixed(2)} | ◎${avgCostSol.toFixed(4)}`,
    ``,
    `🚪 **Close Reasons**:`,
    reasonLines,
  ].join("\n");
}
