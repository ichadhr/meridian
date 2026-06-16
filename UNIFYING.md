# Unifying Live & VP Positions — Reference

Side-by-side comparison of the two position systems.

---

## 1. Tracking (Register)

### Current Functions

| Purpose | Live (`core/live/state.ts`) | VP (`core/vp/state.ts`) |
|---------|----------------------------|--------------------------|
| Register | `trackLivePosition(...)` | `trackVpPosition(...)` |
| List | `getLivePositions(openOnly?)` | `listVpPositions(statusFilter?)` |
| Get single | `getLivePosition(address)` | `getVpPosition(id)` |
| Summary | `getLiveStateSummary()` (dispatcher) | `getVpStateSummary()` (dispatcher) |

### Unified Naming Convention

Standardize function names with `Live` / `Vp` prefix for easier discovery and maintenance.

| Purpose | Live Before | Live After | VP Before | VP After |
|---------|-------------|------------|-----------|----------|
| Register | `trackPosition` | `trackLivePosition` | `trackVirtualPosition` | `trackVpPosition` |
| List | `getTrackedPositions` | `getLivePositions` | `listVirtualPositions` | `listVpPositions` |
| Get single | `getTrackedPosition` | `getLivePosition` | `getVirtualPosition` | `getVpPosition` |
| Summary | `getStateSummary` | `getLiveStateSummary` | — | `getVpStateSummary` |

### `getStateSummary()` — Now Fixed

**What it does:** Aggregates positions from state file into an LLM-digestible snapshot. Fed into the system prompt as `Memory: ${JSON.stringify(stateSummary)}` for SCREENER and GENERAL roles.

```typescript
// core/state.ts — dispatcher routes based on DRY_RUN
async function getStateSummary(): Promise<StateSummary> {
  if (process.env.DRY_RUN === "true") {
    return getVpStateSummary();  // reads vp_state.json
  }
  return getLiveStateSummary();  // reads live_state.json
}

// Both return the same async type:
async function getLiveStateSummary(): Promise<StateSummary> { ... }
async function getVpStateSummary(): Promise<StateSummary> { ... }
```

**Shared type** (`types/index.ts`):
```typescript
interface StateSummaryPosition {
  position: string;
  pool: string;
  strategy: string | null;
  deployed_at: string;
  out_of_range_since: string | null;
  minutes_out_of_range: number;
  total_fees_claimed_usd: number;
  initial_fee_tvl_24h: number | null;
  rebalance_count: number;
  instruction: string | null;
}

interface StateSummaryEvent {
  ts: string;
  action: string;
  [key: string]: unknown;
}

interface StateSummary {
  open_positions: number;
  closed_positions: number;
  total_fees_claimed_usd: number;
  positions: StateSummaryPosition[];
  last_updated: string | null;
  recent_events: StateSummaryEvent[];
}
```

**How it's consumed:** By `llm/agent.ts:174` → `await getStateSummary()` → passed to `buildSystemPrompt()` → injected as "Memory" in the system prompt for SCREENER and GENERAL roles. MANAGER does not get it.

**DRY_RUN mode (fixed):**
```
getMyPositions()     → on-chain API + mergeVirtualPositions() → returns VPs ✓
getStateSummary()    → routes to getVpStateSummary()          → returns VP data ✓
```

**VP equivalent:** `getVpStateSummary()` reads from `vp_state.json` and returns the same `StateSummary` shape.

---

## 2. OOR Detection

### Current Functions

| Purpose | Live (`core/live/state.ts`) | VP (`core/vp/state.ts`) |
|---------|----------------------------|--------------------------|
| Mark out of range | `markLiveOutOfRange(address)` | `markVpOutOfRange(activeBin, upperBin, oorSince)` |
| Mark in range | `markLiveInRange(address)` | `markVpInRange(activeBin, upperBin, oorSince)` |
| Minutes OOR | `minutesLiveOutOfRange(address)` | `minutesVpOutOfRange(oorSince)` |

### Unified Naming Convention

| Purpose | Live Before | Live After | VP Before | VP After |
|---------|-------------|------------|-----------|----------|
| Mark out of range | `markLiveOutOfRange` | `markLiveOutOfRange` (keep) | inline in `runVpManagementCycle` | `markVpOutOfRange` |
| Mark in range | `markLiveInRange` | `markLiveInRange` (keep) | inline in `runVpManagementCycle` | `markVpInRange` |
| Minutes OOR | `minutesLiveOutOfRange` | `minutesLiveOutOfRange` (keep) | `_oor_minutes` field | `minutesVpOutOfRange` |

### Implementation Difference

**Live** — Impure functions, load/save per call:
```typescript
export function markLiveOutOfRange(position_address: string): void {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  if (!pos.out_of_range_since) {
    pos.out_of_range_since = new Date().toISOString();
    save(state);
  }
}

export function markLiveInRange(position_address: string): void {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  if (pos.out_of_range_since) {
    pos.out_of_range_since = null;
    save(state);
  }
}

export function minutesLiveOutOfRange(position_address: string): number {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || !pos.out_of_range_since) return 0;
  return Math.floor((Date.now() - new Date(pos.out_of_range_since).getTime()) / 60000);
}
```

**VP** — Pure functions, no disk I/O. Return `{ oorSince, changed }` for caller to batch-write:
```typescript
export function markVpOutOfRange(
  activeBin: number, upperBin: number | null, currentOorSince: string | null,
): { oorSince: string | null; changed: boolean } {
  if (activeBin <= upperBin) return { oorSince: null, changed: currentOorSince !== null };
  if (currentOorSince) return { oorSince: currentOorSince, changed: false };
  return { oorSince: new Date().toISOString(), changed: true };
}

export function markVpInRange(
  activeBin: number, upperBin: number | null, currentOorSince: string | null,
): { oorSince: null; changed: boolean } {
  if (activeBin > upperBin) return { oorSince: null, changed: false };
  return { oorSince: null, changed: currentOorSince !== null };
}

export function minutesVpOutOfRange(oorSince: string | null): number {
  if (!oorSince) return 0;
  const oorTs = new Date(oorSince).getTime();
  if (!Number.isFinite(oorTs)) return 0;
  return Math.max(0, Math.floor((Date.now() - oorTs) / 60000));
}
```

