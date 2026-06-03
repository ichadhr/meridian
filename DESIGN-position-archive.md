# Position Archive & Query System

## Motivation
The Paper Position (simulated) system archives closes to `dry-run-state-archive-*.json` (JSON array, read-modify-write). These archives power:
- `generateVirtualDigest()` — aggregate patterns for SCREENER prompt
- `generateDryRunReport()` — HTML calendar report

These tools have no path to consume **live** close data. When we go live, the same query tools (`get_pool_history`, `query_positions`) should work for both VP and live closes without refactoring.

## Design

### 1. JSONL Format (Append-Only)

Replace JSON array archives (`read → parse → push → write`) with JSONL (one JSON object per line, append-only):

```
# archives/vp-archive-2026-06.jsonl
{"source":"paper","id":"vp_001","pool":"abc...","close_pnl_pct":-15.2,...}
{"source":"paper","id":"vp_002","pool":"def...","close_pnl_pct":8.3,...}
...
```

**Advantages:**
- O(1) append (appendFileSync vs readFileSync → JSON.parse → push → JSON.stringify → writeFileSync)
- No corruption risk from partial rewrites
- Easy to tail/read partially
- Compatible with streaming and grep tools

### 2. File Layout

```
archives/
  vp-archive-2026-06.jsonl    # Virtual position closes
  live-archive-2026-06.jsonl  # Real position closes (future)
  screening-log.jsonl         # (optional) Screening decisions
```

Monthly rotation (YYYY-MM). New file starts on the 1st of each month.

### 3. Unified Archive Schema

```typescript
interface ArchiveRecord {
  // ── Source identity ──
  source: "paper" | "live";           // discriminator
  id: string;                            // "vp_001" or position_address

  // ── Pool identity ──
  pool: string;                          // pool address
  pool_name: string | null;
  pair: string;
  base_mint: string | null;              // live only, null for VP
  strategy: "spot" | "bid_ask" | "curve";

  // ── Deploy details ──
  lower_bin: number;
  upper_bin: number;
  active_bin_at_deploy: number | null;
  bin_step: number;
  amount_sol: number;
  initial_value_usd: number;
  sol_price_at_deploy: number | null;

  // ── Timing (minutes_held computed from deployed_at/closed_at for VP on read) ──
  deployed_at: string;                   // ISO
  closed_at: string;                     // ISO
  minutes_held: number | null;
  minutes_in_range: number | null;       // live only, null for VP
  range_efficiency: number | null;       // live only, null for VP

  // ── Performance ──
  close_reason: string;
  close_pnl_pct: number;
  close_pnl_usd: number;
  total_fees_earned_usd: number;

  // ── Screening signals ──
  volatility: number | null;
  fee_tvl_ratio: number | null;
  organic_score: number | null;
  deploy_rationale: string | null;       // truncated to 200 chars
  signal_snapshot: object | null;        // live only — full screening context

  // ── Type-specific ──
  bin_shares: object[] | null;           // VP only
  tx_hashes: string[] | null;            // live only
  relay: boolean | null;                 // live only — was relay close?
}
```

**Essential fields** (must always be populated): source, id, pool, pair, strategy, amount_sol, initial_value_usd, deployed_at, closed_at, close_reason, close_pnl_pct, close_pnl_usd, total_fees_earned_usd.

**Paper-only fields**: bin_shares (always null for live).
**Live-only fields**: base_mint, minutes_in_range, range_efficiency, signal_snapshot, tx_hashes, relay (always null for VP).

### 4. Module: `position-archive.js`

Single module for all archive I/O.

```js
// Write — O(1) append. Accepts any object, extracts only known schema fields
// (normalizes raw VP objects with internal fields like _oor_since, snapshots).
appendArchiveRecord(source: "virtual"|"live", record: object): void

// Read — async O(n) parse with filters
readArchive({ source?, hours?, pool?, limit?, minPnl?, strategy? }): Promise<ArchiveRecord[]>

// Digest — async aggregate stats from VP archives (replaces current virtual-digest.js logic)
getVpDigest({ hours?, minCloses?, maxCloses? }): Promise<string | null>
```

