# Meridian Project Structure

Autonomous DLMM liquidity provider agent for Meteora pools on Solana.

## Why This Structure

The original layout dumped everything into `tools/` — API wrappers, business logic, and the agent bridge mixed in one directory. A developer scanning `tools/` couldn't tell if a file was a Solana RPC call or a PnL math function without opening it.

This structure separates concerns so every directory has a clear contract:

| Directory | Contract |
|-----------|----------|
| `external/` | **I/O only.** Talks to APIs, SDKs, RPCs. Zero business logic. |
| `core/` | **Pure logic.** Computes PnL, manages state, orchestrates fallbacks. No direct API calls. |
| `tools/` | **Agent bridge.** Translates between LLM tool calls and `core/` + `external/`. |

Files inside each provider directory use `platform_` prefix naming so functions with the same purpose (e.g. `helius_getBalance`, `jupiter_getBalance`) are distinct at the call site. This makes fallback routing explicit.

## User Story

*As a developer maintaining Meridian, I want to:*

1. Fix a Jupiter API change → open `external/jupiter/`, no grep needed
2. Add a new price feed → drop `external/coinbase/`, wire fallback in `external/sdk.js`
3. Understand VP close logic → open `core/vp/manage.js`, not `tools/` noise
4. Debug a screening issue → `external/meteora/` — that's where every pool-related API call lives
5. Migrate to a new DLMM SDK version → `external/meteora/` contains every SDK interaction
6. Add a new provider that overlaps an existing one → implement the same function name, add fallback in `external/sdk.js`

## Directory Layout

```
meridian/
├── external/              ← API adapters. Each platform in its own directory.
│   ├── caller.js          ← Shared HTTP client: retry, timeout, auth, rate-limit
│   ├── sdk.js             ← Unified provider interface + fallback logic.
│   │                         core/ imports from here, never from individual
│   │                         provider dirs directly.
│   │
│   ├── meteora/
│   │   ├── index.js       ← meteora_deploy(), meteora_close(), meteora_getBins()...
│   │   ├── pool-discovery.js  ← Meteora REST API (top candidates, pool detail)
│   │   └── ...
│   │
│   ├── helius/
│   │   └── index.js       ← helius_getBalance(), helius_getAccount()
│   │
│   ├── jupiter/
│   │   ├── index.js       ← jupiter_swap(), jupiter_getTokenInfo(), jupiter_getBalance()
│   │   └── ...
│   │
│   ├── okx/
│   │   └── index.js       ← okx_getWalletInfo()
│   │
│   ├── hivemind/
│   │   └── index.js       ← hivemind_sync(), hivemind_pushLesson()
│   │
│   └── lpagent/
│       └── index.js       ← lpagent_studyTopLPers()
│
├── core/                  ← Business logic. No direct API calls.
│   ├── pnl.js             ← PnL math (computePositionPnl, slippage estimator)
│   ├── archive.js         ← JSONL archive read/write + dedup
│   ├── gas.js             ← Gas estimation (deploy, close, priority fees)
│   ├── report.js          ← Dry-run report generator
│   ├── wallet.js          ← Wallet abstraction (calls sdk.js)
│   │
│   ├── vp/                ← Virtual position logic (paper trading)
│   │   ├── state.js       ← VP state read/write (dry-run-state.json)
│   │   ├── manage.js      ← VP lifecycle: close, record, pool memory
│   │   ├── close-rule.js  ← Close condition rules (stop-loss, take-profit, trailing)
│   │   ├── digest.js      ← VP performance analysis
│   │   └── merge.js       ← VP merging / reconciliation
│   │
│   └── live/              ← Live position logic (future)
│
├── tools/                 ← Agent bridge. LLM tool schemas + dispatch.
│   ├── executor.js        ← Tool dispatch: name → function, safety checks
│   └── definitions.js     ← OpenAI-format tool schemas (what the LLM sees)
│
├── index.js               ← Entry point: REPL + cron orchestration + Telegram polling
├── agent.js               ← ReAct loop: LLM → tool call → repeat
├── prompt.js              ← System prompt builder per agent role
├── telegram.js            ← Telegram bot (polling, notifications)
│
├── config.js              ← Runtime config (user-config.json + .env)
├── state.js               ← Real position registry (state.json)
├── lessons.js             ← Learning engine (records → lessons → threshold evolution)
├── pool-memory.js         ← Per-pool deploy history
├── strategy-library.js    ← Saved LP strategies
├── smart-wallets.js       ← KOL/alpha wallet tracker
├── token-blacklist.js     ← Permanent token blacklist
├── signal-tracker.js      ← Signal stage/monitor
├── signal-weights.js      ← Signal weighting
├── logger.js              ← Daily-rotating log files
├── hivemind.js            ← HiveMind sync orchestration
├── briefing.js            ← Daily Telegram briefing
├── decision-log.js        ← Agent decision audit trail
├── cli.js                 ← CLI utilities
│
└── utils/
    └── number.js          ← Number formatting helpers
```