**Same concept, same names, different prefix.** Live is impure (load/save per call). VP is pure (one load/save per cycle in caller).

---

## 3. PnL / Trailing TP / Peak Confirmation

### Current Functions

| Purpose | Live (`core/live/state.ts`) | VP (`core/vp/state.ts`) |
|---------|----------------------------|--------------------------|
| Update PnL + evaluate exits | `updateLivePnlAndCheckExits()` | `updateVpPnlAndCheckExits()` |
| Queue peak for confirmation | `queueLivePeakConfirmation()` | `queueVpPeakConfirmation()` |
| Resolve pending peak | `resolveLivePendingPeak()` | — |
| Queue trailing drop | `queueLiveTrailingDropConfirmation()` | `queueVpTrailingDropConfirmation()` |
| Resolve trailing drop | `resolveLivePendingTrailingDrop()` | — |

### Unified Naming Convention

| Purpose | Live Before | Live After | VP Before | VP After |
|---------|-------------|------------|-----------|----------|
| PnL + exits | `updateLivePnlAndCheckExits` | `updateLivePnlAndCheckExits` (keep) | `updateVpPnlAndCheckExits` | `updateVpPnlAndCheckExits` (keep) |
| Queue peak | `queueLivePeakConfirmation` | `queueLivePeakConfirmation` (keep) | `queueVpPeakConfirmation` | `queueVpPeakConfirmation` (keep) |
| Resolve peak | `resolveLivePendingPeak` | `resolveLivePendingPeak` (keep) | — | — |
| Queue trailing drop | `queueLiveTrailingDropConfirmation` | `queueLiveTrailingDropConfirmation` (keep) | `queueVpTrailingDropConfirmation` | `queueVpTrailingDropConfirmation` (keep) |
| Resolve trailing drop | `resolveLivePendingTrailingDrop` | `resolveLivePendingTrailingDrop` (keep) | — | — |

### Function Details

**Live:**
```
updateLivePnlAndCheckExits()
  Input:  position address, positionData (pnl, in_range, fee_per_tvl_24h), mgmtConfig
  Output: ExitResult | null (action, reason, needs_confirmation)
  Does:   Combines stop loss, trailing TP, OOR timeout, low yield into one evaluation
  Side effects: marks OOR in live_state.json

queueLivePeakConfirmation()
  Input:  position address, candidatePnlPct, { immediate? }
  Output: boolean (queued or not)
  Does:   Sets pending_peak_pnl_pct + pending_peak_started_at for 15s recheck

resolveLivePendingPeak()
  Input:  position address, currentPnlPct, toleranceRatio
  Output: { confirmed, pending?, peak?, rejected? }
  Does:   After 15s, confirms peak if still valid (within tolerance) or rejects

queueLiveTrailingDropConfirmation()
  Input:  position address, peakPnlPct, currentPnlPct, trailingDropPct
  Output: boolean
  Does:   Queues a trailing drop candidate for 15s confirmation

resolveLivePendingTrailingDrop()
  Input:  position address, currentPnlPct, trailingDropPct, tolerancePct
  Output: { confirmed, pending?, reason?, rejected? }
  Does:   After 15s, confirms drop if still valid or rejects
```

**VP (actual functions):**
```
updateVpPnlAndCheckExits()
  Input:  trailingActive, trailingPending, peakPnl, currentPnl, mgmtConfig
  Output: { trailingActive, trailingPending, trailingCloseReason }
  Does:   Combines trailing TP activation + drop detection into one evaluation
  Side effects: none (pure function, caller handles state update)

queueVpPeakConfirmation()
  Input:  trailingActive, peakPnl, triggerPct
  Output: { trailingActive: boolean }
  Does:   Checks if peak >= triggerPct, activates trailing TP if not already active

queueVpTrailingDropConfirmation()
  Input:  trailingPending, peakPnl, currentPnl, dropPct, minPnl
  Output: { trailingPending: boolean, closeReason: string | null }
  Does:   Computes drop from peak, generates close reason string, manages pending flag
```

### VP vs Live Trailing TP

| Aspect | Live | VP |
|--------|------|-----|
| Activation | `queueLivePeakConfirmation` | `queueVpPeakConfirmation` |
| Drop detection | `queueLiveTrailingDropConfirmation` | `queueVpTrailingDropConfirmation` |
| Confirmation | 2-phase (queue → 15s → resolve) | 1-phase (flag checked next cycle) |
| Resolve functions | 2 separate functions | not needed |

---

## 4. Claim

### Current Functions

| Purpose | Live (`core/live/state.ts`) | VP (`core/vp/state.ts`) |
|---------|----------------------------|--------------------------|
| Record fee claim | `recordLiveClaim(address, fees_usd)` | `recordVpClaim(id, fees_usd)` |
| Compute PnL | PnL from Meteora API in `getMyPositions()` | `computePositionPnl()` (shared) |

### Unified Naming Convention

| Purpose | Live Before | Live After | VP Before | VP After |
|---------|-------------|------------|-----------|----------|
| Record fee claim | `recordLiveClaim` | `recordLiveClaim` (keep) | `recordVpClaim` | `recordVpClaim` (keep) |
| Compute PnL | `computePositionPnl` (shared) | `computePositionPnl` (keep) | `computePositionPnl` (shared) | `computePositionPnl` (keep) |

### Function Details

```
recordLiveClaim()
  Input:  position address, fees_usd
  Output: void
  Does:   Records on-chain fee claim — sets last_claim_at, updates total_fees_claimed_usd, adds note
  State:  Writes to live_state.json

recordVpClaim()
  Input:  vp id, fees_usd
  Output: boolean
  Does:   Records virtual fee claim — sets last_claim_at, updates total_fees_claimed_usd, adds note
  State:  Writes to vp_state.json
  Note:   VP never claims on-chain, but tracks cumulative virtual claims for LLM visibility

computePositionPnl() (shared)
  Input:  position, bins, solPrice, options
  Output: PositionPnlResult { pnlPct, pnlUsd, unclaimedFeesUsd, feesUsd, ... }
  Does:   Computes PnL from bin data locally (VP has no on-chain position to query)
  Note:   Live gets PnL from Meteora API — no equivalent function needed
```

