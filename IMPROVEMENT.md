# Meridian — Improvement Suggestions

> Compiled after the JS→TS migration review (2026-06-10).
> Ordered by impact: **High** → **Medium** → **Low / Nice-to-Have**.
> ✅ = already implemented (confirmed by code review).

---

## 🔴 High Impact

### 1. `Position` interface is redefined in 3 places

`core/live/manage.ts`, `index.ts`, and `types/index.ts` each define their own `Position` interface with subtly different shapes. The one in `types/index.ts` is the weakest (uses camelCase, few optional fields) while the operational ones in `manage.ts`/`index.ts` are richer.

**Fix:** Promote the richer `Position` interface from `core/live/manage.ts` into `types/index.ts` and have all modules import from there. Remove local redefinitions.

```ts
// types/index.ts — add the operational Position shape
export interface LivePosition {
  position: string;
  pool: string;
  pair: string;
  pnl_pct: number | null;
  pnl_pct_suspicious?: boolean;
  unclaimed_fees_usd: number;
  total_value_usd: number;
  fee_per_tvl_24h: number | null;
  lower_bin: number;
  upper_bin: number;
  active_bin: number | null;
  minutes_out_of_range: number;
  in_range: boolean | null;
  age_minutes: number | null;
  instruction?: string;
  pnl_usd?: number;
  recall?: string;
  [key: string]: unknown;
}
```

---

### 2. `core/state.ts` does a full JSON read+write on every operation

Every call to `trackPosition`, `recordClaim`, `setPositionInstruction`, `queuePeakConfirmation`, etc. calls `load()` and `save()` independently. For the PnL poller (30s interval, N positions), this means N×2 disk I/O per cycle even when nothing changed.

**Fix:** Introduce a simple in-memory cache with dirty-flag write-back:

```ts
let _stateCache: AgentState | null = null;
let _stateDirty = false;

function load(): AgentState {
  if (_stateCache) return _stateCache;
  _stateCache = /* fs.readFileSync... */;
  return _stateCache;
}

function save(state: AgentState): void {
  _stateCache = state;
  state.lastUpdated = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
```

This halves disk I/O for the hot path and reduces latency in the PnL poller.

---

### 3. Test coverage gap — core state machine is untested

`tests/` has 6 test files covering `close-rules`, `deploy-amount`, `bins-below`, `candidate-guard`, and tool executor safety. The most complex stateful logic is **not tested**:

- `core/state.ts` — `queuePeakConfirmation`, `resolvePendingPeak`, `queueTrailingDropConfirmation`, `resolvePendingTrailingDrop`, trailing TP state machine
- `core/lessons.ts` — `derivLesson` outcome categories, `evolveThresholds` nudge/clamp logic
- `core/vp/manage.ts` — `buildPosForRule`, trailing TP for VPs, `runVirtualManagementCycle` result shape

**Fix:** Add a `tests/state-machine.test.ts` and `tests/lessons-evolve.test.ts` covering the above. These are pure functions with no I/O — easy to unit test with a mocked state file.

---

### 4. `VPResult` / `VpCycleResult` are duplicate interfaces

`core/live/manage.ts` defines `VPResult` and `core/vp/manage.ts` defines `VpCycleResult` — they overlap heavily. Neither is exported from `types/index.ts`.

**Fix:** Consolidate into one `VpResult` in `types/index.ts` and import from there. This also makes the result shape usable in `index.ts` without re-typing.

---

## 🟡 Medium Impact

### 5. `process.env.DRY_RUN === "true"` scattered everywhere

There are 10+ inline `process.env.DRY_RUN === "true"` checks across `core/live/manage.ts`, `core/vp/manage.ts`, `index.ts`, etc. If the mode detection logic ever changes (e.g., adding a `PAPER` mode), each must be updated.

**Fix:** Centralize in `config/index.ts` as a typed constant:

```ts
// config/index.ts
export const isDryRun: boolean = process.env.DRY_RUN === "true";
export const isLive: boolean = !isDryRun;
```

Then import `isDryRun` everywhere instead of reading `process.env` directly.

---

### 6. `manage.ts` fetches positions twice at the end of a management cycle

At the end of `runLiveManagementCycle` (line ~310), there is a second `getMyPositions({ force: true })` call just to count positions and decide whether to trigger screening. This is an extra RPC call after the LLM has already acted.

**Fix:** Track the count from the actionMap results instead:

```ts
// After LLM executes — count closures from tool results, no second fetch needed
const closedCount = [...actionMap.values()].filter(a => a.action === "CLOSE").length;
const estimatedAfterCount = livePositionData.length - closedCount;
if (estimatedAfterCount < config.risk.maxPositions) {
  deps.tryStartScreening("mgmt-post-management");
}
```

This removes one RPC call per management cycle with positions.

---

### 7. `VpSnapshot` array grows unbounded per VP until 100 entries then splices

`core/vp/manage.ts` keeps up to 100 snapshots per VP in the JSONL state. With many VPs and frequent cycles this inflates `dry-run-state.json`. The 100 cap is enforced but requires reading all 100 every cycle to check.

**Fix:** Store snapshots in a separate rolling JSONL file per VP (like archives) and only keep the last 5 in-state for display. This keeps state.json lean and makes archive reads opt-in.

---

### 8. `loadJsonRecord` / `saveJsonRecord` in `config/index.ts` are not used by `core/state.ts`

