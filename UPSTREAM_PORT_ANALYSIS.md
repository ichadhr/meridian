# Upstream Port Analysis — main vs ts-structures

> **Date:** 2026-06-14
> **Upstream:** `origin/main` (10 commits, 8 non-merge + 2 merge)
> **Local:** `ts-structures` (ahead 9 commits)

---

## Executive Summary

| Category | Upstream | ts-structures | Gap |
|----------|----------|---------------|-----|
| RPC-based PnL engine | `tools/pnl.js` (272 lines) | None | **NEW** — needs full port |
| GMGN fee source | `tools/gmgn.js` (113 lines) | None | **NEW** — needs full port |
| HiveMind market push | `hivemind.js` (buildMarketFields) | None | **NEW** — needs port |
| OKX removal | `tools/okx.js` deleted, prompts cleaned | `providers/okx/` still active (42 refs) | **ts-structures落后** — OKX still integrated |
| screening-scales | `screening-scales.js` (34 lines) | None | **NEW** — needs port |
| repo-root helper | `repo-root.js` (11 lines) | `config/paths.ts` (partial) | **PARTIAL** — paths.ts has ROOT, not repoPath() |
| pnl_pct_suspicious fix | Based on input validity (price/deposits missing) | Based on pct-diff threshold (stale) | **BUGFIX** — needs overwrite |
| Close rule suspicious check | `if (position.pnl_pct_suspicious) return true` | Not in getCloseRule (only in live/state.ts) | **BUGFIX** — needs port |
| "relay poll" → "rpc poll" | Renamed | Still "relay poll" in `core/live/state.ts:264` | **TRIVIAL** — rename |
| pnl_tick + heartbeat | Throttled (every 20th tick) | None | **NEW** — part of RPC PnL |
| 15m timeframe drop | Removed | Already removed | **ALREADY DONE** |
| setup overhaul | Major rewrite (+366/-52) | `setup.ts` exists (511 lines) | **NEEDS REVIEW** — compare diff |

---

## Commit-by-Commit Analysis

### 1. `78c0934` — entry/exit learning, HiveMind market push, OKX removal, setup overhaul

**Upstream changes (30 files, +1075 / -805):**

| Sub-change | Upstream state | ts-structures state | Action needed |
|------------|---------------|---------------------|---------------|
| **repo-root.js** | `repoPath()` helper replaces scattered `__dirname` | `config/paths.ts` has `ROOT = process.env.MERIDIAN_ROOT \|\| "."` — partial, no repoPath() | Port `repoPath()` or adapt paths.ts |
| **screening-scales.js** | Timeframe-aware fee/volume thresholds (5m→24h) | None | Port as `core/screening-scales.ts` |
| **HiveMind market push** | `buildMarketFields()` sends entry/exit mcap, tvl, volume | None | Port to `providers/hivemind/sync.ts` |
| **OKX removal** | `tools/okx.js` deleted, OKX removed from prompt, `maxBundlePct`/`athFilterPct` removed | `providers/okx/` exists (345 lines), 42 references across 7 files | **Major decision** — remove OKX entirely or keep? |
| **Path fixes** | 8 files switched to `repoPath()` | Uses `config/paths.ts` ROOT + `import.meta.url` | Evaluate if paths.ts covers same ground |
| **setup.js overhaul** | Major rewrite (+366/-52) | `setup.ts` (511 lines) | Compare diff to see what changed |
| **telegram.js** | +45 lines | `interfaces/telegram/index.ts` | Compare diff |
| **envcrypt** | `loadEnv()` override default → `true` (PM2 fix) | `utils/secure-env.ts` | Check if override=true already set |

**Key question:** Upstream deleted OKX entirely (`tools/okx.js` — 282 lines removed). ts-structures still has `providers/okx/index.ts` (345 lines) with 42 references. This is the biggest divergence.

**OKX references on ts-structures:**

| File | Lines | Usage |
|------|-------|-------|
| `providers/okx/index.ts` | 1-345 | Full OKX DEX API client |
| `core/screen.ts` | 351-378 | `okxParts` + `okxTags` in candidate format |
| `llm/prompt.ts` | 90, 122-124, 131 | OKX signal interpretation instructions |
| `llm/tools/executor.ts` | 48, 791-829 | OKX rug/honeypot safety check before deploy |
| `providers/meteora/pool-discovery.ts` | 850-941 | OKX enrichment during pool discovery |
| `providers/jupiter/token.ts` | 117, 250 | `getAdvancedInfo`, `getClusterList` imports |
| `config/index.ts` | 240 | `okxFailClosed` config key |
| `types/index.ts` | 39 | `okxFailClosed: boolean` in ScreeningConfig |

**Decision required:** Remove OKX (align with upstream) or keep (ts-structures diverges)?

---

### 2. `da8c851` — drop 15m screening timeframe

**Upstream:** Removed `15m` from enum, scales, timeframe map across 5 files.