### VP New Fields Required

```typescript
// Add to VpPosition
last_claim_at: string | null;
total_fees_claimed_usd: number;
```

> [!NOTE]
> VP already has `recordVpClaim()` implemented in `core/vp/state.ts`.

---

## 5. Close

### Current Functions

| Purpose | Live (`core/state.ts`, `providers/meteora/dlmm.ts`) | VP (`core/vp/state.ts`, `core/vp/manage.ts`) |
|---------|-----------------------------------------------------|-----------------------------------------------|
| Mark closed in state | `recordLiveClose(address, reason)` | `recordVpClose(id, reason, pnlPct, pnlUsd)` |
| Full close (fresh PnL + state) | `closeLivePosition({ position_address, reason })` | `closeVpPosition(vpId, reason)` |
| LLM tool entry | `close_position` (routes by address prefix) | `close_position` (routes by address prefix) |

### Unified Naming Convention

| Purpose | Live Before | Live After | VP Before | VP After |
|---------|-------------|------------|-----------|----------|
| Mark closed in state | `recordLiveClose` | `recordLiveClose` (keep) | `recordVpClose` | `recordVpClose` (keep) |
| Full close | `closeLivePosition` | `closeLivePosition` (keep) | `closeVpPosition` | `closeVpPosition` (keep) |
| LLM tool entry | `close_position` | `close_position` (keep) | `close_position` | `close_position` (keep) |

### Function Details

```
recordLiveClose()
  Input:  position address, reason
  Output: void
  Does:   Marks live position closed — sets closed=true, closed_at=now(), adds note, pushes event
  State:  Writes to live_state.json

recordVpClose()
  Input:  vp id, reason, pnlPct, pnlUsd, extraFields?
  Output: boolean
  Does:   Marks VP closed — sets status="closed", closed_at=now(), close_reason, close_pnl_*
  State:  Writes to vp_state.json, archives to JSONL
  Note:   Takes PnL as input (caller computes it)

closeLivePosition()
  Input:  { position_address, reason }
  Output: { success, close_txs, claim_txs, pnl_usd, ... }
  Does:   Full on-chain close — fetches pool, sends close tx, claims fees, swaps to SOL
  State:  On-chain transaction + live_state.json update

closeVpPosition()
  Input:  vpId, reason
  Output: { success, pnl_pct, pnl_usd, ... }
  Does:   Full VP close — fetches fresh bins, computes PnL, calls recordVpClose(), archives
  State:  vp_state.json + JSONL archive
```

### Close Flow

```
close_position (shared LLM tool)
  │
  ├─ VP address (vp:xxx) → closeVpPosition()
  │   ├─ getBinsInRange()
  │   ├─ computeVpPnl()
  │   └─ recordVpClose() → archive to JSONL
  │
  └─ Live address → closeLivePosition()
      ├─ getPool()
      ├─ pool.closePosition() → on-chain tx
      ├─ recordLiveClose() → live_state.json
      └─ claimFees() + swapToken()
```

---

## 6. Archive / Sync / Paths

### Current Functions

| Purpose | Live (`core/live/state.ts`) | VP (`core/vp/state.ts`) |
|---------|----------------------------|--------------------------|
| Sync with source of truth | `syncLiveOpenPositions(active_addresses)` | `updateVpPosition()` / `recordVpClose()` (implicit) |
| Archive closed positions | — (no archive) | `archiveVpPositions()` |

### Unified Naming Convention

| Purpose | Live Before | Live After | VP Before | VP After |
|---------|-------------|------------|-----------|----------|
| Sync with source of truth | `syncLiveOpenPositions` | `syncLiveOpenPositions` (keep) | `updateVpPosition` / `recordVpClose` | `updateVpPosition` / `recordVpClose` (keep) |
| Archive closed positions | — | — | `archiveVpPositions` | `archiveVpPositions` (keep) |

### Function Details

```
syncLiveOpenPositions()
  Input:  active_addresses: string[]
  Output: void
  Does:   Reconciles live_state.json with on-chain reality
  Logic:  For each position in state: if NOT in active list AND past 5min grace → auto-close
  State:  Writes to live_state.json
  Called: After getMyPositions() in runLiveManagementCycle()

archiveVpPositions()
  Input:  none
  Output: { swept, failed, duplicatesRemoved }
  Does:   Moves closed VPs from vp_state.json to JSONL archive
  Logic:  For each closed VP → append to archive → splice from state
  State:  Writes to vp_state.json + JSONL files
  Called: After closeVpPosition() or during management cycle
```

### Sync Source Comparison

| System | Source of Truth | Sync Function | What It Does |
|--------|-----------------|---------------|--------------|
| Live | On-chain data | `syncLiveOpenPositions()` | Auto-closes positions missing from on-chain |
| VP | Local state | `updateVpPosition()` | Persists state changes to vp_state.json |

### State File Naming

| System | Before | After | Purpose |
|--------|--------|-------|---------|
| Live | `state.json` | `live_state.json` | Open + closed positions |
| VP | `dry-run-state.json` | `vp_state.json` | Open + closed VPs |

### Archive Record Format (`core/archive.ts`)

**File pattern:** `archives/{source}-archive-YYYY-MM.jsonl`
- `source = "paper"` → `vp-archive-YYYY-MM.jsonl`
- `source = "live"` → `live-archive-YYYY-MM.jsonl`

**One JSON object per line, append-only, O(1) write.**

