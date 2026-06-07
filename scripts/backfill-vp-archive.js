#!/usr/bin/env node
// Unified VP archive backfill. Single source of truth for syncing local state
// from server-pulled archives.
//
// BEHAVIOR
//   - Reads every archives/vp-archive-*.jsonl file (glob).
//   - Keeps vp-ISO format only; drops vp_NNN (old format, pre-JSON-rename).
//   - Excludes hardcoded IDs (e.g. GRAIL-SOL, failed Meteora OHLCV validation).
//   - Idempotent: dedupes against lessons.json by position id — re-runs are no-ops.
//   - Sorts by closed_at ascending so Darwin/Threshold milestones fire naturally.
//   - Hive pushes disabled at env level (no outbound events for historical closes).
//   - pool-memory.json rebuilt from archives/pool-memory.json (server canonical):
//       * GRAIL-SOL pool entry removed
//       * Any vp_NNN deploy (cross-referenced by deployed_at+closed_at) removed
//       * Restored at the end, undoing recordPoolDeploy side effects
//
// USAGE
//   node scripts/backfill-vp-archive.js                       # default archives/
//   node scripts/backfill-vp-archive.js --archive <path>     # specific file
//
// STATE FILES TOUCHED
//   lessons.json         (recordPerformance appends perf + lessons + Darwin recalc)
//   signal-weights.json  (Darwin evolves thresholds, recalc_count++ at milestones)
//   pool-memory.json     (final: server canonical, cleaned)
//   user-config.json     (threshold evolution persists; minFeeActiveTvlRatio etc.)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '..');

// CRITICAL: lessons.js and pool-memory.js use CWD-relative paths
// ("./lessons.json", "./pool-memory.json"). If the user runs this script
// from any directory other than the project root, those writes land in
// the wrong place. chdir to ROOT up front so all CWD-relative paths
// inside the imported modules resolve to the project root.
process.chdir(ROOT);

const ARCHIVE_DIR = path.join(ROOT, 'archives');
const SERVER_PM = path.join(ARCHIVE_DIR, 'pool-memory.json');
const LESSONS = path.join(ROOT, 'lessons.json');
const POOL_MEMORY = path.join(ROOT, 'pool-memory.json');
const SIGNAL_WEIGHTS = path.join(ROOT, 'signal-weights.json');
const USER_CONFIG = path.join(ROOT, 'user-config.json');

// Records excluded from backfill (failed validation, semantically invalid, etc.)
const EXCLUDED_IDS = new Set([
  'vp-20260607T064203Z', // GRAIL-SOL: 23min pre-OHLCV gap + flat price across 8 candles
]);

// ─── 1. DISABLE HIVE ──────────────────────────────────────────────────────────
process.env.HIVE_MIND_URL = '';
process.env.HIVE_MIND_API_KEY = '';
console.log('✓ Hive disabled (no outbound events will be sent during backfill)');

// ─── 2. RESOLVE ARCHIVE FILES ────────────────────────────────────────────────
const argArchive = process.argv.find((a, i) => process.argv[i - 1] === '--archive');
let archiveFiles;
if (argArchive) {
  archiveFiles = [path.isAbsolute(argArchive) ? argArchive : path.join(ROOT, argArchive)];
} else {
  archiveFiles = fs.readdirSync(ARCHIVE_DIR)
    .filter((f) => /^vp-archive-.*\.jsonl$/.test(f))
    .sort()
    .map((f) => path.join(ARCHIVE_DIR, f));
}
if (archiveFiles.length === 0) {
  console.error(`✗ No archive files found in ${ARCHIVE_DIR} matching vp-archive-*.jsonl`);
  process.exit(1);
}
console.log(`✓ Found ${archiveFiles.length} archive file(s):`);
for (const f of archiveFiles) console.log(`    ${path.basename(f)}`);

// ─── 3. LOAD & FILTER RECORDS ────────────────────────────────────────────────
const allRecords = [];
for (const f of archiveFiles) {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  for (const l of lines) {
    if (l.trim()) allRecords.push(JSON.parse(l));
  }
}

const vpISO = allRecords.filter((r) => /^vp-\d{8}T\d{6}Z$/.test(r.id));
const vpOld = allRecords.filter((r) => /^vp_\d+$/.test(r.id));
const filtered = vpISO.filter((r) => !EXCLUDED_IDS.has(r.id));
filtered.sort((a, b) => new Date(a.closed_at) - new Date(b.closed_at));

