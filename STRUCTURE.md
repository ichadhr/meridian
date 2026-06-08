# Meridian Project Structure

Autonomous DLMM liquidity provider agent for Meteora pools on Solana.

> **Note:** The current migration is converting JavaScript to TypeScript, renaming files in place. Original `.js` files are preserved as `.js.legacy` backups. Folder restructuring (`external/`, `core/`, etc.) will happen after the TS conversion is complete.

## Directory Contracts

| Directory | Responsibility |
|-----------|---------------|
| `external/` | I/O only. Talks to APIs, SDKs, RPCs. Zero business logic. |
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
│   │   └── state.ts            # Live position state
│   └── vp/
│       ├── digest.ts           # VP performance analysis
│       ├── manage.ts           # VP lifecycle management
│       ├── merge.ts            # VP merging / reconciliation
│       ├── report.ts           # Dry-run HTML calendar report generation
│       └── state.ts            # VP state management
│
├── external/
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
│   ├── envrypt.ts              # Encryption utility
│   ├── logger.ts               # Shared logger
│   └── patch-anchor.ts         # Anchor patching utility
│
└── test/                       # Unit tests (mirrors source tree)
    ├── pnl.test.ts
    ├── screening.test.ts
    ├── test-agent.js
    ├── test-cache-30s.js
    ├── test-close-vp-manual.js
    ├── test-compute-position-pnl.js
    ├── test-dry-run-cache.js
    ├── test-state-mismatch.js
    └── vp.test.ts
```

## Root

| File | Role |
|------|------|
| `cli.ts` | 28 CLI subcommands (deploy, claim, screen, vp, config, etc.) |
| `ecosystem.config.cjs` | PM2 config |
| `index.ts` | Main entry point (runtime, Telegram, REPL, cron) |
| `setup.ts` | Setup wizard (degen / moderate / safe presets) |
| `tsconfig.json` | TypeScript config |

## config

Runtime configuration and static config files.

| File | Role |
|------|------|
| `deployer-blacklist.json` | Deployer blacklist |
| `index.ts` | Config singleton (55+ fields across risk, screening, management, strategy, schedule, llm, tokens, hiveMind, api, jupiter, indicators) + `computeDeployAmount`, `reloadScreeningThresholds` |
| `user-config.example.json` | Config template |

## core

Pure business logic. No direct API or RPC calls; imports from `external/` for I/O.

| File | Role |
|------|------|
| `archive.ts` | Position archive (JSONL, dedup, monthly rolls) |
| `briefing.ts` | Daily briefing generation |
| `close-rules.ts` | Shared close-rule engine for both live and virtual positions |
| `decision-log.ts` | Decision audit trail |
| `lessons.ts` | Learning engine (pull/push shared lessons) |
| `pool-memory.ts` | Pool history cache (cooldowns, snapshots, notes) |
| `pnl.ts` | Shared PnL computation for both live and virtual positions |
| `signal-tracker.ts` | Signal tracker |
| `signal-weights.ts` | Signal weight management |
| `smart-wallets.ts` | KOL tracker (add/remove/list/check on pool) |
| `state.ts` | Position registry — dispatches to `live/state.ts` or `vp/state.ts` |
| `strategy-library.ts` | Trading strategies (CRUD and active selection) |
| `token-blacklist.ts` | Token and deployer blocklists |

### live

| File | Role |
|------|------|
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

External I/O adapters. Pure API wrappers; no business logic.

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

## interfaces

Platform communication interfaces.

| File | Role |
|------|------|
| `discord/index.ts` | Discord listener (address processing, signal ingestion) |
| `discord/pre-checks.ts` | Discord pre-checks (dedup, blacklist, rug check, deployer check, fees check) |
| `telegram/index.ts` | Telegram bot (send/edit/poll/live message/buttons/notifications) |
| `telegram/report.html` | HTML report template sent via Telegram |

## llm

Agent harness and LLM communication layer.

| File | Role |
|------|------|
| `agent.ts` | LLM ReAct loop (`agentLoop`, `getToolsForRole`, provider fallback, JSON repair, rate limit retry) |
| `prompt.ts` | Prompt building (`buildSystemPrompt`) |

### tools

| File | Role |
|------|------|
| `tools/definitions.ts` | OpenAI-format tool schemas (30+ tools) |
| `tools/executor.ts` | Tool dispatch with safety checks (screening threshold validation, type coercion, config normalization) |

## utils

Shared utilities and helpers.

| File | Role |
|------|------|
| `envrypt.ts` | Env encrypt/decrypt utilities |
| `logger.ts` | Shared logger (`log`, `logAction`) |
| `patch-anchor.ts` | Anchor BN type patching |

## scripts

One-off scripts and validators.

| File | Role |
|------|------|
| `backfill-vp-archive.js` | Backfill VP archive from legacy state |
| `envrypt.js` | Env encrypt/decrypt CLI |
| `measure-gas.js` | Gas measurement |
| `patch-anchor.js` | Patch Anchor BN types |
| `validate-slippage.js` | Slippage validation |
| `validate-vp-archive.cjs` | VP archive validation runner |
| `lib/vp-validators.cjs` | Shared VP archive validation library (math + Meteora cross-check) |

## test

Tests (mirrors source tree).

| File | Role |
|------|------|
| `test-agent.js` | Agent integration |
| `test-cache-30s.js` | Cache TTL |
| `test-close-vp-manual.js` | Manual VP close |
| `test-compute-position-pnl.js` | PnL computation |
| `test-dry-run-cache.js` | Dry-run cache |
| `test-screening.js` | Screening |
| `test-state-mismatch.js` | State sync |
| `test-vp-pnl.js` | VP PnL |

## Data and Runtime

Runtime data and logs (not part of source tree but needed for operations).

| Path | Role |
|------|------|
| `archives/` | Position archive data (`vp-archive-YYYY-MM.jsonl`, `pool-memory.json`) |
| `logs/` | Runtime logs (`actions-YYYY-MM-DD.jsonl`, `agent-YYYY-MM-DD.log`) |
| `backups-*` | Pre-migration data backups |
| `design/` | Design notes |
| `discord-listener/` | Legacy Discord listener (will be folded into `interfaces/discord/` during restructuring) |