```typescript
interface ArchiveRecord {
  source?: string;                    // "paper" | "live"
  id?: string | number;              // VP: "vp-YYYYMMDDTHHMMSSZ", Live: position pubkey
  pool?: string;                      // Pool address
  pool_name?: string;                 // e.g. "SOL/USDC"
  pair?: string;                      // Token pair
  base_mint?: string;                 // Base token mint
  strategy?: string;                  // LP strategy name
  lower_bin?: number;                 // Lower bin ID
  upper_bin?: number;                 // Upper bin ID
  active_bin_at_deploy?: number;      // Active bin at deploy
  bin_step?: number;                  // Bin step
  amount_sol?: number;                // SOL amount deployed
  initial_value_usd?: number;         // USD value at deploy
  sol_price_at_deploy?: number;       // SOL price at deploy
  deployed_at?: string;               // ISO timestamp
  closed_at?: string;                 // ISO timestamp
  minutes_held?: number;              // Auto-computed if missing
  minutes_in_range?: number;          // Time in range
  range_efficiency?: number;          // Range efficiency score
  close_reason?: string;              // Close trigger
  close_pnl_pct?: number;             // PnL percentage
  close_pnl_usd?: number;             // PnL in USD
  close_pnl_sol_pct?: number;         // PnL in SOL percentage
  close_pnl_sol?: number;             // PnL in SOL
  close_il_sol?: number;              // Impermanent loss (SOL)
  close_fees_sol?: number;            // Fees earned (SOL)
  close_cost_sol?: number;            // Close transaction cost (SOL)
  close_il_usd?: number;              // Impermanent loss (USD)
  close_fees_usd?: number;            // Fees earned (USD)
  close_cost_usd?: number;            // Close transaction cost (USD)
  total_fees_earned_usd?: number;     // Cumulative fees (USD)
  volatility?: number;                // Volatility at deploy
  fee_tvl_ratio?: number;             // Fee/TVL ratio
  organic_score?: number;             // Organic score
  signal_snapshot?: unknown;          // Signal data at deploy
  bin_shares?: unknown;               // Per-bin LP shares
  tx_hashes?: unknown;                // Transaction hashes (Live only)
  relay?: unknown;                    // Relay info (Live only)
}
```

**Dedup:** `appendArchiveRecordIfNew()` checks `id` field before writing — no duplicates.

**Consumers:** `readArchive()` in `core/archive.ts` loads records for:
- `generateVpReport()` — HTML calendar
- `generateVpDigest()` — LLM prompt
- `getPerformanceHistory()` — CLI stats
- `getLessonsForPrompt()` — Live LLM context

---

## 7. Global Paths Config (`config/paths.ts`)

### Purpose

Centralize all file paths in one module. Change a path once, all modules follow. Lives in `config/` (not `core/`) because paths are static configuration, not business logic.

### Structure

```typescript
// config/paths.ts

const ROOT = process.env.MERIDIAN_ROOT || ".";

// ── State files ───────────────────────────────────────────────────────────
export const LIVE_STATE_FILE = `${ROOT}/live_state.json`;     // was ./state.json
export const VP_STATE_FILE   = `${ROOT}/vp_state.json`;      // was ./dry-run-state.json

// ── Data files ────────────────────────────────────────────────────────────
export const LESSONS_FILE         = `${ROOT}/lessons.json`;
export const POOL_MEMORY_FILE     = `${ROOT}/pool-memory.json`;
export const TOKEN_BLACKLIST_FILE = `${ROOT}/token-blacklist.json`;
export const DEV_BLOCKLIST_FILE   = `${ROOT}/dev-blocklist.json`;
export const STRATEGY_FILE        = `${ROOT}/strategy-library.json`;
export const SIGNAL_WEIGHTS_FILE  = `${ROOT}/signal-weights.json`;
export const USER_CONFIG_FILE     = `${ROOT}/user-config.json`;
export const DECISION_LOG_FILE    = `${ROOT}/decision-log.json`;
export const SMART_WALLETS_FILE   = `${ROOT}/smart-wallets.json`;

// ── Archive ───────────────────────────────────────────────────────────────
export const ARCHIVE_DIR = `${ROOT}/archives`;

export function archivePath(source: string, month: string): string {
  const prefix = source === "paper" ? "vp" : "live";
  return `${ARCHIVE_DIR}/${prefix}-archive-${month}.jsonl`;
}
```

### Files That Import From `config/paths.ts`

| File | Current Path Constant | Import From |
|------|----------------------|-------------|
| `core/state.ts` | `STATE_FILE = "./state.json"` | `LIVE_STATE_FILE` |
| `core/vp/state.ts` | `STATE_FILE = "./dry-run-state.json"` | `VP_STATE_FILE` |
| `core/briefing.ts` | `STATE_FILE = "./state.json"` | `LIVE_STATE_FILE` |
| `core/briefing.ts` | `LESSONS_FILE = "./lessons.json"` | `LESSONS_FILE` |
| `core/lessons.ts` | `LESSONS_FILE = "./lessons.json"` | `LESSONS_FILE` |
| `core/lessons.ts` | `USER_CONFIG_PATH = "./user-config.json"` | `USER_CONFIG_FILE` |
| `llm/tools/executor.ts` | `USER_CONFIG_PATH = "./user-config.json"` | `USER_CONFIG_FILE` |
| `core/decision-log.ts` | `DECISION_LOG_FILE = "./decision-log.json"` | `DECISION_LOG_FILE` |
| `core/pool-memory.ts` | `POOL_MEMORY_FILE = "./pool-memory.json"` | `POOL_MEMORY_FILE` |
| `core/token-blacklist.ts` | `BLACKLIST_FILE = "./token-blacklist.json"` | `TOKEN_BLACKLIST_FILE` |
| `core/strategy-library.ts` | `STRATEGY_FILE = "./strategy-library.json"` | `STRATEGY_FILE` |
| `core/signal-weights.ts` | `WEIGHTS_FILE = "./signal-weights.json"` | `SIGNAL_WEIGHTS_FILE` |
| `core/smart-wallets.ts` | — | `SMART_WALLETS_FILE` |
| `core/archive.ts` | `ARCHIVE_DIR = "./archives"` | `ARCHIVE_DIR`, `archivePath()` |
| `interfaces/telegram/index.ts` | — | `USER_CONFIG_FILE` |
| `cli.ts` | hardcoded `"./lessons.json"` | `LESSONS_FILE` |
| `index.ts` | hardcoded `"./lessons.json"` | `LESSONS_FILE` |
| `test/test-lessons.ts` | `LESSONS_FILE = "./lessons.json"` | `LESSONS_FILE` |
| `test/test-blacklist.ts` | `BLACKLIST_FILE = "./token-blacklist.json"` | `TOKEN_BLACKLIST_FILE` |
| `test/test-signal-weights.ts` | `WEIGHTS_FILE = "./signal-weights.json"` | `SIGNAL_WEIGHTS_FILE` |

