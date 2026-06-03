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
import { log } from "../logger.js";

// ── Paths ────────────────────────────────────────────────────────────────
const ARCHIVE_DIR = "./archives";

function ensureDir() {
  if (!fs.existsSync(ARCHIVE_DIR)) {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  }
}

function archivePath(source, month) {
  const prefix = source === "paper" ? "vp" : "live";
  return `${ARCHIVE_DIR}/${prefix}-archive-${month}.jsonl`;
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7); // "2026-06"
}

// ── Cache ────────────────────────────────────────────────────────────────
let _cache = null;   // { records: ArchiveRecord[], loadedAt: number, hours: number }
const CACHE_TTL_MS = 5 * 60 * 1000;

function cacheIsValid(hours) {
  return _cache && _cache.hours === hours && (Date.now() - _cache.loadedAt < CACHE_TTL_MS);
}

function invalidateCache() {
  _cache = null;
}

// ── Field normalization ─────────────────────────────────────────────────
const KNOWN_FIELDS = [
  "source", "id", "pool", "pool_name", "pair", "base_mint",
  "strategy", "lower_bin", "upper_bin", "active_bin_at_deploy",
  "bin_step", "amount_sol", "initial_value_usd", "sol_price_at_deploy",
  "deployed_at", "closed_at", "minutes_held", "minutes_in_range",
  "range_efficiency", "close_reason", "close_pnl_pct", "close_pnl_usd",
  "total_fees_earned_usd", "volatility", "fee_tvl_ratio", "organic_score",
  "deploy_rationale", "signal_snapshot", "bin_shares", "tx_hashes", "relay",
];

/**
 * Extract only known schema fields from a raw record (e.g. a VP object with
 * internal fields like _oor_since, snapshots, current_value_usd).
 * Unknown fields are dropped. Missing fields default to null.
 * deploy_rationale is truncated to 200 chars.
 */
export function cleanRecord(raw) {
  const r = {};
  for (const k of KNOWN_FIELDS) {
    r[k] = raw[k] !== undefined ? raw[k] : null;
  }
  // Compute minutes_held from timestamps if not already set
  if (r.minutes_held == null && r.deployed_at && r.closed_at) {
    r.minutes_held = Math.max(0, Math.round(
      (new Date(r.closed_at) - new Date(r.deployed_at)) / 60000,
    ));
  }
  // Truncate deploy_rationale
  if (typeof r.deploy_rationale === "string" && r.deploy_rationale.length > 200) {
    r.deploy_rationale = r.deploy_rationale.slice(0, 200) + "...";
  }
  return r;
}

// ── Write ────────────────────────────────────────────────────────────────

/**
 * Append a closed position record to the archive.
 * O(1) — no read, no rewrite. Invalidates the read cache.
 *
 * @param {"paper"|"live"} source
 * @param {object} rawRecord  Will be cleaned via cleanRecord()
 */
export function appendArchiveRecord(source, rawRecord) {
  ensureDir();
  const file = archivePath(source, currentMonth());
  const record = cleanRecord({ ...rawRecord, source });
  try {
    fs.appendFileSync(file, JSON.stringify(record) + "\n");
    invalidateCache();
  } catch (e) {
    log("position_archive", `Failed to append ${source} record: ${e.message}`);
  }
}

// ── Read ─────────────────────────────────────────────────────────────────

/**
 * Read closed position records from archive files with optional filters.
 *
 * @param {object} [opts]
 * @param {"paper"|"live"} [opts.source]      Filter by source. Omit for both.
 * @param {number}           [opts.hours=168]    Lookback window (default 7 days)
 * @param {string}           [opts.pool]         Filter by exact pool address
 * @param {number}           [opts.limit=100]    Max records
 * @returns {Promise<object[]>} Cleaned archive records
 */
export async function readArchive({ source, hours = 168, pool = null, limit = 100 } = {}) {
  // Use cache if valid (keyed by hours to prevent short-window result poisoning)
  if (cacheIsValid(hours)) {
    let results = _cache.records;
    if (source) results = results.filter((r) => r.source === source);
    if (pool) results = results.filter((r) => r.pool === pool);
    // Apply time filter
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    results = results.filter((r) => r.closed_at && new Date(r.closed_at).getTime() >= cutoff);
    results.sort((a, b) => (b.closed_at || "").localeCompare(a.closed_at || ""));
    return results.slice(0, limit);
  }

  // Load from files — always read BOTH sources to keep cache complete
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  const cutoffMonth = new Date(cutoff).toISOString().slice(0, 7);
  const allRecords = [];

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
        } catch (e) {
          log("position_archive", `Failed to read ${file}: ${e.message}`);
        }
      }
    } catch (e) {
      log("position_archive", `Failed to list archive dir: ${e.message}`);
    }
  }

  // Populate/update cache with ALL loaded records (before filtering/limit)
  // Always overwrite — even an existing cache gets refreshed with the
  // widest-recently-requested window so subsequent queries hit.
  _cache = { records: allRecords, loadedAt: Date.now(), hours };

  // Apply source filter on results (same as cache-hit path)
  let results = allRecords;
  if (source) results = results.filter((r) => r.source === source);

  // Sort by closed_at desc, limit
  results.sort((a, b) => (b.closed_at || "").localeCompare(a.closed_at || ""));
  results = results.slice(0, limit);

  return results;
}

// ── Migration ────────────────────────────────────────────────────────────

/**
 * One-time migration from old dry-run-state-archive-*.json format to JSONL.
 * Reads old archives, writes JSONL, checks if already migrated.
 * Idempotent — safe to call on every startup.
 */
export function migrateOldArchives() {
  const files = fs.readdirSync(".").filter(
    (f) => f.startsWith("dry-run-state-archive-") && f.endsWith(".json"),
  );
  if (files.length === 0) return;

  ensureDir();
  // Check if JSONL archives already exist — don't re-migrate
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
    } catch (e) {
      log("position_archive", `Migration: failed to process ${file}: ${e.message}`);
    }
  }
  log("position_archive", `Migration complete: ${migrated} records migrated from ${files.length} archive file(s)`);
}