**Cache**: In-memory cache with 5-minute TTL. Results cached per `readArchive`; subsequent queries within a SCREENER cycle hit cache.

**On write, cache is invalidated immediately** so newly closed positions are visible on the next read. TTL is a fallback for reads-only cycles.

**Field normalization**: `appendArchiveRecord` extracts only known schema fields and defaults missing ones to `null`. This prevents internal VP fields (`_oor_since`, `_trailing_active`, `snapshots`, `current_value_usd`, etc.) from leaking into archives.

### 5. LLM Surface: Extend Existing Tools (No New Tools)

**Decision: Do NOT create new tools.** The existing `get_pool_memory` and `get_performance_history` already serve the same intents. New tools would create confusion ("which one do I call?").

#### `get_pool_memory` — Zero changes

VP closes already call `recordPoolDeploy` via `recordVpDeployToPoolMemory` in `manage-virtual.js`. Pool-memory.json therefore already includes VP deploy history. `getPoolMemory` automatically returns VP data without any code change.

**Why this works:** The cooldown system reads from pool-memory.json, so VP closes correctly contribute to cooldown logic. If we merged at read time instead, cooldown would see inconsistent state.

#### `get_performance_history` — Extended

Add VP archive merge + new filters:

```js
// New params:
source: "paper" | "live" | null   // Filter by source (omit = both)
volatility_min: number               // Min volatility filter
close_reason: string                 // Filter by close reason
min_pnl_pct: number                  // Min PnL % (e.g. -10 = PnL ≥ -10%)
max_pnl_pct: number                  // Max PnL %
```

**Merge behavior:** `getPerformanceHistory` reads from both lessons.json (live) and VP archives (via `position-archive.js`). Merged results sorted by closed_at desc, then limited. Each position tagged with `source: "live"|"virtual"`.

**Add to SCREENER_TOOLS:** Currently GENERAL-only. Adding it lets the SCREENER analyze patterns before deploying.

### 6. Changes to Existing Files

#### `dry-run-state.js`
- Remove `appendToArchive()` function (lines ~126-149)
- Remove `getArchivePath()` (no longer needed)
- Replace with: `import { appendArchiveRecord } from "./position-archive.js"`
- `closeVirtualPosition()` calls `appendArchiveRecord("virtual", cleanedRecord)` before closing
- Keep `archiveVirtualPositions()` but fix it to only archive closed VPs, or remove it since it's unused

#### `virtual-digest.js`
- Remove `getArchiveFiles()` and `loadArchivedCloses()`
- Import `readArchive` from `position-archive.js`
- `generateVirtualDigest()` calls `readArchive({ source: "virtual", hours, limit: maxCloses })`
- Keep all formatting, aggregation, bucket logic unchanged
- Tighten `maxCloses: 20` → `10`

#### `generate-dry-run-report.js`
- `loadAllClosedPositions()` reads from `archives/vp-archive-*.jsonl` instead of `dry-run-state-archive-*.json`
- Parse JSONL line by line
- Still include open positions from `dry-run-state.json` (current behavior)

#### `lessons.js`
- `getPerformanceHistory()` extended with new params: `source`, `volatility_min`, `close_reason`, `min_pnl_pct`, `max_pnl_pct`
- If `source !== "live"`, read from VP archives via `position-archive.js` and merge
- Each position tagged with `source: "live" | "virtual"`
- Output includes `volatility` field (new)
- `getPerformanceSummary()` stays unchanged (only reads lessons.json — live stats in prompt remain real)

#### `dlmm.js` (future — when going live)
- In both close paths (relay close ~line 1741, local close ~line 1984):
  - After `await recordPerformance(...)`, add:
  ```js
  const { appendArchiveRecord } = await import("./position-archive.js");
  appendArchiveRecord("live", { ...normalizedLiveClose });
  ```

### 7. Wiring

#### `tools/definitions.js`
- Update `get_performance_history` schema with new params: `source`, `volatility_min`, `close_reason`, `min_pnl_pct`, `max_pnl_pct`