### Migration Steps

1. ✅ **Create `config/paths.ts`** with all path constants
2. ✅ **Rename files on disk:**
   - `state.json` → `live_state.json`
   - `dry-run-state.json` → `vp_state.json`
3. ✅ **Delete `core/paths.ts`** — moved to `config/paths.ts`
4. ✅ **Update imports** in all files listed above
5. ✅ **Remove local path constants** (e.g., `const STATE_FILE = "./state.json"`)
6. ✅ **Verify** no hardcoded paths remain

### Benefits

- **Single source of truth** for all file paths
- **Easy rename** — change once in `config/paths.ts`, all modules follow
- **Environment override** — `MERIDIAN_ROOT` env var for testing/deployment
- **No hardcoded paths** — grep finds nothing, refactor is safe
- **Correct semantics** — paths are configuration, lives in `config/` alongside `config/index.ts`

---

## 8. Management Cycle

### Current Functions

| Purpose | Live (`core/live/manage.ts`) | VP (`core/vp/manage.ts`) | Shared (`core/screen.ts`) |
|---------|------------------------------|--------------------------|---------------------------|
| Full management cycle | `runLiveManagementCycle({ silent? }, deps)` | `runVpManagementCycle()` | — |
| Full screening cycle | — | — | `runScreeningCycle({ silent? })` |
| Fire screening with guards | — | — | `tryStartScreening(source, silent?)` |
| Evaluate lone candidate | — | — | `getLoneCandidateSkipReason({ pool, sw, n, ti })` |

### Unified Naming Convention

| Purpose | Live Before | Live After | VP Before | VP After |
|---------|-------------|------------|-----------|----------|
| Full management cycle | `runLiveManagementCycle` | `runLiveManagementCycle` (keep) | `runVpManagementCycle` | `runVpManagementCycle` (keep) |
| Full screening cycle | — | — | — | — |
| Fire screening with guards | — | — | — | — |
| Evaluate lone candidate | — | — | — | — |

> **Note:** Screening is shared (`core/screen.ts`). `runScreeningCycle`, `tryStartScreening`, `getLoneCandidateSkipReason` have no Live/VP prefix — they're shared functions.

### Function Details

```
runLiveManagementCycle()
  Input:  { silent?: boolean }, deps: ManageDeps
  Output: string | null (management report)
  Does:   Full live management — fetch positions, evaluate rules, invoke LLM, run VP cycle if DRY_RUN
  State:  Writes to live_state.json
  Called: Cron job every managementIntervalMin

runVpManagementCycle()
  Input:  none
  Output: VpResult[] (results per VP)
  Does:   Full VP management — fetch bins, compute PnL, apply close rules, auto-close
  State:  Writes to vp_state.json
  Called: Inside runLiveManagementCycle() when DRY_RUN=true

runScreeningCycle()
  Input:  { silent?: boolean }
  Output: string | null (screening report)
  Does:   Full screening — fetch candidates, apply filters, invoke LLM SCREENER for deploy
  State:  May trigger deploy_position tool
  Called: Cron job every screeningIntervalMin or triggered by management

tryStartScreening()
  Input:  source: string, silent?: boolean
  Output: boolean (started or not)
  Does:   Fire screening cycle if not busy and cooldown elapsed
  Called: After management cycle if positions < maxPositions

getLoneCandidateSkipReason()
  Input:  { pool, sw, n, ti }
  Output: string | null (skip reason)
  Does:   Determine if a lone surviving candidate should be skipped
  Called: During screening cycle evaluation
```

---

## 9. Screening

| Purpose | Location |
|---------|----------|
| Evaluate lone candidate | `core/screen.ts` — `getLoneCandidateSkipReason({ pool, sw, n, ti })` |
| Fire screening with guards | `core/screen.ts` — `tryStartScreening(source, silent?)` |
| Full screening cycle | `core/screen.ts` — `runScreeningCycle({ silent? })` |

**Note:** Screening is shared by both Live and VP. VPs are created by `deploy_position` tool when `DRY_RUN=true`.

---

## 10. Display / Merge

### Current Functions

| Purpose | Live | VP (`core/vp/merge.ts`, `core/vp/state.ts`) |
|---------|------|----------------------------------------------|
| Merge VPs into unified view | — | `mergeVpPositions(positions, vps, solPrice, now, freshPnlMap)` |
| Parse VP address | — | `parseVirtualPositionAddress(positionAddress)` |

### Unified Naming Convention

| Purpose | Live Before | Live After | VP Before | VP After |
|---------|-------------|------------|-----------|----------|
| Merge VPs into unified view | — | — | `mergeVirtualPositions` | `mergeVpPositions` |
| Parse VP address | — | — | `parseVirtualPositionAddress` | `parseVirtualPositionAddress` (keep) |

---

## 11. Report / Digest / Briefing

### Current Functions

| Purpose | Live | VP |
|---------|------|-----|
| Daily Telegram briefing | `generateBriefing()` (`core/briefing.ts`) | — |
| Performance stats summary | `getPerformanceSummary()` (`core/lessons.ts`) | — |
| LLM prompt injection | `getLessonsForPrompt({ agentType })` (`core/lessons.ts`) | `generateVpDigest()` (`core/vp/digest.ts`) |
| HTML calendar report | — | `generateVpReport()` (`core/vp/report.ts`) |

### What Each System Uses

**Live:**
- `generateBriefing()` → Telegram `/briefing` command — daily text summary of positions, PnL, lessons
- `getPerformanceSummary()` → stats object (total PnL, win rate, avg return, lessons count)
- `getLessonsForPrompt()` → injects learned rules into LLM system prompt — evolved thresholds, patterns
- No HTML report — Meteora's UI shows live positions visually

**VP:**
- `generateVpDigest()` → compact text for LLM SCREENER prompt — win rate by volatility bucket, toxic pools, close reasons
- `generateVpReport()` → standalone HTML calendar — interactive day cells, modal details, month navigation
- No Telegram briefing — VP is paper trading, less user-facing

