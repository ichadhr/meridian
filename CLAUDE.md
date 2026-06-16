# Meridian — CLAUDE.md

Autonomous DLMM liquidity provider agent for Meteora pools on Solana.

---

## Architecture Overview

```
index.ts              Main entry: REPL + cron orchestration + Telegram bot polling
cli.ts                CLI utilities (28 subcommands)
config/index.ts       Runtime config from user-config.json + .env; exposes config object

core/                 Pure business logic (no direct API calls)
  index.ts            Public gate — barrel re-export
  state.ts            Position registry (state.json): tracks bin ranges, OOR timestamps, notes
  lessons.ts          Learning engine: records closed-position perf, derives lessons, evolves thresholds
  pool-memory.ts      Per-pool deploy history + snapshots (pool-memory.json)
  strategy-library.ts Saved LP strategies (strategy-library.json)
  briefing.ts         Daily Telegram briefing (HTML)
  token-blacklist.ts  Permanent token blacklist (token-blacklist.json)
  close-rules.ts      Shared close-rule engine (live + VP)
  pnl.ts              Shared PnL computation
  decision-log.ts     Decision audit trail
  signal-weights.ts   Signal weight management
  smart-wallets.ts    KOL/alpha wallet tracker
  live/
    manage.ts         Live lifecycle management (runLiveManagementCycle)
    screen.ts         Screening cycle + tryStartScreening
    cycle-state.ts    Shared mutable state (busy flags, timers)
  vp/                 Virtual position management

providers/            I/O only — talks to APIs, SDKs, RPCs
  sdk.ts              Unified provider interface
  hivemind/           Agent Meridian HiveMind sync
  jupiter/            Token info + swap execution
  meteora/            DLMM SDK wrapper + pool discovery
  okx/                OKX wallet enrichment
  solana/             RPC connection + wallet operations

interfaces/           Platform communication
  index.ts            Outbound gate — delegates to telegram
  telegram/index.ts   Telegram bot: polling, notifications
  discord/            Discord listener (standalone subprocess)

llm/                  Agent harness — LLM communication layer
  index.ts            LLM gate — barrel re-export
  agent.ts            ReAct loop (OpenRouter/OpenAI-compatible): LLM → tool call → repeat
  prompt.ts           Builds system prompt per agent role (SCREENER / MANAGER / GENERAL)
  tools/
    index.ts          Tool system gate
    definitions.ts    Tool schemas in OpenAI format (what LLM sees)
    executor.ts       Tool dispatch: name → fn, safety checks, pre/post hooks
    study.ts          Top LPer study via LPAgent API

utils/
  logger.ts           Daily-rotating log files + action audit trail
  text.ts             Text utilities (stripThink, sanitize)
```

---

## Agent Roles & Tool Access

Three agent roles filter which tools the LLM can call:

| Role | Purpose | Key Tools |
|------|---------|-----------|
| `SCREENER` | Find and deploy new positions | deploy_position, get_top_candidates, get_token_holders, check_smart_wallets_on_pool |
| `MANAGER` | Manage open positions | close_position, claim_fees, swap_token, get_position_pnl, set_position_note |
| `GENERAL` | Chat / manual commands | All tools |

Sets defined in `agent.ts:6-7`. If you add a tool, also add it to the relevant set(s).

---

## Adding a New Tool

1. **`tools/definitions.ts`** — Add OpenAI-format schema object to the `tools` array
2. **`tools/executor.ts`** — Add `tool_name: functionImpl` to `toolMap`
3. **`agent.ts`** — Add tool name to `MANAGER_TOOLS` and/or `SCREENER_TOOLS` if role-restricted
4. If the tool writes on-chain state, add it to `WRITE_TOOLS` in executor.ts for safety checks

---

## Config System

`config/index.ts` loads `user-config.json` at startup. Runtime mutations go through `update_config` tool (executor.ts) which:
- Updates the live `config` object immediately
- Persists to `user-config.json`
- Restarts cron jobs if intervals changed