`core/state.ts` has its own `load()` / `save()` functions using raw `fs.readFileSync`/`writeFileSync`, while `config/index.ts` exports the shared `loadJsonRecord`/`saveJsonRecord` helpers. The patterns are parallel but not unified.

**Fix:** Refactor `core/state.ts`, `core/pool-memory.ts`, and `core/lessons.ts` to use `loadJsonRecord`/`saveJsonRecord` from `config/index.ts`, so all JSON persistence goes through one tested codepath.

---

### 9. Telegram queue drops messages silently if queue is full

In `index.ts` (~L873), when the Telegram queue is full (≥5 messages) a "Queue is full" reply is sent but the message is discarded. This can silently lose `/close` or `/set` commands sent while the agent is busy.

**Fix:** Persist the queue in memory with a max age (e.g., 10 minutes). Log dropped messages with their content so they appear in `meridian-log.txt` and can be replayed if needed.

---

### 10. `evolveThresholds` only evolves 2 thresholds (`minFeeActiveTvlRatio`, `minOrganic`)

Darwin's `evolveThresholds` in `core/lessons.ts` only touches 2 of the ~20 screening thresholds. Other good candidates for auto-evolution based on performance data:

- `minBinStep` / `maxBinStep` — if certain bin steps consistently OOR
- `maxBundlePct` — if bundled launches consistently fail
- `maxTop10Pct` — if concentrated tokens consistently underperform

**Fix:** Extend `evolveThresholds` with 2-3 more threshold targets, guarded by the same `MAX_CHANGE_PER_STEP` and `minSamples` constraints already in place.

---

## 🟢 Low / Nice-to-Have

### 11. `ManageDeps` could have a `createDefault()` factory

`ManageDeps` has no defaults, making it impossible to call `runLiveManagementCycle` in tests without mocking all four functions.

**Fix:**

```ts
// core/live/manage.ts
export function createManageDeps(overrides: Partial<ManageDeps> = {}): ManageDeps {
  return {
    shouldUsePnlRecheck: () => true,
    schedulePeakConfirmation: () => {},
    scheduleTrailingDropConfirmation: () => {},
    tryStartScreening: () => false,
    ...overrides,
  };
}
```

---

### 12. `formatCountdown` / `formatWalletStatus` / `renderSettingsMenu` are all in `index.ts`

`index.ts` is still 1555 lines. The REPL/Telegram handler, settings menu renderer, and display formatters could move to a `ui/` or `cli/` module to keep `index.ts` as a pure wiring file.

**Suggested split:**
```
index.ts           → startup, cron wiring, signal handlers only
cli/repl.ts        → REPL input loop
cli/telegram-cmds.ts → all Telegram command handlers  
cli/formatters.ts  → formatWalletStatus, formatCandidates, formatConfigSnapshot
cli/settings-menu.ts → renderSettingsMenu, applySettingsMenuCallback
```

---

### 13. `PoolMemoryEntry.volatility_at_deploy` is defined in `types/index.ts` but `core/vp/manage.ts` passes `volatility: undefined`

In `recordVpDeployToPoolMemory` (line 172), `volatility: undefined` is explicitly passed. The `PoolDeploy` type has `volatility_at_deploy` but the VP close path never populates it — the VP state doesn't store volatility at deploy time.

**Fix:** Store `volatility` at VP deploy time in `dry-run-state.json` (it's available during `deploy_position`) and pass it through on close.

---

### ~~14. `decision-log.ts` — decisions older than N days are never pruned~~ ✅ Already done

`core/decision-log.ts` line 47 already prunes to `MAX_DECISIONS = 100` on every `appendDecision` call:

```ts
data.decisions.unshift(decision);
data.decisions = data.decisions.slice(0, MAX_DECISIONS); // ✅ capped at 100
```

No action needed.

---

### 15. No structured error type — all errors are `catch (e: any)`

The codebase uses `catch (e: any)` everywhere and accesses `e.message` directly. This suppresses TypeScript's catch narrowing and can mask non-`Error` throws (e.g., string throws from some providers).

**Fix:** Add a small `toError` helper and use it consistently:

```ts
// utils/errors.ts
export function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}
```

Then replace `catch (e: any)` with `catch (e) { const err = toError(e); }`.

---

## Summary Table

| # | Area | Impact | Effort |
|---|------|--------|--------|
| 1 | Unified `Position` type | 🔴 High | Low |
| 2 | State cache / reduce disk I/O | 🔴 High | Medium |
| 3 | Test coverage — state machine & lessons | 🔴 High | High |
| 4 | Unified `VpResult` type | 🔴 High | Low |
| 5 | Centralize `DRY_RUN` flag | 🟡 Medium | Low |
| 6 | Remove second `getMyPositions` in manage cycle | 🟡 Medium | Low |
| 7 | VP snapshot storage | 🟡 Medium | Medium |
| 8 | Unify JSON persistence helpers | 🟡 Medium | Medium |
| 9 | Telegram queue persistence | 🟡 Medium | Medium |
| 10 | Extend `evolveThresholds` to more fields | 🟡 Medium | Medium |
| 11 | `ManageDeps.createDefault()` factory | 🟢 Low | Low |
| 12 | Split `index.ts` into `cli/` modules | 🟢 Low | High |
| 13 | Store VP volatility at deploy | 🟢 Low | Low |
| ~~**14**~~ | ~~Prune `decision-log.json`~~ | ✅ Already done (`MAX_DECISIONS = 100`) | — |
| 15 | Typed `catch` with `toError` helper | 🟢 Low | Medium |