### Why the Asymmetry

| Aspect | Live | VP |
|--------|------|-----|
| Position visibility | Meteora UI (external) | Custom HTML report (self-contained) |
| LLM context | `getLessonsForPrompt()` — evolved rules + thresholds | `generateVpDigest()` — simple stats + patterns |
| User notifications | `generateBriefing()` — Telegram daily | None |
| Evolution | `lessons.ts` adjusts config thresholds | No evolution (static thresholds) |

**Live doesn't need VP's HTML report** because Meteora shows positions. **VP doesn't need Live's briefing** because it's paper trading.

### Unified Naming Convention

| Purpose | Live Before | Live After | VP Before | VP After |
|---------|-------------|------------|-----------|----------|
| Daily Telegram briefing | `generateBriefing` | `generateBriefing` (keep) | — | — |
| Performance stats summary | `getPerformanceSummary` | `getPerformanceSummary` (keep) | — | — |
| LLM prompt injection | `getLessonsForPrompt` | `getLessonsForPrompt` (keep) | `generateVirtualDigest` | `generateVpDigest` |
| HTML calendar report | — | — | `generateDryRunReport` | `generateVpReport` |

### Gap: No Live HTML Report

Live has no self-contained HTML calendar. If needed, a `generateLiveReport()` could read from `live-archive-*.jsonl` — same pattern as VP's `generateVpReport()`.

---

## 12. Instructions / Briefing Date

### Current Functions

| Purpose | Live (`core/state.ts`) | VP (`core/vp/state.ts`) |
|---------|------------------------|--------------------------|
| Set position instruction | `setPositionInstruction(address, instruction)` | — (hardcoded `instruction: null`) |
| Get/set briefing date | `getLastBriefingDate()`, `setLastBriefingDate()` | — |

### What They Do

**`setPositionInstruction(address, instruction)`**
- Sets `pos.instruction` on a position — free-text directive for the LLM
- Used by LLM tool `set_position_instruction` — LLM tells itself "hold until 50%", "close if drops below -10%"
- Used by Telegram `/set <n> <note>` command — user sets instruction manually
- Injected into LLM prompt when managing that position

**`getLastBriefingDate()` / `setLastBriefingDate()`**
- Tracks when the last Telegram briefing was sent
- Prevents duplicate briefings in the same day
- Stored in `live_state.json` as `_lastBriefingDate`

### Why VP Currently Doesn't Have Them

| Function | VP Gap Reason |
|----------|---------------|
| `setPositionInstruction` | VP management is deterministic (close rules), not LLM-driven — instructions meaningless |
| Briefing date | VP has no Telegram briefing — paper trading, less user-facing |

### Unified Naming Convention

| Purpose | Live Before | Live After | VP Before | VP After |
|---------|-------------|------------|-----------|----------|
| Set position instruction | `setPositionInstruction` | `setPositionInstruction` (keep) | — | — |
| Get briefing date | `getLastBriefingDate` | `getLastBriefingDate` (keep) | — | — |
| Set briefing date | `setLastBriefingDate` | `setLastBriefingDate` (keep) | — | — |

> [!NOTE]
> `getLastBriefingDate` and `setLastBriefingDate` only read/write `live_state.json`. VP has no briefing date tracking.

### Implementation: VP Support

**`setPositionInstruction`** — VP needs:
- Add `instruction?: string | null` field to `VpPosition` interface
- Remove hardcoded `instruction: null` from `merge.ts`
- Add `setPositionInstruction()` to `core/vp/state.ts` — same pattern as Live
- Update `close_position` tool routing to support VP instructions
- Update merge to pass through VP instructions

**Briefing date** — VP needs:
- Add `_lastBriefingDate?: string` to `VpState` interface
- Add `getLastBriefingDate()` / `setLastBriefingDate()` to `core/vp/state.ts`
- Use in VP briefing (if added) or share with Live via `getMyPositions()` merge

### Gap: VP Has No Briefing

VP doesn't have a Telegram briefing. If added, `generateVpBriefing()` would:
- Read from `vp_state.json` + `vp-archive-*.jsonl`
- Send daily summary of paper trading performance
- Use `getLastBriefingDate()` to prevent duplicates

---

## State Shape Comparison

### Live Position (`live_state.json`)

```
position_address: string (Solana pubkey)
pool, pool_name, strategy
bin_range: { lower, upper }
active_bin, bin_step
amount_sol, amount_x, initial_value_usd
volatility, fee_tvl_ratio, organic_score
deployed_at, closed_at?, close_reason?
oor_since?, oor_minutes?
peak_pnl_pct?, trailing_active?, trailing_pending?
claims: [{ timestamp, fees_usd }]
instruction?, signal_snapshot?
```

### VP Position (`vp_state.json`)

```
id: string (vp-YYYYMMDDTHHMMSSZ)
pool, pool_name, pair, strategy
bins_below, lower_bin, upper_bin
active_bin, bin_step
amount_sol, initial_value_usd
sol_price_at_deploy
base_mint, bin_shares: [{ bin, share }]
volatility, fee_tvl_ratio, organic_score
deploy_gas_sol, close_gas_sol
deployed_at, closed_at?, close_reason?
pnl_pct?, pnl_usd?
_trailing_active?, _trailing_pending?, _trailing_pending_since?
_oor_minutes?
signal_snapshot?
```

---

## TypeScript Types

### Live — `TrackedPosition` (`core/live/state.ts`)

```typescript
interface TrackedPosition {
  position: string;                    // Solana pubkey
  pool: string;
  pool_name?: string;
  strategy?: string;
  bin_range?: Record<string, unknown>; // { lower, upper }
  amount_sol?: number;
  amount_x?: number;
  active_bin_at_deploy?: number;
  bin_step?: number;
  volatility?: number;
  fee_tvl_ratio?: number;
  initial_fee_tvl_24h?: number;
  organic_score?: number;
  initial_value_usd?: number;
  signal_snapshot?: unknown;
  deployed_at: string;
  out_of_range_since: string | null;
  last_claim_at: string | null;
  total_fees_claimed_usd: number;
  rebalance_count: number;
  closed: boolean;
  closed_at: string | null;
  notes: string[];
  peak_pnl_pct: number;
  pending_peak_pnl_pct: number | null;
  pending_peak_started_at: string | null;
  pending_trailing_current_pnl_pct: number | null;
  pending_trailing_peak_pnl_pct: number | null;
  pending_trailing_drop_pct: number | null;
  pending_trailing_started_at: string | null;
  confirmed_trailing_exit_reason: string | null;
  confirmed_trailing_exit_until: string | null;
  trailing_active: boolean;
  instruction?: string | null;
  [key: string]: unknown;
}
```