**Valid config keys and their sections:**

| Key | Section | Default |
|-----|---------|---------|
| minFeeActiveTvlRatio | screening | 0.05 |
| minTvl / maxTvl | screening | 10k / 150k |
| minVolume | screening | 500 |
| minOrganic | screening | 60 |
| minHolders | screening | 500 |
| minMcap / maxMcap | screening | 150k / 10M |
| minBinStep / maxBinStep | screening | 80 / 125 |
| timeframe | screening | "5m" |
| category | screening | "trending" |
| minTokenFeesSol | screening | 30 |
| maxTop10Pct | screening | 60 |
| blockedLaunchpads | screening | [] |
| deployAmountSol | management | 0.5 |
| maxDeployAmount | risk | 50 |
| maxPositions | risk | 3 |
| gasReserve | management | 0.2 |
| positionSizePct | management | 0.35 |
| minSolToOpen | management | 0.55 |
| outOfRangeWaitMinutes | management | 30 |
| managementIntervalMin | schedule | 10 |
| screeningIntervalMin | schedule | 30 |
| managementModel / screeningModel / generalModel | llm | ModelConfig object (see Model Configuration below) |

**`computeDeployAmount(walletSol)`** — scales position size with wallet balance (compounding). Formula: `clamp(deployable × positionSizePct, floor=deployAmountSol, ceil=maxDeployAmount)`.

---

## Position Lifecycle

1. **Deploy**: `deploy_position` → executor safety checks → `trackPosition()` in state.ts → Telegram notify
2. **Monitor**: management cron → `getMyPositions()` → `getPositionPnl()` → OOR detection → pool-memory snapshots
3. **Close**: `close_position` → `recordPerformance()` in lessons.ts → auto-swap base token to SOL → Telegram notify
4. **Learn**: `evolveThresholds()` runs on performance data → updates config.screening → persists to user-config.json

---

## Screener Safety Checks (executor.ts)

Before `deploy_position` executes:
- `bin_step` must be within `[minBinStep, maxBinStep]`
- `volatility` must be a positive finite number when provided; fresh pool detail with volatility 0/null is rejected
- Total range must be at least `max(35, minBinsBelow)` bins; 1-bin/tiny deploys are refused
- Position count must be below `maxPositions` (force-fresh scan, no cache)
- No duplicate pool allowed (same pool_address)
- No duplicate base token allowed (same base_mint in another pool)
- `amount_x > 0` is rejected. Deploys are single-side SOL only (`amount_y` / `amount_sol`)
- SOL balance must cover `amount_y + gasReserve`
- `blockedLaunchpads` enforced in `getTopCandidates()` before LLM sees candidates

---

## bins_below Calculation (SCREENER)

Linear formula based on positive pool volatility (set in screener prompt, `index.ts`):

```
bins_below = round(minBinsBelow + (volatility / 5) * (maxBinsBelow - minBinsBelow)), clamped to [minBinsBelow, maxBinsBelow]
```

- Default clamp is `[35, 69]`
- `volatility <= 0`, null, or non-finite → skip/refuse deploy
- High volatility (5+) → maxBinsBelow
- Any value in between is valid (continuous, not tiered)

---

## Telegram Commands

Handled directly in `index.ts` (bypass LLM):

| Command | Action |
|---------|--------|
| `/positions` | List open positions with progress bar |
| `/close <n>` | Close position by list index |
| `/set <n> <note>` | Set note on position by list index |

Progress bar format: `[████████░░░░░░░░░░░░] 40%` (no bin numbers, no arrows)

---

## Race Condition: Double Deploy

`_screeningLastTriggered` in index.ts prevents concurrent screener invocations. Management cycle sets this before triggering screener. Also, `deploy_position` safety check uses `force: true` on `getMyPositions()` for a fresh count.