#### `agent.js`
- Add `"get_performance_history"` to `SCREENER_TOOLS`

#### `prompt.js`
- Keep `virtualDigest` param (reads from archive, unchanged format)
- Tighten digest hint: `"Use get_performance_history for specific historical queries."`

### 8. Edge Cases & Safeguards

| Concern | Mitigation |
|---------|------------|
| Corrupted JSONL line | `readArchive` wraps each `JSON.parse` in try/catch — skips bad lines |
| Empty archives on first run | `readArchive` returns empty array → digest returns null → no prompt section rendered |
| Missing `closed_at` | Filtered out with `if (!r.closed_at) continue` |
| NaN in numeric fields | `safeNum()` helper: `Number.isFinite(n) ? n : 0` |
| 5-min cache serves stale data | Cache invalidated on write; TTL is fallback for reads-only cycles |
| `archiveVirtualPositions()` drafts open-position noise | Called when app shuts down with open VPs. These lack close data. **Fix**: filter to `status: "closed"` in the function, or call only when explicitly needed. |
| CWD changes | Archive path resolved relative to `process.cwd()`. Same convention as existing state files |
| VP archive vs live archive naming | Separate files by source; query tools merge on read |
| LLM step budget | Tools are for targeted follow-up, not routine calls. Digest covers ambient context |

### 9. Migration Path

**Run one-time migration on startup** if old archives exist and JSONL files don't. This prevents historical data loss:

```js
// One-time migration on startup
function migrateOldArchives() {
  const ARCHIVE_DIR = "./archives";
  if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  const files = fs.readdirSync(".").filter(f =>
    f.startsWith("dry-run-state-archive-") && f.endsWith(".json")
  );
  if (files.length === 0) return;
  // Check if JSONL already exists — don't re-migrate
  const jsonlFiles = fs.readdirSync(ARCHIVE_DIR).filter(f =>
    f.startsWith("vp-archive-") && f.endsWith(".jsonl")
  );
  if (jsonlFiles.length > 0) return; // already migrated

  for (const file of files) {
    const monthMatch = file.match(/(\d{4}-\d{2})/);
    if (!monthMatch) continue;
    const month = monthMatch[1];
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const vp of data.virtual_positions || []) {
      if (vp.status === "closed" && vp.closed_at) {
        const outPath = `${ARCHIVE_DIR}/vp-archive-${month}.jsonl`;
        fs.appendFileSync(outPath, JSON.stringify(cleanRecord(vp)) + "\n");
      }
    }
  }
}
```

After migration, old `dry-run-state-archive-*.json` files stay on disk as untouched artifacts. All new reads go through JSONL.

### 10. `archiveVirtualPositions()` — Remove or Fix

`dry-run-state.js` has `archiveVirtualPositions()` (lines 162-172) that archives ALL VPs regardless of status. With JSONL:
- **Remove** the function entirely — it's unused in the main flow (never imported). VPs are archived individually on close.
- If it is used somewhere (shutdown hook), filter to `status: "closed"` before appending.

### 11. Screening History (Stretch)

Optional `screening-log.jsonl` that captures every pool the SCREENER evaluated, whether it was deployed, and rejection reason:

```jsonl
{"ts":"2026-06-04T12:00:00Z","pool":"abc...","pool_name":"SOL-USDC","screened_in":true,"deployed":true,"signals":{"tvl":50000,"volume":2000,"fee_tvl_ratio":0.08,"volatility":3.2},"deploy_rationale":"Strong fee_tvl with moderate vol"}
{"ts":"2026-06-04T12:05:00Z","pool":"def...","pool_name":"MEME-SOL","screened_in":true,"deployed":false,"rejection_reason":"Rejected by LLM","signals":{"tvl":15000,"volume":500,"fee_tvl_ratio":0.02,"volatility":5.5}}
{"ts":"2026-06-04T12:10:00Z","pool":"ghi...","pool_name":"SCAM-TOKEN","screened_in":false,"deployed":false,"rejection_reason":"filter: bundler_pct > 30%"}
```

This lets the LLM answer: "What have I been rejecting and why?" Not building initially — documented for later.
