# Meridian Project Structure

Autonomous DLMM liquidity provider agent for Meteora pools on Solana.

> **Status:** TypeScript conversion complete. Folder restructuring complete. All active source files are `.ts`. Original `.js` files preserved as `*.js.legacy` backups.

## Current State (ts-structures branch)

All source files are `.ts`. Folder restructuring is **complete** — files are in their target locations.

```
meridian/
├── cli.ts                              # CLI utilities (28 subcommands)
├── index.ts                            # Entry point (REPL, cron, Telegram, REPL)
├── setup.ts                            # Setup wizard
│
├── config/
│   └── index.ts                        # Runtime config singleton
│
├── core/
│   ├── index.ts                        # Public gate — barrel re-export
│   ├── archive.ts                      # Position archive (JSONL)
│   ├── briefing.ts                     # Daily briefing generation
│   ├── close-rules.ts                  # Shared close-rule engine
│   ├── decision-log.ts                 # Decision audit trail
│   ├── lessons.ts                      # Learning engine
│   ├── pool-memory.ts                  # Pool history cache
│   ├── pnl.ts                          # Shared PnL computation
│   ├── signal-tracker.ts               # Signal tracker
│   ├── signal-weights.ts               # Signal weight management
│   ├── smart-wallets.ts                # KOL tracker
│   ├── state.ts                        # Position registry
│   ├── strategy-library.ts             # Trading strategies
│   ├── token-blacklist.ts              # Token blacklist
│   ├── live/
│   │   ├── cycle-state.ts              # Shared mutable state (busy flags, timers)
│   │   ├── manage.ts                   # Live lifecycle management
│   │   └── screen.ts                   # Screening cycle + tryStartScreening
│   └── vp/
│       ├── digest.ts                   # VP performance analysis
│       ├── manage.ts                   # VP lifecycle management
│       ├── merge.ts                    # VP merging / reconciliation
│       ├── report.ts                   # Dry-run HTML calendar report
│       └── state.ts                    # VP state management
│
├── providers/
│   ├── sdk.ts                          # Unified provider interface
│   ├── caller.ts                       # Shared HTTP client
│   ├── hivemind/
│   │   ├── index.ts                    # HiveMind sync
│   │   ├── api.ts                      # HiveMind API client
│   │   ├── chart-indicators.ts         # Chart indicators
│   │   └── sync.ts                     # HiveMind sync logic
│   ├── jupiter/
│   │   ├── index.ts                    # Swap execution + token exports
│   │   ├── api.ts                      # Jupiter API client
│   │   └── token.ts                    # Token info, holders, narrative
│   ├── meteora/
│   │   ├── index.ts                    # DLMM SDK wrapper
│   │   ├── dlmm.ts                     # DLMM operations (deploy, close, claim)
│   │   └── pool-discovery.ts           # Pool screening / candidate selection
│   ├── okx/
│   │   └── index.ts                    # OKX wallet enrichment
│   └── solana/
│       ├── index.ts                    # RPC connection, account reads
│       ├── balance.ts                  # Direct RPC balance fallback
│       ├── gas-estimator.ts            # Gas estimation
│       └── wallet.ts                   # Wallet operations
│
├── interfaces/
│   ├── index.ts                        # Outbound gate — delegates to telegram
│   ├── telegram/
│   │   └── index.ts                    # Telegram bot
│   └── discord/
│       ├── index.js                    # Discord listener (standalone)
│       └── pre-checks.js              # Discord pre-checks
│
├── llm/
│   ├── index.ts                        # LLM gate — barrel re-export
│   ├── agent.ts                        # LLM ReAct loop
│   ├── prompt.ts                       # Prompt building
│   └── tools/
│       ├── index.ts                    # Tool system gate
│       ├── definitions.ts              # OpenAI-format tool schemas
│       ├── executor.ts                 # Tool dispatch with safety checks
│       └── study.ts                    # Top LPer study
│
├── utils/
│   ├── logger.ts                       # Shared logger
│   ├── number.ts                       # Number formatting
│   ├── secure-env.ts                   # Env encrypt/decrypt
│   └── text.ts                         # Text utilities (stripThink, sanitize)
│
├── types/
│   └── index.ts                        # Shared type definitions
│
├── scripts/
│   ├── patch-anchor.ts                 # Patch Anchor BN types
│   └── secure-env.ts                   # Env encryption CLI
│
└── test/                               # Unit tests (mirrors source tree)
    └── *.ts
```

## Directory Contracts

| Directory | Responsibility |
|-----------|---------------|
| `providers/` | I/O only. Talks to APIs, SDKs, RPCs. Zero business logic. |
| `core/` | Pure logic. Computes PnL, manages state, orchestrates fallbacks. No direct API calls. |
| `interfaces/` | Platform interfaces. Telegram, Discord, and other communication platforms. |
| `llm/` | Agent harness. LLM communication layer. |
| `utils/` | Utilities. Shared helpers, not business logic. |
| `config/` | Configuration. Runtime settings and environment. |

## Import Gate Rules

Only these files are imported from outside their directory:

| Gate File | Exports |
|-----------|---------|
| `core/index.ts` | All core public functions |
| `providers/sdk.ts` | Unified provider interface |
| `interfaces/index.ts` | All outbound notifications + messaging |
| `llm/index.ts` | `agentLoop`, `tools`, `executeTool`, `buildSystemPrompt` |
| `llm/tools/index.ts` | `tools`, `executeTool` |

All other imports must go through these gates. ESLint enforces this via `no-restricted-imports`.

## Known Legacy Files

`.js.legacy` files exist in `tools/` — kept for reference during migration. Not importable via standard paths.