### Live — `AgentState` (`core/live/state.ts`)

```typescript
interface AgentState {
  positions: Record<string, TrackedPosition>;  // keyed by position address
  recentEvents?: RecentEvent[];
  lastUpdated: string | null;
  _lastBriefingDate?: string;
}
```

### Live — `ExitResult` (`core/live/state.ts`)

```typescript
interface ExitResult {
  action: string;
  reason: string;
  confirmed_recheck?: boolean;
  needs_confirmation?: boolean;
  peak_pnl_pct?: number;
  current_pnl_pct?: number;
  drop_from_peak_pct?: number;
}
```

### Live — `ManageDeps` (`core/live/manage.ts`)

```typescript
export interface ManageDeps {
  shouldUsePnlRecheck: () => boolean;
  schedulePeakConfirmation: (addr: string) => void;
  scheduleTrailingDropConfirmation: (addr: string) => void;
  tryStartScreening: (source: string, silent?: boolean) => boolean;
}
```

---

### VP — `VpPosition` (`types/index.ts`)

```typescript
export interface VpPosition {
  id: string;                           // vp-YYYYMMDDTHHMMSSZ
  pool: string;
  pool_name?: string | null;
  pair?: string | null;
  status: "open" | "closed";
  deployed_at: string | null;
  closed_at: string | null;
  strategy?: string;
  bins_below?: number;
  lower_bin?: number;
  upper_bin?: number;
  active_bin_at_deploy?: number;
  bin_step?: number;
  amount_sol?: number;
  initial_value_usd?: number | null;
  sol_price_at_deploy?: number | null;
  bin_shares?: any[] | null;            // BinShareEntry[]
  base_mint?: string | null;
  volatility?: number | null;
  fee_tvl_ratio?: unknown;
  organic_score?: unknown;
  signal_snapshot?: Record<string, unknown> | null;
  deploy_gas_sol?: number | null;
  close_gas_sol?: number | null;
  gas_priority_fee?: number | null;
  gas_cost_sol?: number | null;
  last_sync_at?: string | null;
  _oor_since?: string | null;
  _oor_minutes?: number;
  _peak_pnl_pct?: number;
  _peak_pnl_sol_pct?: number;
  _trailing_active?: boolean;
  _trailing_pending?: boolean;
  _trailing_pending_since?: string | null;
  snapshots?: Array<Record<string, unknown>>;
  close_reason?: string | null;
  close_pnl_usd?: number | null;
  close_pnl_pct?: number | null;
  close_fees_usd?: number | null;
  [key: string]: any;
}
```

### VP — `VpState` (`core/vp/state.ts`)

```typescript
export interface VpState {
  virtual_positions: VpPosition[];
  lastUpdated?: string;
}
```

### VP — `BinShareEntry` (`core/vp/state.ts`)

```typescript
/** Per-bin LP position at deploy time. All numeric fields stored as BN strings for JSON safety. */
export interface BinShareEntry {
  binId: number;
  shares: string;
  price: string | null;
  feeXPerTokenComplete: string | null;
  feeYPerTokenComplete: string | null;
  xAmount: string | null;
  yAmount: string | null;
}
```

### VP — `TrackVpPositionParams` (`core/vp/state.ts`)

```typescript
export interface TrackVpPositionParams {
  pool: string;
  pool_name?: string | null;
  pair?: string;
  strategy?: string;
  bins_below: number;
  lower_bin: number;
  upper_bin: number;
  active_bin: number;
  bin_step: number;
  amount_sol: number;
  initial_value_usd: number;
  sol_price_at_deploy?: number | null;
  bin_shares?: BinShareEntry[];
  base_mint?: string | null;
  signal_snapshot?: Record<string, unknown> | null;
  volatility?: number | null;
  fee_tvl_ratio?: unknown;
  organic_score?: unknown;
  deploy_gas_sol?: number | null;
  close_gas_sol?: number | null;
  gas_priority_fee?: number | null;
  gas_cost_sol?: number | null;
}
```

---

### Merge — `VpMergedPosition` (`core/vp/merge.ts`)

```typescript
export interface VpMergedPosition {
  position: string;
  pool: string;
  pair: string;
  base_mint: string | null;
  lower_bin: number | null;
  upper_bin: number | null;
  active_bin: number | null;
  in_range: boolean | null;
  unclaimed_fees_usd: number | null;
  total_value_usd: number | null;
  pnl_usd: number | null;
  pnl_pct: number | null;
  age_minutes: number | null;
  instruction: string | null;
  source: string;                       // "live" or "vp"
  [key: string]: unknown;
}
```

### Merge — `VpMergeFreshPnl` (`core/vp/merge.ts`)

```typescript
export interface VpMergeFreshPnl {
  pnl?: {
    currentValueUsd: number;
    pnlUsd: number;
    pnlPct: number;
    unclaimedFeesSol: number;
    unclaimedFeesUsd: number;
    positionValueSol: number;
    netPnlSol: number;
    pnlSolPct: number;
  };
  activeBinId?: number;
}
```

### Merge — `VirtualPosition` (`types/index.ts`)

```typescript
export interface VirtualPosition {
  id: string;
  pool: string;
  pair?: string;
  pool_name?: string;
  base_mint?: string;
  lower_bin?: number;
  upper_bin?: number;
  deployed_at?: string;
  [key: string]: unknown;
}
```

---

### Type Field Mapping (Live ↔ VP)