## How Data Flows

```
core/vp/manage.js                              core/wallet.js
        │                                            │
        │  import from external/sdk.js               │  import from external/sdk.js
        ▼                                            ▼
┌─────────────────────────────────────────────────────────┐
│                 external/sdk.js                          │
│  Unified interface + fallback routing.                   │
│  Returns standardized shapes regardless of provider.     │
│                                                          │
│  getBalance(addr) → { sol, tokens, usd }                 │
│     tries helius_getBalance → falls back to jupiter      │
│                                                          │
│  getBins(pool) → { bins, activeBin }                     │
│     calls meteora_getBins (only source)                  │
└─────┬───────────────────────┬────────────────────────────┘
      │                       │
      ▼                       ▼
external/helius/          external/jupiter/
  helius_getBalance()       jupiter_getBalance()
                            jupiter_getTokenInfo()
      │                       │
      └───────────┬───────────┘
                  ▼
        external/caller.js
        Shared HTTP: retry(3), backoff, timeout(15s), auth
```

## Naming Convention

Every function inside provider directories uses `platform_` prefix:

| Provider | Function | Purpose |
|----------|----------|---------|
| `helius/index.js` | `helius_getBalance(address)` | SOL + token balances |
| `jupiter/index.js` | `jupiter_getBalance(address)` | Same purpose, different source |
| `jupiter/index.js` | `jupiter_getTokenInfo(mint)` | Token metadata |
| `meteora/index.js` | `meteora_deployPosition(...)` | Deploy LP |
| `meteora/index.js` | `meteora_getBins(pool)` | Bin state |

## Provider Fallback

`external/sdk.js` is the only file that knows about multiple providers. It tries primary, falls back to secondary:

```js
// external/sdk.js — simplified example
import { helius_getBalance } from "./helius/index.js";
import { jupiter_getBalance } from "./jupiter/index.js";

export async function getBalance(address) {
  let result = await helius_getBalance(address).catch(() => null);
  if (!result) result = await jupiter_getBalance(address).catch(() => null);
  return result;  // same { sol, tokens, usd } shape regardless
}
```

`core/` never imports from individual providers — it always goes through `sdk.js`. This keeps fallback routing centralized and provider swaps transparent.

## Platform Contracts

### `external/caller.js` (transport layer)

Low-level HTTP utility. Every provider's internal files use this unless they ship their own SDK (e.g. `@meteora-ag/dlmm`).

```js
call(method, url, { body, headers, retry, timeout })
```

### `external/sdk.js` (provider interface)

The single file that `core/` and `tools/` import from external. Routes to providers, handles fallback, normalizes return shapes.

**Adding a new provider:**
1. Create `external/{platform}/index.js` with `{platform}_*` functions
2. Wire fallback in `external/sdk.js`

### `external/meteora/`

The only directory that imports from `@meteora-ag/dlmm`. Every deploy, close, bin-fetch, and position-fetch goes through here. If the SDK API changes, this is the only place to update.

### `core/vp/`

All virtual position logic. `core/vp/manage.js` is the entry point used by both the management cycle and manual close (LLM / Telegram).

## Migration Status

| Phase | Files | Status |
|-------|-------|--------|
| External API adapters | `external/` | Pending |
| Shared business logic | `core/` | Pending |
| Agent bridge | `tools/` (trimmed) | Pending |

## Historical Context

This structure replaces the original flat layout where every module lived in `tools/`. The migration was driven by:

- Frequent context-switching when debugging (scrolling past agent bridge code to find PnL math)
- Adding a new exchange required understanding the full `tools/` import graph
- No clear boundary between "talks to the network" and "computes a number" — making testing harder
- Provider fallback was ad-hoc (mixed into business logic) instead of centralized
