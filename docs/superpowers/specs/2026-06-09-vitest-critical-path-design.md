# Vitest Setup — Critical Path Coverage

## Goal

Add Vitest to Meridian with focused test coverage on money-critical and decision-critical functions. Pure unit tests, no wallet required, minimal mocking.

## Scope

5 test files covering 5 functions. No migration of existing 14 tests — those stay as-is with `test:all`.

## Setup

- `vitest.config.ts` — minimal config, native TS/ESM
- `npm run test:unit` — runs vitest
- `npm run test:all` — unchanged (backward compatible)
- `npm run test` — runs both: `vitest run && npm run test:all`

## Test Files

### 1. `tests/close-rules.test.ts` — `getCloseRule`

Source: `core/close-rules.ts`

Tests the 6 close rules that decide when to close positions:

| Rule | Condition | Expected |
|------|-----------|----------|
| Stop-loss | `pnl_pct <= -config.management.stopLossPct` | `{ action: "CLOSE", reason: "Stop-loss" }` |
| Take-profit | `pnl_pct >= config.management.takeProfitPct` | `{ action: "CLOSE", reason: "Take-profit" }` |
| OOR timeout | `minutes_out_of_range >= outOfRangeWaitMinutes` | `{ action: "CLOSE", reason: "Out of range" }` |
| Low yield | `fee_per_tvl_24h < minFeeActiveTvlRatio && age > minAge` | `{ action: "CLOSE", reason: "Low yield" }` |
| Down trend | `fee_per_tvl_24h` declining + `minutes_out_of_range > threshold` | `{ action: "CLOSE", reason: "Down trend" }` |
| Default | None triggered | `{ action: "STAY" }` |

Edge cases:
- `fee_per_tvl_24h` is `null` (live SDK failed) — Rule 5 skipped, no synthetic guess
- `fee_per_tvl_24h` is `undefined` (VP) — Rule 5 computes synthetic yield
- `minutes_out_of_range` is `null` — OOR rule skipped
- `pnl_pct` is `null` — stop-loss/take-profit skipped

Mocking: Override `config` fields per test. No other mocks.

### 2. `tests/deploy-amount.test.ts` — `computeDeployAmount`

Source: `config/index.ts`

Tests position sizing formula: `clamp(deployable × positionSizePct, floor=deployAmountSol, ceil=maxDeployAmount)`

| Scenario | walletSol | Expected |
|----------|-----------|----------|
| Below minimum | 0.1 | `deployAmountSol` (floor) |
| Normal range | 5.0 | `deployable × positionSizePct` |
| Above maximum | 100.0 | `maxDeployAmount` (ceiling) |
| Zero balance | 0 | `deployAmountSol` (floor) |

Mocking: Override `config.management.*` and `config.risk.*` fields.

### 3. `tests/bins-below.test.ts` — `computeBinsBelow`

Source: `index.ts` (REPL helper)

Tests volatility scaling formula: `clamp(lo + (volatility / 5) * (hi - lo), lo, hi)`

| Volatility | Expected bins |
|------------|--------------|
| 0 (invalid) | Throws error |
| 1 | Low end |
| 2.5 | Mid range |
| 5+ | `maxBinsBelow` (ceiling) |
| Negative | Throws error |

Mocking: Override `config.strategy.minBinsBelow` and `config.strategy.maxBinsBelow`.

### 4. `tests/candidate-guard.test.ts` — `getLoneCandidateSkipReason`

Source: `core/live/screen.ts`

Tests the single-candidate skip logic:

| Condition | Expected |
|-----------|----------|
| `pool.is_wash` | Skip: "wash trading" |
| `pool.is_rugpull` + no smart wallets | Skip: "rugpull risk" |
| `pool.is_pvp` + no smart wallets | Skip: "PVP conflict" |
| `globalFeesSol < minTokenFeesSol` | Skip: "token fees below minimum" |
| `top10Pct > maxTop10Pct` | Skip: "top10 concentration" |
| `botPct > maxBotHoldersPct` | Skip: "bot holders" |
| No narrative + no smart wallets | Skip: "no strong signal" |
| Smart wallets present | Pass (null) |
| Narrative present | Pass (null) |

Mocking: Override `config.screening.*` thresholds. Pass synthetic Candidate objects.

### 5. `tests/tool-executor.test.ts` — `executeTool`

Source: `llm/tools/executor.ts`

Tests tool dispatch with `DRY_RUN=true`:

| Scenario | Expected |
|----------|----------|
| Known tool (e.g. `get_wallet_balance`) | Dispatches to handler, returns result |
| Unknown tool | Throws "Unknown tool" |
| Blocked tool in non-GENERAL role | Throws safety error |
| `deploy_position` with `amount_y > 0` | Rejected (SOL-only) |
| `deploy_position` with insufficient SOL | Rejected |
| `close_position` on VP | Routes to VP handler |

Mocking: Set `process.env.DRY_RUN = "true"`. Mock provider functions at the SDK boundary (vi.fn() for `getMyPositions`, `getPositionPnl`, etc.). Config is real.

## Mocking Strategy

- **Config**: Import real `config` object, override fields per test with `Object.assign`
- **Providers**: Mock at SDK boundary (vi.fn()) — only for `executeTool` tests
- **File system**: Not mocked — tests don't read/write files
- **RPC/Wallet**: Not needed — DRY_RUN mode or pure functions

## What This Does NOT Cover

- `runManagementCycle` — complex orchestration, needs integration test
- `runScreeningCycle` — same
- `agentLoop` — LLM integration, needs API key
- Telegram notifications — needs bot token
- Actual on-chain transactions — tested separately with devnet wallet

## Success Criteria

- `npm run test:unit` passes with 0 errors
- All 5 test files have ≥80% line coverage on target functions
- No wallet required, no API keys required
- Tests run in <5 seconds total