**ts-structures:** Already done. No `15m` in codebase.

**Action:** None — already ported.

---

### 3. `7c83972` — RPC-derived PnL poller + GMGN fee source

**Upstream changes (10 files, +498 / -52):**

| Sub-change | Upstream state | ts-structures state | Action needed |
|------------|---------------|---------------------|---------------|
| **tools/pnl.js** (272 lines) | `computePositions()` — RPC-based PnL via DLMM SDK + Jupiter prices + Meteora deposit history | None. VP PnL exists in `core/pnl.ts` (bin_shares math). Live PnL in `providers/meteora/dlmm.ts` via Meteora REST API. | **NEW** — port as `providers/solana/pnl.ts` |
| **tools/gmgn.js** (113 lines) | GMGN OpenAPI client — `getGmgnTokenFees()` for accurate fee source | None. GMGN data only read from pool objects in `core/screen.ts:77-82`. | **NEW** — port as `providers/jupiter/gmgn.ts` |
| **config.pnl section** | `rpcUrl`, `source`, `pollIntervalSec`, `depositCacheTtlSec` | None. Only `pnlSanityMaxDiffPct` in management. | Add `PnlConfig` type + config section |
| **config.gmgn section** | `apiKey`, `baseUrl`, `requestDelayMs`, `maxRetries`, `feeSource` | None | Add `GmgnConfig` type + config section |
| **getMyPositions** | Primary path `config.pnl.source === "rpc"` → `computePositions()`. Removed LPAgent relay. | Uses Meteora portfolio API directly in `providers/meteora/dlmm.ts` | Refactor to add RPC primary path |
| **getPositionPnl** | Prefers RPC path, removed `request_id` | In `providers/meteora/dlmm.ts:1511` — Meteora API only | Add RPC primary path |
| **Token fees** | `resolveGlobalFeesSol()` — GMGN replaces Jupiter for `global_fees_sol` | `providers/jupiter/token.ts` — Jupiter only, no GMGN | Add GMGN fee refinement |
| **update_config** | Added `pnlSource`, `pnlRpcUrl`, `gmgnFeeSource`, `gmgnApiKey` | Not in executor tool map | Add config keys |
| **PnL poller** | Uses `config.pnl.pollIntervalSec` (default 3s) | PnL poller in `scheduler/index.ts` — hardcoded interval | Make configurable |
| **gmgn-config.example.json** | NEW file | None | Create |

**What `computePositions()` does (upstream):**
1. `DLMM.getAllLbPairPositionsByUser(conn, wallet)` — on-chain read via public RPC (pump.helius)
2. Jupiter price fetch for SOL + base tokens
3. Meteora `/pnl` API for deposit history (deposits, withdrawals, claimed fees) — cached by signature + TTL
4. `buildPosition()` — computes PnL as: `balances + withdrawals + claimable + claimed - deposits`
5. Returns same shape as `getMyPositions` with `source: "rpc"`

**What ts-structures has now:**
- `core/pnl.ts` — VP (virtual position) math only, not live positions
- `providers/meteora/dlmm.ts:1511` — `getPositionPnl()` fetches from Meteora REST API
- No on-chain RPC-based computation, no deposit-history cache, no `computePositions()`

---

### 4. `9f94792` — pnl_pct_suspicious based on input validity

**Upstream (tools/pnl.js +18/-1):**

Changed from:
```js
const pnlPctSuspicious = pnlPctDiff != null && pnlPctDiff > (config.management.pnlSanityMaxDiffPct ?? 5);
```

To:
```js
const holdsTokenX = xHuman > 0 || feeXHuman > 0;
const priceMissing = !(solUsd > 0) || (holdsTokenX && !!f.baseMint && !(priceX > 0));
const depositsMissing = (solMode ? depositsSol : depositsUsd) <= 0;
const pnlPctSuspicious = priceMissing || depositsMissing;
```

**Why:** Old approach used `pnlPctDiff > 5%` — but Meteora's pct comes from deposit cache (stale up to `depositCacheTtlSec`) while our pct is fresh every poll. On a fast move the gap inflates and falsely suppresses STOP_LOSS/TRAILING_TP. New approach marks suspicious only when pricing data is missing (Jupiter outage) or deposits are missing (cost basis unknown).

**ts-structures state:**
- `providers/meteora/dlmm.ts:1798` — still uses old diff-based approach: `pnlPctDiff > config.management.pnlSanityMaxDiffPct`
- Sets `pnl_pct_suspicious` at line 1877

**Action:** Port the new validity-based logic to `providers/meteora/dlmm.ts` (replaces the diff-based check).

---

### 5. `196c1a2` — honor pnl_pct_suspicious in close rules

**Upstream (index.js +2):**
```js
function getDeterministicCloseRule(position, managementConfig) {
  const pnlSuspect = (() => {
+   if (position.pnl_pct_suspicious) return true;
    if (position.pnl_pct == null) return false;
    ...
```