| Concept | Live field | VP field |
|---------|-----------|----------|
| ID | `position` (pubkey) | `id` (vp-timestamp) |
| Pool | `pool` | `pool` |
| Pool name | `pool_name` | `pool_name` |
| Strategy | `strategy` | `strategy` |
| Bin range | `bin_range.lower` / `bin_range.upper` | `lower_bin` / `upper_bin` |
| Active bin at deploy | `active_bin_at_deploy` | `active_bin_at_deploy` |
| Bin step | `bin_step` | `bin_step` |
| SOL amount | `amount_sol` | `amount_sol` |
| USD value | `initial_value_usd` | `initial_value_usd` |
| Volatility | `volatility` | `volatility` |
| Fee/TVL ratio | `fee_tvl_ratio` | `fee_tvl_ratio` |
| Organic score | `organic_score` | `organic_score` |
| Deploy time | `deployed_at` | `deployed_at` |
| Close time | `closed_at` | `closed_at` |
| Close reason | `closed_at` + reason in event | `close_reason` |
| OOR since | `out_of_range_since` | `_oor_since` |
| OOR minutes | computed from `out_of_range_since` | `_oor_minutes` |
| Peak PnL | `peak_pnl_pct` | `_peak_pnl_pct` |
| Trailing active | `trailing_active` | `_trailing_active` |
| Trailing pending | `pending_peak_pnl_pct` | `_trailing_pending` + `_trailing_pending_since` |
| Signal snapshot | `signal_snapshot` | `signal_snapshot` |
| Notes | `notes[]` | — |
| Instruction | `instruction` | — |
| Claims | `last_claim_at`, `total_fees_claimed_usd` | — (computed in-memory) |
| SOL price | — | `sol_price_at_deploy` |
| Bin shares | — | `bin_shares[]` |
| Base mint | — | `base_mint` |
| Deploy gas | — | `deploy_gas_sol` |
| Close gas | — | `close_gas_sol` |
| Close PnL | — | `close_pnl_pct`, `close_pnl_usd`, `close_fees_usd` |

---

## Lifecycle Comparison

```
LIVE                              VP
────                              ──
Screening                         Screening (same pipeline)
  │                                   │
  ▼                                   ▼
deploy_position ───────────────► deploy_position (DRY_RUN=true)
  │                                   │
  ▼                                   ▼
trackLivePosition()              trackVpPosition()
  │                                   │
  ▼                                   ▼
runLiveManagementCycle()             runVpManagementCycle()
  │  ├─ fetch on-chain PnL        │  ├─ computePositionPnl()
  │  ├─ updateLivePnlAndCheckExits│  ├─ updateVpPnlAndCheckExits()
  │  ├─ markLiveOutOfRange()      │  ├─ queueVpPeakConfirmation()
  │  ├─ queueLivePeak...()        │  └─ recordVpClose()
  │  └─ LLM actions               │
  ▼                                   ▼
close_position (LLM tool)        closeVpPosition()
  │                                   │
  ▼                                   ▼
recordLiveClose()                recordVpClose()
  │                                   │
  ▼                                   ▼
recordPerformance()              (no learning trigger)
  │                                   │
  ▼                                   ▼
archive to JSONL                 archive to JSONL
```

---

## Export Count Summary

### Before Migration

| File | Functions | Interfaces | Notes |
|------|-----------|------------|-------|
| `core/state.ts` (Live) | 18 | 0 | Live state — tracks bin ranges, OOR, trailing TP, claims |
| `core/vp/state.ts` (VP) | 7 | 3 | VP state — tracks virtual positions, archive |
| `core/live/manage.ts` (Live) | 1 | 1 | `runLiveManagementCycle` + `ManageDeps` |
| `core/vp/manage.ts` (VP) | 2 | 0 | `runVirtualManagementCycle` + `closeVpManual` |
| `core/vp/merge.ts` (VP) | 1 | 2 | `mergeVirtualPositions` + types |
| `core/live/screen.ts` (Live) | 3 | 0 | Screening — shared by VP (no VP screen.ts) |
| `core/vp/report.ts` (VP) | 1 | 1 | HTML calendar report |
| `core/vp/digest.ts` (VP) | 1 | 0 | LLM prompt digest |
| **Total Live** | **22** | **1** | |
| **Total VP** | **13** | **6** | |

### After Migration (Current State)

| File | Functions | Interfaces | Notes |
|------|-----------|------------|-------|
| `core/state.ts` (Dispatcher) | 7 | 0 | Routes to live/ or vp/ + shared functions |
| `core/live/state.ts` (Live) | 16 | 1 | Live state — tracks bin ranges, OOR, trailing TP, claims |
| `core/vp/state.ts` (VP) | 8 | 3 | VP state — tracks virtual positions, archive |
| `core/live/manage.ts` (Live) | 1 | 1 | `runLiveManagementCycle` + `ManageDeps` |
| `core/vp/manage.ts` (VP) | 5 | 0 | `runVpManagementCycle` + `closeVpPosition` + trailing TP functions |
| `core/vp/merge.ts` (VP) | 1 | 2 | `mergeVpPositions` + types |
| `core/screen.ts` (Shared) | 3 | 0 | Screening — shared by Live + VP |
| `core/cycle-state.ts` (Shared) | 5 | 0 | Screening cycle state (busy flags, cooldown) |
| `core/live/cycle-state.ts` (Live) | 6 | 0 | Live-specific timers (trailing TP, peak confirmation) |
| `core/vp/report.ts` (VP) | 1 | 1 | `generateVpReport` |
| `core/vp/digest.ts` (VP) | 1 | 0 | `generateVpDigest` |
| **Total Live** | **25** | **2** | |
| **Total VP** | **15** | **6** | |
| **Total Shared** | **16** | **0** | |

### Asymmetry Notes

**Live state is in `core/live/state.ts`** — after migration, `core/state.ts` is the dispatcher and `core/live/state.ts` holds the actual Live state functions.

**Screening is shared, not Live-specific** — `core/screen.ts` is used by both Live and VP. When `DRY_RUN=true`, `deploy_position` creates VPs instead of on-chain positions. No separate VP screening logic needed.

**Live trailing TP timers are in `core/live/cycle-state.ts`** — separate from `core/cycle-state.ts` which handles screening cycle state.
