# Meridian Project Structure

Autonomous DLMM liquidity provider agent for Meteora pools on Solana.

> **Note:** The JavaScript to TypeScript conversion is complete. All active source files are now `.ts`. Original `.js` files are preserved as `*.js.legacy` backups. The folder restructuring (`providers/`, `core/`, etc.) described below is the planned target architecture.

## Current State (ts-migration branch)

All source files are `.ts`. The folder restructuring has **not yet begun** — files are still in the original flat layout.

```
meridian/
├── index.ts, agent.ts, cli.ts, setup.ts       # Root entry points (13 .ts files)
├── config/index.ts                             # Config singleton (migrated)
├── core/                                       # 4 files migrated
│   ├── briefing.ts
│   ├── decision-log.ts
│   ├── signal-tracker.ts
│   └── token-blacklist.ts
├── tools/                                      # 19 .ts files (old flat layout)
│   ├── definitions.ts, executor.ts             # Agent bridge
│   ├── dlmm.ts, screening.ts, wallet.ts, ...   # API adapters + business logic mixed
│   └── *.js.legacy                             # Original JS backups
├── utils/
│   ├── logger.ts, number.ts, secure-env.ts
├── types/index.ts                              # Shared type definitions
├── scripts/                                    # .ts + .js混合
└── test/                                       # 14 test files (.ts)
```

## ⚠️ Migration Notes — Known Issues to Fix Before Restructuring

Three dependency violations exist in the current codebase that must be resolved during migration. They are not runtime bugs today, but will become hard blockers once the new folder gates are enforced.

### Blocker 1 — `executor.ts` imports `telegram.ts` directly

**File**: `tools/executor.ts` line 48
```ts
// Current (wrong after migration):
import { notifyDeploy, notifyClose, notifySwap } from "../telegram.js";

// Fix — route via interfaces gate:
import { notifyDeploy, notifyClose, notifySwap } from "../../interfaces/index.js";
```
**Rule violated**: `llm/` must never import from `interfaces/` directly — only via `interfaces/index.ts` gate.

---

### Blocker 2 — `dlmm.ts` imports `lessons.ts` (layer direction violation)

**File**: `tools/dlmm.ts` line 28
```ts
// Current (wrong — external calling core):
import { recordPerformance } from "../lessons.js";
```
**Rule violated**: `providers/` must never import from `core/`. It is the lowest I/O layer.

**Fix — move `recordPerformance()` UP to the caller**:
```
providers/meteora/index.ts → closePosition() returns { pnlUsd, pnlPct, fees, ... }
core/live/state.ts        → receives result → calls recordPerformance(result)  ✅
```
The SDK wrapper only does the SDK operation and returns data. Recording performance is business logic that belongs in `core/`, not inside an SDK wrapper.

> [!NOTE]
> A `core/shared/` subfolder does NOT solve this. `pnl.ts` and `close-rules.ts` at the root of `core/` already serve as the shared layer between `core/live/` and `core/vp/`. The direction violation must be fixed by moving the call up, not by adding a shared folder.

---

### Blocker 3 — `index.ts` has 20+ direct ungated imports

**File**: `index.ts` lines 1–43 — imports directly from `telegram.js`, `tools/dlmm.js`, `tools/screening.js`, `lessons.js`, `state.js`, `pool-memory.js`, etc.

**Fix**: This resolves automatically once all gate files are created. Update `index.ts` last in the migration sequence:
```ts
// After migration, index.ts imports only from gates:
import { notifyDeploy, sendMessage }  from "./interfaces/index.js";
import { getMyPositions, closePosition } from "./providers/sdk.js";
import { recordPerformance, openPosition } from "./core/index.js";
```

### Safe Migration Order
```
1. Create gate files (empty barrels): core/index.ts, providers/sdk.ts,
   interfaces/index.ts, llm/tools/index.ts
2. Move utils/ (no deps)
3. Move config/ (depends only on utils/)
4. Move providers/ providers → fix Blocker 2 at this step
5. Move core/ files → populate core/index.ts barrel
6. Move llm/ files → split definitions.ts + executor.ts into group files
7. Move interfaces/ → fix Blocker 1 at this step → create interfaces/index.ts
8. Update index.ts last → fix Blocker 3, swap all imports to gates
```