console.log(`\n✓ Records: ${allRecords.length} total`);
console.log(`    vp-ISO format: ${vpISO.length}`);
console.log(`    vp_NNN format (dropped): ${vpOld.length}`);
console.log(`    Excluded by ID: ${[...EXCLUDED_IDS].join(', ')}`);
console.log(`    To process: ${filtered.length}`);

// ─── 3b. WRITE BACK CLEANED ARCHIVE FILES ────────────────────────────────────
// Removes vp_NNN + excluded IDs from source archives/vp-archive-*.jsonl in place.
// Future runs (and validation scripts) only see clean records.
for (const f of archiveFiles) {
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim());
  const before = lines.length;
  const kept = lines
    .map((l) => JSON.parse(l))
    .filter((r) => /^vp-\d{8}T\d{6}Z$/.test(r.id) && !EXCLUDED_IDS.has(r.id));
  if (kept.length !== before) {
    fs.writeFileSync(f, kept.map((r) => JSON.stringify(r)).join('\n') + '\n');
    console.log(`    ✓ Cleaned ${path.basename(f)}: ${before} → ${kept.length} records`);
  }
}

// ─── 4. SNAPSHOT STATE ───────────────────────────────────────────────────────
const STATE_FILES = {
  lessons: LESSONS,
  poolMemory: POOL_MEMORY,
  signalWeights: SIGNAL_WEIGHTS,
  userConfig: USER_CONFIG,
};

function snapshot(label) {
  console.log(`\n─── ${label} ───`);
  for (const [name, p] of Object.entries(STATE_FILES)) {
    if (!fs.existsSync(p)) {
      console.log(`  ${name}: (not found)`);
      continue;
    }
    const stat = fs.statSync(p);
    let summary = `${stat.size} bytes`;
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (name === 'lessons' && parsed.performance) {
        summary = `${parsed.performance.length} performance, ${parsed.lessons?.length || 0} lessons`;
      } else if (name === 'signalWeights' && parsed.weights) {
        summary = `${Object.keys(parsed.weights).length} weights, recalc_count=${parsed.recalc_count || 0}`;
      } else if (name === 'poolMemory') {
        summary = `${Object.keys(parsed).length} pools`;
      }
    } catch {}
    console.log(`  ${name}: ${summary}`);
  }
}

snapshot('BEFORE');

// ─── 5. DEDUP AGAINST LESSONS.JSON ───────────────────────────────────────────
let lessons = { performance: [], lessons: [] };
if (fs.existsSync(LESSONS)) {
  lessons = JSON.parse(fs.readFileSync(LESSONS, 'utf8'));
} else {
  // Fresh server (no prior backfill): initialize empty lessons.json
  fs.writeFileSync(LESSONS, JSON.stringify(lessons, null, 2));
  console.log('\n  ✓ Initialized empty lessons.json (fresh server)');
}
const knownIds = new Set(lessons.performance.map((p) => p.position));
const newRecords = filtered.filter((r) => !knownIds.has(r.id));
console.log(`\n✓ Dedup: ${filtered.length - newRecords.length} already in lessons.json, ${newRecords.length} new`);
if (newRecords.length === 0) {
  console.log('  Nothing to backfill. Skipping recordPerformance loop.');
} else {
  console.log('  New records:');
  for (const r of newRecords) {
    console.log(`    + ${r.id}  ${r.pool_name}  pnl_usd=${r.close_pnl_usd.toFixed(3)}  closed=${r.closed_at}`);
  }
}

