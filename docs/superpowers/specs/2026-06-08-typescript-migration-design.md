# TypeScript Migration Design Spec

## Goal

Migrate the Meridian codebase from JavaScript to TypeScript with strict mode, incrementally, without breaking the running agent.

## Constraints

- **Incremental**: Mixed `.js`/`.ts` allowed during migration. Each file migrates independently.
- **Strict mode from day 1**: No `allowJs`, no lenient settings. Every migrated file must compile under strict.
- **Tests migrate with source**: Each test file converts when its source file converts.
- **No functional regression**: `DRY_RUN=true` mode must produce identical behavior before/after each file migration.
- **Reference STRUCTURE.md**: The existing migration map and per-file checklists are the source of truth for what goes where.

## Approach: Leaf-First, Small → Big

### Phase 0: Bootstrap (30 min)

1. Add `typescript` + `@types/node` as devDependencies
2. Create `tsconfig.json`:
   - `strict: true`
   - `module: "NodeNext"`, `moduleResolution: "NodeNext"`
   - `target: "ES2022"`
   - `rootDir: "."`, `outDir: "dist"`
   - `allowJs: true` (only for .js files not yet migrated — they need to import from .ts files)
   - `include: ["**/*.ts", "**/*.js"]` (gradually remove `.js` as files migrate)
3. Add `"build": "tsc"` and `"typecheck": "tsc --noEmit"` to package.json scripts
4. Verify: `npx tsc --noEmit` passes with no errors (existing .js files are loose)

### Phase 1: Leaf Utils (2-3 hrs)

Migrate files with zero internal dependencies first.

| Source | Target | Lines | Notes |
|--------|--------|-------|-------|
| `logger.js` | `utils/logger.ts` | 75 | Imported by everything. Type the `log`/`logAction` signatures. |
| `utils/number.js` | `utils/number.ts` | ~20 | Tiny util, if it exists |
| `envcrypt.js` | `utils/envrypt.ts` | 121 | Encryption utility. Crypto types are straightforward. |

**Exit gate**: `npx tsc --noEmit` passes, all imports of logger/envrypt resolve.

### Phase 2: Tiny JSON Modules (2-3 hrs)

Files under 100 lines that read/write JSON. Simple data shapes, easy to type.

| Source | Target | Lines |
|--------|--------|-------|
| `token-blacklist.js` | `core/token-blacklist.ts` | 103 |
| `dev-blocklist.js` | `core/token-blacklist.ts` | 66 (merge with above) |
| `decision-log.js` | `core/decision-log.ts` | 68 |
| `briefing.js` | `core/briefing.ts` | 71 |
| `signal-tracker.js` | `core/signal-tracker.ts` | 87 |

**Exit gate**: Each file compiles, `tsc --noEmit` passes, tests pass.

### Phase 3: Medium JSON Modules (3-4 hrs)

| Source | Target | Lines |
|--------|--------|-------|
| `strategy-library.js` | `core/strategy-library.ts` | 227 |
| `signal-weights.js` | `core/signal-weights.ts` | 330 |
| `smart-wallets.js` | `core/smart-wallets.ts` | 103 |
| `pool-memory.js` | `core/pool-memory.ts` | 405 |
| `lessons.js` | `core/lessons.ts` | 781 |

### Phase 4: Pure Logic (2-3 hrs)

Deterministic functions — good TDD candidates.

| Source | Target | Lines |
|--------|--------|-------|
| `tools/compute-position-pnl.js` | `core/pnl.ts` | 397 |
| `tools/virtual-close-rule.js` | `core/vp/close-rule.ts` | 130 |
| `tools/virtual-digest.js` | `core/vp/digest.ts` | 140 |
| `tools/merge-virtual-positions.js` | `core/vp/merge.ts` | 102 |

### Phase 5: External Adapters (3-4 hrs)

I/O-only files. Each calls exactly one external API/SDK.

| Source | Target | Lines |
|--------|--------|-------|
| `tools/agent-meridian.js` | `providers/lpagent/index.ts` | 110 |
| `tools/study.js` | `providers/lpagent/study.ts` | 152 |
| `tools/token.js` | `providers/jupiter/token.ts` | 209 |
| `tools/okx.js` | `providers/okx/index.ts` | 282 |
| `tools/chart-indicators.js` | `providers/meteora/indicators.ts` | 299 |
| `tools/gas-estimator.js` | `providers/meteora/gas.ts` | 179 |

### Phase 6: Complex Externals (6-8 hrs)

The hardest external files.

| Source | Target | Lines |
|--------|--------|-------|
| `tools/wallet.js` | `providers/helius/index.ts` + `providers/jupiter/index.ts` | 314 (split) |
| `tools/screening.js` | `providers/meteora/pool-discovery.ts` | 865 |
| `tools/dlmm.js` | `providers/meteora/index.ts` | 2653 |

`dlmm.js` is the largest single file. May need to split during migration.