---

## Directory Contracts

| Directory | Responsibility |
|-----------|---------------|
| `providers/` | I/O only. Talks to APIs, SDKs, RPCs. Zero business logic. |
| `core/` | Pure logic. Computes PnL, manages state, orchestrates fallbacks. No direct API calls. |
| `interfaces/` | Platform interfaces. Telegram, Discord, and other communication platforms. |
| `llm/` | Agent harness. LLM communication layer. |
| `utils/` | Utilities. Shared helpers, not business logic. |
| `config/` | Configuration. Runtime settings and environment. |

## Target Directory Tree

```
meridian/
├── cli.ts                      # CLI utilities
├── ecosystem.config.cjs        # PM2 config
├── index.ts                    # Entry point
├── setup.ts                    # Setup wizard
├── tsconfig.json               # TypeScript config
│
├── config/
│   ├── deployer-blacklist.json # Deployer blacklist
│   ├── index.ts                # Runtime config & env loading
│   └── user-config.example.json # Config template
│
├── core/
│   ├── archive.ts              # Position archive (JSONL)
│   ├── briefing.ts             # Daily briefing
│   ├── close-rules.ts          # Shared close-rule engine: stop-loss, take-profit, OOR, low-yield, consecutive down-trend
│   ├── decision-log.ts         # Decision audit trail
│   ├── lessons.ts              # Learning engine
│   ├── pool-memory.ts          # Pool history cache
│   ├── pnl.ts                  # Shared PnL computation (live + VP)
│   ├── signal-tracker.ts       # Signal tracker
│   ├── signal-weights.ts       # Signal weight management
│   ├── smart-wallets.ts        # KOL tracker
│   ├── state.ts                # Position registry (dispatches to live/ or vp/)
│   ├── strategy-library.ts     # Trading strategies
│   ├── token-blacklist.ts      # Token blacklist
│   ├── live/
│   │   ├── manage.ts           # Live lifecycle management (extracted from index.ts)
│   │   └── state.ts            # Live position state
│   └── vp/
│       ├── digest.ts           # VP performance analysis
│       ├── manage.ts           # VP lifecycle management
│       ├── merge.ts            # VP merging / reconciliation
│       ├── report.ts           # Dry-run HTML calendar report generation
│       └── state.ts            # VP state management
│
├── providers/
│   ├── caller.ts               # Shared HTTP client (retry, backoff, timeout)
│   ├── hivemind/
│   │   └── index.ts            # HiveMind sync
│   ├── helius/
│   │   └── index.ts            # Balance lookups via Helius
│   ├── jupiter/
│   │   ├── index.ts            # Swap execution
│   │   └── token.ts            # Token info, holders, narrative
│   ├── lpagent/
│   │   └── index.ts            # LPAgent top-LPer study + Agent Meridian
│   ├── meteora/
│   │   ├── gas.ts              # Gas estimation
│   │   ├── index.ts            # DLMM SDK wrapper (deploy, close, claim, positions)
│   │   ├── indicators.ts       # Chart indicators for screening
│   │   └── pool-discovery.ts   # Pool screening / candidate selection
│   ├── okx/
│   │   └── index.ts            # OKX wallet info
│   ├── solana/
│   │   ├── index.ts            # RPC connection, account reads, tx simulation
│   │   └── balance.ts          # Direct RPC balance fallback
│   └── sdk.ts                  # Unified provider interface
│
├── interfaces/
│   ├── discord/
│   │   ├── index.ts            # Discord listener
│   │   └── pre-checks.ts       # Discord pre-checks
│   └── telegram/
│       ├── index.ts            # Telegram bot
│       └── report.html         # Report template for Telegram
│
├── llm/
│   ├── agent.ts                # LLM ReAct loop
│   ├── prompt.ts               # Prompt building
│   └── tools/
│       ├── definitions.ts      # OpenAI-format tool schemas
│       └── executor.ts         # Tool dispatch with safety checks
│
├── utils/
│   ├── logger.ts               # Shared logger
│   ├── number.ts               # Number formatting
│   └── secure-env.ts           # Encryption utility
│
└── test/                       # Unit tests (mirrors source tree)
    ├── test-agent.ts
    ├── test-blacklist.ts
    ├── test-cache-30s.ts
    ├── test-chart-indicators.ts
    ├── test-close-vp-manual.ts
    ├── test-compute-position-pnl.ts
    ├── test-dry-run-cache.ts
    ├── test-lessons.ts
    ├── test-screening.ts
    ├── test-secure-env.ts
    ├── test-signal-weights.ts
    ├── test-smart-wallets.ts
    ├── test-state-mismatch.ts
    └── test-vp-pnl.ts
```