---

## Bundler Detection (token.ts)

Two signals used in `getTokenHolders()`:
- `common_funder` — multiple wallets funded by same source
- `funded_same_window` — multiple wallets funded in same time window

**Thresholds in config**: `maxTop10Pct` (default 60%)
Jupiter audit API: `botHoldersPercentage` (5–25% is normal for legitimate tokens)

---

## Base Fee Calculation (dlmm.ts)

Read from pool object at deploy time:
```js
const baseFactor = pool.lbPair.parameters?.baseFactor ?? 0;
const actualBaseFee = baseFactor > 0
  ? parseFloat((baseFactor * actualBinStep / 1e6 * 100).toFixed(4))
  : null;
```

---

## Model Configuration

- Default model: `process.env.LLM_MODEL` or `openrouter/healer-alpha`
- **Multi-provider support:** Each role can use a different provider with its own failover chain
- Per-role models: `managementModel`, `screeningModel`, `generalModel` in user-config.json

**Provider setup:**
1. Add `LLM_PROVIDER_{NAME}_BASE_URL` and `LLM_PROVIDER_{NAME}_APIKEY` to `.env`
2. Reference provider name in `user-config.json` model config

**Config format (object with failover):**
```json
"screeningModel": {
  "provider": "anthropic",
  "model": "claude-opus-4-5",
  "fallback": [{ "provider": "openrouter", "model": "healer-alpha" }]
}
```

**Config format (legacy string, still works):**
```json
"screeningModel": "openrouter/healer-alpha"
```

- Error classification: 429/502/503/529 → retry; persistent failure → failover; 401/403/400 → fatal
- LM Studio: set `LLM_PROVIDER_LOCAL_BASE_URL=http://localhost:1234/v1` and `LLM_PROVIDER_LOCAL_APIKEY=lm-studio`
- `maxOutputTokens` minimum: 2048 (free models may have lower limits causing empty responses)

---

## Lessons System

`lessons.ts` records closed position performance and auto-derives lessons. Key points:
- `getLessonsForPrompt({ agentType })` — injects relevant lessons into system prompt
- `evolveThresholds()` — adjusts screening thresholds based on winners vs losers (operates on `minFeeActiveTvlRatio`, `minOrganic`, etc.)
- Performance recorded via `recordPerformance()` called from executor.ts after `close_position`

---

## HiveMind

Agent Meridian HiveMind sync is handled by `hivemind.ts`. It uses built-in Agent Meridian defaults unless overridden by config or env.

---

## Environment Variables

| Var | Required | Purpose |
|-----|----------|---------|
| `WALLET_PRIVATE_KEY` | Yes | Base58 or JSON array private key |
| `RPC_URL` | Yes | Solana RPC endpoint |
| `OPENROUTER_API_KEY` | Yes | LLM API key |
| `TELEGRAM_BOT_TOKEN` | No | Telegram notifications |
| `TELEGRAM_CHAT_ID` | No | Telegram chat target |
| `LLM_BASE_URL` | No | Override for local LLM (e.g. LM Studio) |
| `LLM_MODEL` | No | Override default model |
| `DRY_RUN` | No | Skip all on-chain transactions |
| `HIVE_MIND_URL` | No | Collective intelligence server |
| `HIVE_MIND_API_KEY` | No | Hive mind auth token |
| `HELIUS_API_KEY` | No | Enhanced wallet balance data |

---

## Known Issues / Tech Debt

- `get_wallet_positions` tool (dlmm.ts) is in definitions.ts but not in MANAGER_TOOLS or SCREENER_TOOLS — only available in GENERAL role.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **meridian** (2393 symbols, 5518 relationships, 205 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/meridian/context` | Codebase overview, check index freshness |
| `gitnexus://repo/meridian/clusters` | All functional areas |
| `gitnexus://repo/meridian/processes` | All execution flows |
| `gitnexus://repo/meridian/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