// ─── 6. PREPARE SERVER CANONICAL POOL-MEMORY ─────────────────────────────────
let serverPM = null;
let vpOldTuples = new Set();
if (fs.existsSync(SERVER_PM)) {
  serverPM = JSON.parse(fs.readFileSync(SERVER_PM, 'utf8'));
  vpOldTuples = new Set(vpOld.map((r) => `${r.deployed_at}|${r.closed_at}`));
  let removedEntries = 0;
  let removedDeploys = 0;

  // Remove GRAIL-SOL pool entry (and any other excluded pool by name)
  const excludedNames = new Set(['GRAIL-SOL']); // extend if needed
  for (const [addr, entry] of Object.entries(serverPM)) {
    if (excludedNames.has(entry.name)) {
      delete serverPM[addr];
      removedEntries++;
      continue;
    }
    const before = entry.deploys.length;
    entry.deploys = entry.deploys.filter(
      (d) => !vpOldTuples.has(`${d.deployed_at}|${d.closed_at}`)
    );
    const removed = before - entry.deploys.length;
    if (removed > 0) {
      removedDeploys += removed;
      entry.total_deploys = entry.deploys.length;
      const withPnl = entry.deploys.filter((d) => d.pnl_pct != null);
      if (withPnl.length > 0) {
        entry.avg_pnl_pct =
          Math.round((withPnl.reduce((s, d) => s + d.pnl_pct, 0) / withPnl.length) * 100) / 100;
        entry.win_rate =
          Math.round((withPnl.filter((d) => d.pnl_pct >= 0).length / withPnl.length) * 100) / 100;
      } else {
        entry.avg_pnl_pct = 0;
        entry.win_rate = 0;
      }
      if (entry.deploys.length > 0) {
        const last = entry.deploys[entry.deploys.length - 1];
        entry.last_deployed_at = last.closed_at;
        entry.last_outcome = (last.pnl_pct ?? 0) >= 0 ? 'profit' : 'loss';
      } else {
        entry.last_deployed_at = null;
        entry.last_outcome = null;
      }
    }
  }
  console.log(`\n✓ Server pool-memory.json: ${Object.keys(serverPM).length} pools (after cleaning)`);
  if (removedEntries || removedDeploys) {
    console.log(`    Removed: ${removedEntries} pool(s), ${removedDeploys} vp_NNN deploy(s)`);
  }

  // Strip old-format snapshots (vp:vp_NNN position references) from every pool
  let removedSnapshots = 0;
  for (const entry of Object.values(serverPM)) {
    const before = (entry.snapshots || []).length;
    entry.snapshots = (entry.snapshots || []).filter(
      (s) => !(typeof s.position === 'string' && /vp:vp_\d+$/.test(s.position))
    );
    removedSnapshots += before - entry.snapshots.length;
  }
  if (removedSnapshots > 0) {
    console.log(`    Removed: ${removedSnapshots} old-format snapshot(s) (vp:vp_NNN position refs)`);
  }

  if (removedEntries || removedDeploys || removedSnapshots) {
    fs.writeFileSync(SERVER_PM, JSON.stringify(serverPM, null, 2));
    console.log(`    ✓ Cleaned ${path.basename(SERVER_PM)} in place`);
  }
} else {
  console.log(`\n⚠ No server pool-memory at ${SERVER_PM} — pool-memory.json will be derived from recordPoolDeploy calls only`);
}

// ─── 7. BACKFILL LOOP ─────────────────────────────────────────────────────────
const { recordPerformance } = await import('../lessons.js');

let success = 0;
let errors = [];
for (const r of newRecords) {
  const perf = {
    position: r.id,
    pool: r.pool,
    pool_name: r.pool_name,
    base_mint: r.base_mint,
    strategy: r.strategy,
    bin_step: r.bin_step,
    bin_range: { min: r.lower_bin, max: r.upper_bin },
    amount_sol: r.amount_sol,
    initial_value_usd: r.initial_value_usd,
    final_value_usd: r.initial_value_usd + r.close_pnl_usd,
    fees_earned_usd: r.close_fees_usd,
    fees_earned_sol: r.close_fees_sol,
    close_reason: r.close_reason,
    close_pnl_usd: r.close_pnl_usd,
    close_pnl_sol: r.close_pnl_sol,
    close_il_usd: r.close_il_usd,
    close_il_sol: r.close_il_sol,
    deployed_at: r.deployed_at,
    closed_at: r.closed_at,
    minutes_held: r.minutes_held,
    minutes_in_range: r.minutes_in_range,
    range_efficiency: r.range_efficiency,
    volatility: r.volatility,
    fee_tvl_ratio: r.fee_tvl_ratio,
    organic_score: r.organic_score,
    signal_snapshot: r.signal_snapshot,
  };
  try {
    await recordPerformance(perf);
    success++;
  } catch (e) {
    errors.push({ id: r.id, error: e.message });
  }
}

console.log(`\n✓ Backfill: ${success}/${newRecords.length} processed, ${errors.length} errors`);
if (errors.length > 0) {
  console.log('  Errors:');
  for (const e of errors.slice(0, 10)) {
    console.log(`    ${e.id}: ${e.error}`);
  }
}

// ─── 8. APPLY SERVER CANONICAL POOL-MEMORY (undoes recordPoolDeploy) ────────
if (serverPM) {
  fs.writeFileSync(POOL_MEMORY, JSON.stringify(serverPM, null, 2));
  console.log(`\n✓ pool-memory.json → server canonical (${Object.keys(serverPM).length} pools, ${Object.values(serverPM).reduce((s, e) => s + (e.total_deploys || 0), 0)} total deploys)`);
}

snapshot('AFTER');