## [Root](file:///Users/ichadhr/Develop/node/meridian/docs/structures/1.ROOT_FOLDER.md)

Detailed specifications for the root folder are documented in [1.ROOT_FOLDER.md](file:///Users/ichadhr/Develop/node/meridian/docs/structures/1.ROOT_FOLDER.md).

**Target state (after restructuring):**

| File | Role |
|------|------|
| `cli.ts` | 28 CLI subcommands (deploy, claim, screen, vp, config, etc.) |
| `ecosystem.config.cjs` | PM2 config |
| `index.ts` | Main entry point (runtime, Telegram, REPL, cron) |
| `setup.ts` | Setup wizard (degen / moderate / safe presets) |
| `tsconfig.json` | TypeScript config |

**Currently in root (to be moved during restructuring):**

| File | Moves to |
|------|----------|
| `agent.ts` | `llm/agent.ts` |
| `prompt.ts` | `llm/prompt.ts` |
| `telegram.ts` | `interfaces/telegram/index.ts` |
| `hivemind.ts` | `providers/hivemind/index.ts` |
| `lessons.ts` | `core/lessons.ts` |
| `pool-memory.ts` | `core/pool-memory.ts` |
| `signal-weights.ts` | `core/signal-weights.ts` |
| `smart-wallets.ts` | `core/smart-wallets.ts` |
| `state.ts` | `core/state.ts` |
| `strategy-library.ts` | `core/strategy-library.ts` |

## config

Detailed specifications for the config folder are documented in [2.CONFIG_FOLDER.md](file:///Users/ichadhr/Develop/node/meridian/docs/structures/2.CONFIG_FOLDER.md).

Runtime configuration and static config files.

**Already migrated:**

| File | Role |
|------|------|
| `index.ts` | Config singleton (55+ fields across risk, screening, management, strategy, schedule, llm, tokens, hiveMind, api, jupiter, indicators) + `computeDeployAmount`, `reloadScreeningThresholds` |

**Target state (remaining files to migrate from root):**

| File | Role |
|------|------|
| `deployer-blacklist.json` | Deployer blacklist (currently at root) |
| `user-config.example.json` | Config template (currently at root) |

## core

Detailed specifications for the core folder are documented in [3.CORE_FOLDER.md](file:///Users/ichadhr/Develop/node/meridian/docs/structures/3.CORE_FOLDER.md).

Pure business logic. No direct API or RPC calls; imports from `providers/` for I/O.

**Already migrated (4 files):**

| File | Role |
|------|------|
| `briefing.ts` | Daily briefing generation |
| `decision-log.ts` | Decision audit trail |
| `signal-tracker.ts` | Signal tracker |
| `token-blacklist.ts` | Token and deployer blocklists |

**Target state (remaining files to migrate):**

| File | Role |
|------|------|
| `index.ts` | **Public gate** — barrel re-export of all core public functions (only file imported from outside `core/`) |
| `archive.ts` | Position archive (JSONL, dedup, monthly rolls) |
| `close-rules.ts` | Shared close-rule engine for both live and virtual positions |
| `lessons.ts` | Learning engine (pull/push shared lessons) |
| `pool-memory.ts` | Pool history cache (cooldowns, snapshots, notes) |
| `pnl.ts` | Shared PnL computation for both live and virtual positions |
| `signal-weights.ts` | Signal weight management |
| `smart-wallets.ts` | KOL tracker (add/remove/list/check on pool) |
| `state.ts` | Position registry — dispatches to `live/state.ts` or `vp/state.ts` |
| `strategy-library.ts` | Trading strategies (CRUD and active selection) |

### live

| File | Role |
|------|------|
| `live/manage.ts` | Live lifecycle management (extracted from `index.ts` `runManagementCycle()`) |
| `live/state.ts` | Live position state management |

### vp

| File | Role |
|------|------|
| `vp/state.ts` | Virtual position state (track, list, update, close, archive) |
| `vp/manage.ts` | VP lifecycle management (close, run cycle) |
| `vp/digest.ts` | VP performance analysis |
| `vp/merge.ts` | VP merging / reconciliation |
| `vp/report.ts` | Dry-run HTML calendar report generation |

## external

Detailed specifications for the external folder are documented in [4.EXTERNAL_FOLDER.md](file:///Users/ichadhr/Develop/node/meridian/docs/structures/4.EXTERNAL_FOLDER.md).

External I/O adapters. Pure API wrappers; no business logic. **Not yet created.**

| File | Role |
|------|------|
| `caller.ts` | Shared HTTP client (retry, backoff, timeout) |
| `sdk.ts` | Unified provider interface |
| `hivemind/index.ts` | HiveMind sync (register, pull lessons/presets, push lessons/events) |
| `helius/index.ts` | Balance lookups via Helius |
| `jupiter/index.ts` | Swap execution |
| `jupiter/token.ts` | Token info, holders, narrative |
| `lpagent/index.ts` | LPAgent top-LPer study and Agent Meridian |
| `meteora/gas.ts` | Gas estimation (priority fee, deploy/close cost) |
| `meteora/index.ts` | DLMM SDK wrapper (deploy, close, claim, positions) |
| `meteora/indicators.ts` | Chart indicators for screening |
| `meteora/pool-discovery.ts` | Pool screening and candidate selection |
| `okx/index.ts` | OKX wallet enrichment (risk, advanced info, cluster, price) |
| `solana/index.ts` | Solana RPC connection, account reads, tx simulation |
| `solana/balance.ts` | Direct RPC balance fallback (`getParsedAccountInfo`) |

## interfaces

Detailed specifications for the interfaces folder are documented in [5.INTERFACES_FOLDER.md](file:///Users/ichadhr/Develop/node/meridian/docs/structures/5.INTERFACES_FOLDER.md).

Platform communication interfaces. **Not yet created.**

| File | Role |
|------|------|
| `index.ts` | **Outbound gate** — unified `notifyDeploy`, `notifyClose`, `notifySwap`, `notifyOutOfRange`, `sendMessage`, `sendHTML`, `createLiveMessage`, `sendDocument` |
| `discord/index.ts` | Discord listener (address processing, signal ingestion — inbound only, no gate) |
| `discord/pre-checks.ts` | Discord pre-checks (dedup, blacklist, rug check, deployer check, fees check) |
| `telegram/index.ts` | Telegram adapter — `sendMessageTelegram`, `notifyDeployTelegram`, etc. (called only by `interfaces/index.ts`) |
| `telegram/report.html` | HTML report template sent via Telegram |

## llm

Detailed specifications for the llm folder are documented in [6.LLM_FOLDER.md](file:///Users/ichadhr/Develop/node/meridian/docs/structures/6.LLM_FOLDER.md).

Agent harness and LLM communication layer. **Not yet created** (only empty `llm/tools/` dir exists).

| File | Role |
|------|------|
| `agent.ts` | LLM ReAct loop (`agentLoop`, `getToolsForRole`, provider fallback, JSON repair, rate limit retry) |
| `prompt.ts` | Prompt building (`buildSystemPrompt`) |

### tools

Tool files are co-located — each file owns both the schema (what the LLM sees) and the handler (what actually runs) for a logical group. `index.ts` is the only file imported from outside.

| File | Role |
|------|------|
| `tools/index.ts` | Gate — merges all schemas into `tools[]`, routes `executeTool()` |
| `tools/screening.ts` | Schema + handler: discover_pools, get_top_candidates, get_pool_detail, search_pools |
| `tools/deployment.ts` | Schema + handler: deploy_position, get_active_bin |
| `tools/management.ts` | Schema + handler: close_position, claim_fees, get_my_positions, get_position_pnl, get_wallet_positions |
| `tools/cmd/wallet.ts` | Schema + handler: get_wallet_balance, swap_token |
| `tools/cmd/token.ts` | Schema + handler: get_token_info, get_token_holders, get_token_narrative |
| `tools/cmd/smart-wallets.ts` | Schema + handler: add/remove/list/check_smart_wallets, get_top_lpers, study_top_lpers |
| `tools/cmd/lessons.ts` | Schema + handler: add_lesson, pin/unpin_lesson, list_lessons, clear_lessons, self_update, get_recent_decisions |
| `tools/cmd/strategy.ts` | Schema + handler: add/list/get/set_active/remove_strategy |
| `tools/cmd/memory.ts` | Schema + handler: get_pool_memory, add_pool_note, get_performance_history, set_position_note |
| `tools/cmd/blacklist.ts` | Schema + handler: add/remove/list_blacklist, block/unblock/list_blocked_deployers |

## utils

Detailed specifications for the utils folder are documented in [7.UTILS_FOLDER.md](file:///Users/ichadhr/Develop/node/meridian/docs/structures/7.UTILS_FOLDER.md).

Shared utilities and helpers.

| File | Role |
|------|------|
| `logger.ts` | Shared logger (`log`, `logAction`) |
| `number.ts` | Number formatting helpers |
| `secure-env.ts` | Env encrypt/decrypt utilities |

## scripts

One-off scripts and validators.

| File | Role |
|------|------|
| `backfill-vp-archive.js` | Backfill VP archive from legacy state |
| `secure-env.ts` | Env encrypt/decrypt CLI |
| `measure-gas.js` | Gas measurement |
| `patch-anchor.ts` | Patch Anchor BN types |
| `secure-env.ts` | Env encryption/decryption (TS rewrite of envrypt) |
| `validate-slippage.js` | Slippage validation |
| `validate-vp-archive.cjs` | VP archive validation runner |
| `lib/vp-validators.cjs` | Shared VP archive validation library (math + Meteora cross-check) |

## test

Tests (mirrors source tree).

| File | Role |
|------|------|
| `test-agent.ts` | Agent integration |
| `test-blacklist.ts` | Token blacklist CRUD & checks |
| `test-cache-30s.ts` | Cache TTL |
| `test-chart-indicators.ts` | Chart indicator calculations |
| `test-close-vp-manual.ts` | Manual VP close |
| `test-compute-position-pnl.ts` | PnL computation |
| `test-dry-run-cache.ts` | Dry-run cache |
| `test-lessons.ts` | Lessons logic |
| `test-screening.ts` | Candidate pool screening |
| `test-secure-env.ts` | Environment encryption/decryption validation |
| `test-signal-weights.ts` | Signal weights matrix logic |
| `test-smart-wallets.ts` | Smart wallets CRUD & tracking validation |
| `test-state-mismatch.ts` | State sync |
| `test-vp-pnl.ts` | VP PnL |

## Data and Runtime

Runtime data and logs (not part of source tree but needed for operations).

| Path | Role |
|------|------|
| `archives/` | Position archive data (`vp-archive-YYYY-MM.jsonl`, `pool-memory.json`) |
| `logs/` | Runtime logs (`actions-YYYY-MM-DD.jsonl`, `agent-YYYY-MM-DD.log`) |
| `backups-*` | Pre-migration data backups |
| `design/` | Design notes |
| `discord-listener/` | Legacy Discord listener (will be folded into `interfaces/discord/` during restructuring) |