### Phase 7: Stateful Core (4-5 hrs)

| Source | Target | Lines |
|--------|--------|-------|
| `config.js` | `config/index.ts` | 314 |
| `state.js` | `core/state.ts` | 513 |
| `tools/position-archive.js` | `core/archive.ts` | 487 |
| `tools/dry-run-state.js` | `core/vp/state.ts` | 319 |
| `tools/manage-virtual.js` | `core/vp/manage.ts` | 462 |

### Phase 8: Integration Layer (5-6 hrs)

Files that import from multiple layers.

| Source | Target | Lines |
|--------|--------|-------|
| `prompt.js` | `llm/prompt.ts` | 178 |
| `agent.js` | `llm/agent.ts` | 444 |
| `telegram.js` | `bots/telegram/index.ts` | 588 |
| `tools/definitions.js` | `bots/tools/definitions.ts` | 1145 |
| `tools/executor.js` | `bots/tools/executor.ts` | 949 |

### Phase 9: Entry Points (4-6 hrs)

Migrate last — they import everything.

| Source | Target | Lines |
|--------|--------|-------|
| `cli.js` | `cli.ts` | 676 |
| `setup.js` | `setup.ts` | 481 |
| `index.js` | `index.ts` | 2250 |
| `hivemind.js` | `providers/hivemind/index.ts` | 346 |
| `discord-listener/index.js` | `bots/discord/index.ts` | ~100 |
| `discord-listener/pre-checks.js` | `bots/discord/pre-checks.ts` | ~100 |

### Phase 10: Scripts

| Source | Target |
|--------|--------|
| `scripts/envrypt.js` | `utils/envrypt-cli.ts` |
| `scripts/measure-gas.js` | `providers/meteora/measure-gas.ts` |
| `scripts/patch-anchor.js` | `utils/patch-anchor.ts` |
| `scripts/validate-slippage.js` | `core/pnl/validate-slippage.ts` |

## Verification Strategy

After each file migration:
1. `npx tsc --noEmit` — must pass
2. `npm test` (existing JS tests still run) — must pass
3. For files with existing tests: run the specific test
4. For critical-path files: `DRY_RUN=true npm start -- --cycle` smoke test

## Key Types to Define Early

After bootstrap, create a `types/` directory with shared interfaces:

```ts
// types/index.ts — shared type definitions
export interface Position {
  pool: string;
  baseMint: string;
  quoteMint: string;
  lowerBin: number;
  upperBin: number;
  amount: number;
  vp_id?: string;
  // ... from state.js tracking
}

export interface PoolCandidate {
  pool: string;
  name: string;
  baseMint: string;
  quoteMint: string;
  fee_active_tvl_ratio: number;
  volatility: number;
  // ... from screening.js
}

export interface Config {
  risk: { maxPositions: number; maxDeployAmount: number };
  screening: { /* 27 fields */ };
  management: { /* 30+ fields */ };
  strategy: { strategy: string; minBinsBelow: number; maxBinsBelow: number; defaultBinsBelow: number };
  schedule: { managementIntervalMin: number; screeningIntervalMin: number; healthCheckIntervalMin: number };
  llm: { temperature: number; maxTokens: number; maxSteps: number; managementModel: string; screeningModel: string; generalModel: string; thinkingManagement: boolean; thinkingScreening: boolean; thinkingGeneral: boolean };
  darwin: { enabled: boolean; windowDays: number; recalcEvery: number; boostFactor: number; decayFactor: number; weightFloor: number; weightCeiling: number; minSamples: number };
  tokens: { SOL: string; USDC: string; USDT: string };
  hiveMind: { url: string; apiKey: string; agentId: string; pullMode: string };
  api: { url: string; publicApiKey: string; lpAgentRelayEnabled: boolean };
  jupiter: { apiKey: string; referralAccount: string; referralFeeBps: number };
  indicators: { enabled: boolean; entryPreset: string; exitPreset: string; rsiLength: number; intervals: string[]; candles: number; rsiOversold: number; rsiOverbought: number; requireAllIntervals: boolean };
}
```

Define these as you encounter them during migration. Don't try to define everything upfront.

## Risk Mitigation

1. **`dlmm.js` (2653 lines)**: Biggest risk. May need to split into multiple files during migration. Consider breaking into `providers/meteora/client.ts`, `providers/meteora/positions.ts`, `providers/meteora/pools.ts`.
2. **Circular imports**: Watch for `index.js` ↔ `tools/executor.js` ↔ `tools/definitions.js` circular deps. Use type-only imports (`import type`) where possible.
3. **`any` escape hatches**: Strict mode means no implicit `any`. For genuinely dynamic code (JSON parsing, SDK returns), use explicit `any` with a `// TODO: type properly` comment. Limit to <5 per file.
4. **Build breakage**: Keep `allowJs: true` in tsconfig until Phase 9. This lets .js files import from .ts files and vice versa.