**ts-structures state:**
- `core/close-rules.ts` — `getCloseRule()` does NOT check `pnl_pct_suspicious`
- Uses inline heuristic: `pnl_pct < -90 && total_value_usd > 0.01` (lines 69-71)
- `pnl_pct_suspicious` IS checked in `core/live/state.ts:452,460` (stop-loss/trailing exits) but NOT in the close-rule engine

**Action:** Add `if (position.pnl_pct_suspicious) return true;` at top of `getCloseRule()` in `core/close-rules.ts`.

---

### 6. `8bbb1e5` — rename "relay poll" → "rpc poll"

**Upstream (state.js +1/-1):**
```
- log("state", `Position ${position_address} peak PnL accepted at ${candidatePnlPct.toFixed(2)}% from relay poll`);
+ log("state", `Position ${position_address} peak PnL accepted at ${candidatePnlPct.toFixed(2)}% from rpc poll`);
```

**ts-structures:**
- `core/live/state.ts:264` — still says `"from relay poll"`

**Action:** Rename to `"from rpc poll"`.

---

### 7-8. `21ef977` + `600aac6` — pnl_tick + heartbeat

**Upstream (tools/pnl.js +7/-1):**
- Added `_pollCount` counter
- Logs every 20th tick: `log("pnl_tick", \`poller alive — ${n} position(s) tracked (tick #${_pollCount})\`)`
- Before that: logged every tick, then throttled to 20th

**ts-structures:** No `pnl_tick` log anywhere. This is part of the RPC PnL engine which doesn't exist yet.

**Action:** Port as part of `providers/solana/pnl.ts` (commit 3).

---

## Action Plan

### Phase 1: Bugfixes (quick wins, no new modules)

| # | Change | File(s) | Effort |
|---|--------|---------|--------|
| 1a | pnl_pct_suspicious → validity-based | `providers/meteora/dlmm.ts` | Small |
| 1b | Add pnl_pct_suspicious to getCloseRule | `core/close-rules.ts` | Trivial |
| 1c | "relay poll" → "rpc poll" | `core/live/state.ts` | Trivial |

### Phase 2: New modules (RPC PnL + GMGN)

| # | Change | File(s) | Effort |
|---|--------|---------|--------|
| 2a | PnlConfig + GmgnConfig types | `types/index.ts` | Small |
| 2b | Config sections | `config/index.ts` | Small |
| 2c | GMGN client | NEW `providers/jupiter/gmgn.ts` | Medium |
| 2d | RPC PnL engine | NEW `providers/solana/pnl.ts` | Large |
| 2e | getMyPositions RPC primary path | `providers/meteora/dlmm.ts` | Medium |
| 2f | resolveGlobalFeesSol | `providers/jupiter/token.ts` | Small |
| 2g | executor config keys | `llm/tools/executor.ts` | Small |
| 2h | gmgn-config.example.json | NEW | Trivial |

### Phase 3: OKX removal (decision required)

| # | Change | File(s) | Effort |
|---|--------|---------|--------|
| 3a | **Decision: remove OKX or keep?** | — | — |
| 3b | If remove: delete `providers/okx/` | `providers/okx/index.ts` | Medium |
| 3c | If remove: clean candidate format | `core/screen.ts` | Medium |
| 3d | If remove: clean prompt | `llm/prompt.ts` | Small |
| 3e | If remove: clean executor safety | `llm/tools/executor.ts` | Small |
| 3f | If remove: clean pool discovery | `providers/meteora/pool-discovery.ts` | Medium |
| 3g | If remove: clean token enrichment | `providers/jupiter/token.ts` | Small |
| 3h | If remove: remove config keys | `config/index.ts`, `types/index.ts` | Small |

### Phase 4: HiveMind market push + screening-scales

| # | Change | File(s) | Effort |
|---|--------|---------|--------|
| 4a | buildMarketFields | `providers/hivemind/sync.ts` | Small |
| 4b | Push market data in lesson/perf events | `providers/hivemind/sync.ts` | Small |
| 4c | screening-scales | NEW `core/screening-scales.ts` | Small |

### Phase 5: Setup overhaul (needs diff comparison)

| # | Change | File(s) | Effort |
|---|--------|---------|--------|
| 5a | Compare upstream setup.js vs ts-structures setup.ts | Both | Review |
| 5b | Port relevant changes | `setup.ts` | Medium |

---

## Open Questions

1. **OKX removal** — Upstream deleted OKX entirely. ts-structures has it deeply integrated (42 refs across 7 files). Do we remove or keep?
2. **RPC PnL as primary** — Upstream made RPC the primary path with Meteora API as fallback. Do we adopt the same architecture?
3. **GMGN config** — Upstream added standalone `gmgn-config.json` file. Do we keep this pattern or fold into `user-config.json`?
4. **setup.ts overhaul** — Need to diff the upstream rewrite against our current setup.ts to see what changed.
