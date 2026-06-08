# Meridian Project Structure

> **For detailed per-function migration steps, see [`docs/migration/README.md`](docs/migration/README.md) and the numbered phase docs `docs/migration/01-external.md` through `05-validation.md`.**

Autonomous DLMM liquidity provider agent for Meteora pools on Solana.

## Why This Structure

The original layout dumped everything into `tools/` — API wrappers, business logic, and the agent bridge mixed in one directory. A developer scanning `tools/` couldn't tell if a file was a Solana RPC call or a PnL math function without opening it.

This structure separates concerns so every directory has a clear contract:

| Directory | Contract |
|-----------|----------|
| `external/` | **I/O only.** Talks to APIs, SDKs, RPCs. Zero business logic. |
| `core/` | **Pure logic.** Computes PnL, manages state, orchestrates fallbacks. No direct API calls. |
| `llm/` | **Agent harness.** LLM communication layer. |
| `bots/` | **Platform interfaces.** Telegram, Discord, and other communication platforms. |
| `utils/` | **Utilities.** Shared helpers, not business logic. |
| `config/` | **Configuration.** Runtime settings and environment. |

## Target Directory Tree

```
meridian/
├── index.ts                    # Entry point
├── setup.ts                    # Setup wizard
├── cli.ts                      # CLI utilities
│
├── external/
│   ├── caller.ts               # Shared HTTP client (retry, backoff, timeout)
│   ├── sdk.ts                  # Unified provider interface
│   ├── meteora/
│   │   ├── index.ts            # DLMM SDK wrapper (deploy, close, claim, positions)
│   │   ├── pool-discovery.ts   # Pool screening / candidate selection
│   │   ├── indicators.ts       # Chart indicators for screening
│   │   └── gas.ts              # Gas estimation
│   ├── helius/
│   │   └── index.ts            # Balance lookups via Helius
│   ├── jupiter/
│   │   ├── index.ts            # Swap execution
│   │   └── token.ts            # Token info, holders, narrative
│   ├── okx/
│   │   └── index.ts            # OKX wallet info
│   ├── lpagent/
│   │   └── index.ts            # LPAgent top-LPer study + Agent Meridian
│   └── hivemind/
│       └── index.ts            # HiveMind sync
│
├── core/
│   ├── state.ts                # Position registry (dispatches to live/ or vp/)
│   ├── live/
│   │   └── state.ts            # Live position state
│   ├── pool-memory.ts          # Pool history cache
│   ├── strategy-library.ts     # Trading strategies
│   ├── smart-wallets.ts        # KOL tracker
│   ├── token-blacklist.ts      # Token blacklist
│   ├── lessons.ts              # Learning engine
│   ├── briefing.ts             # Daily briefing
│   ├── decision-log.ts         # Decision audit trail
│   ├── signal-tracker.ts       # Signal tracker
│   ├── signal-weights.ts       # Signal weight management
│   ├── pnl.ts                  # PnL math for VP and live positions
│   ├── archive.ts              # Position archive (JSONL)
│   └── vp/
│       ├── state.ts            # VP state management
│       ├── manage.ts           # VP lifecycle management
│       ├── close-rule.ts       # Close condition rules
│       ├── digest.ts           # VP performance analysis
│       ├── merge.ts            # VP merging / reconciliation
│       └── report.ts           # Dry-run report generation
│
├── llm/
│   ├── agent.ts                # LLM ReAct loop
│   └── prompt.ts               # Prompt building
│
├── bots/
│   ├── telegram/
│   │   ├── index.ts            # Telegram bot
│   │   └── report.html         # Report template for Telegram
│   ├── tools/
│   │   ├── definitions.ts      # OpenAI-format tool schemas
│   │   └── executor.ts         # Tool dispatch with safety checks
│   └── discord/
│       ├── index.ts            # Discord listener
│       └── pre-checks.ts       # Discord pre-checks
│
├── utils/
│   ├── logger.ts               # Shared logger
│   ├── envrypt.ts              # Encryption utility
│   └── patch-anchor.ts         # Anchor patching utility
│
├── config/
│   ├── index.ts                # Runtime config & env loading
│   ├── user-config.example.json # Config template
│   └── deployer-blacklist.json # Deployer blacklist
│
└── test/                       # Unit tests (mirrors source tree)
    ├── pnl.test.ts
    ├── vp.test.ts
    ├── screening.test.ts
    └── ...
```

## Current Architecture

### Root Files (legacy)

| File | Exports / Key Functions |
|------|--------------------------|
| `index.js` | `async runManagementCycle`, `async runScreeningCycle`, `startCronJobs` (2,250 lines; cron, Telegram, REPL); internal: `async shutdown`, `tryStartScreening`, `withTimeout`, `getDeterministicCloseRule`, `async runBriefing`, `async maybeRunMissedBriefing`, `async deployLatestCandidate`, `async telegramHandler`, `buildPrompt`, `stripThink`, `fmtPct`, `formatCandidates`, `renderSettingsMenu`, `formatCountdown`, `nextRunIn` |
| `agent.js` | `async agentLoop`, `getToolsForRole`, `shouldRequireRealToolUse`, `buildMessages` |
| `prompt.js` | `buildSystemPrompt` |
| `telegram.js` | `sendMessage`, `sendHTML`, `async sendLongMessage`, `async sendMessageWithButtons`, `async sendDocument`, `async editMessage`, `async editMessageWithButtons`, `async answerCallbackQuery`, `async notifyDeploy`, `async notifyClose`, `async notifySwap`, `async notifyOutOfRange`, `async createLiveMessage`, `async poll`, `startPolling`, `stopPolling`, `isEnabled` |
| `config.js` | exports `config` (12 subsections: risk, screening, management, strategy, schedule, llm, darwin, tokens, hiveMind, api, jupiter, indicators), `MIN_SAFE_BINS_BELOW`; functions: `computeDeployAmount`, `reloadScreeningThresholds`; internal: `numericConfig`, `nonEmptyString` |
| `state.js` | `trackPosition`, `markOutOfRange`, `markInRange`, `minutesOutOfRange`, `recordClaim`, `recordClose`, `setPositionInstruction`, `queuePeakConfirmation`, `resolvePendingPeak`, `queueTrailingDropConfirmation`, `resolvePendingTrailingDrop`, `getTrackedPositions`, `getTrackedPosition`, `getStateSummary`, `updatePnlAndCheckExits`, `getLastBriefingDate`, `setLastBriefingDate`, `syncOpenPositions` |
| `logger.js` | `log`, `logAction` |
| `cli.js` | 28 subcommands (no exports; `out`, `die` internal) — switch table: balance, positions, pnl, candidates, token-info, token-holders, token-narrative, pool-detail, search-pools, active-bin, wallet-positions, deploy, claim, close, swap, screen, manage, config, study, start, lessons, pool-memory, evolve, blacklist, performance, discord-signals, withdraw-liquidity, add-liquidity |
| `setup.js` | 3 presets: degen / moderate / safe (no exports; `ask`, `askNum`, `askBool`, `askChoice`, `parseEnv`, `buildEnv` internal) |
| `envcrypt.js` | `envryptEncrypt`, `envryptDecrypt`, `loadEnv`, `encryptEnvRaw` |
| `hivemind.js` | `isHiveMindEnabled`, `getHiveMindPullMode`, `getSharedLessonsForPrompt`, `ensureAgentId`, `startHiveMindBackgroundSync`, `bootstrapHiveMind`, `async registerHiveMindAgent`, `async pullHiveMindLessons`, `async pullHiveMindPresets`, `async pushHiveLesson`, `async pushHivePerformanceEvent`; internal: `readJson`, `writeJson`, `sanitizeText`, `readUserConfig`, `writeUserConfig`, `readCache`, `writeCache`, `getBaseUrl`, `getApiKey`, `getPullMode`, `buildUrl`, `async requestJson`, `normalizeSharedLesson`, `buildLessonEvent`, `inferLessonSourceType`, `shouldCountInAdjustedWinRate`, `getAgentId`, `getVersion` |

### `tools/` Directory Layout (legacy — `tools/` — 19 files)

| File | Exports / Key Functions |
|------|--------------------------|
| `dlmm.js` | `decimalPriceToQ64`, `getConnection`, `async getActiveBin`, `getBinsInRange`, `async deployPosition`, `getPositionPnl`, `async getMyPositions`, `async getWalletPositions`, `async searchPools`, `async claimFees`, `async closePosition`, `invalidatePositionsCache`, `_resetBinsInRangeCacheForTesting`, `_setBinsInRangeCacheForTesting`, `_getBinsInRangeCacheSizeForTesting`, `_positionsCacheTtlForTesting`; internal: `getDLMM`, `getWallet`, `getPool`, `getPoolMetadata`, `withRetry`, `sendTxWithRetry`, `sendTxBatch`, `signAndSimulateRelayTransactions`, `assertRangeDoesNotRequireBinArrayInitialization`, `getDlmmProgramId`, `getDlmmInstructionDiscriminators`, `formatSolFee`, `shouldUseLpAgentRelay`, `shouldUseLpAgentRelayForDeploy`, `signSerializedTransaction`, `deserializeSignedTransaction`, `assertNoUnsafeSystemTransfer`, `signSerializedTransactions`, `normalizeExecutionSignatures`, `getStaticAccountKeyStrings`, `getTransactionInstructions`, `assertNoInitializeBinArrayInstructions`, `addPriorityFee`, `getPriorityFeeMicroLamports` |
| `wallet.js` | `async getWalletBalances`, `normalizeMint`, `async swapToken`, `_resetSolPriceCacheForTesting`, `async fetchSolPrice`; internal: `getConnection`, `getWallet`, `getJupiterApiKey`, `getJupiterReferralParams` |
| `screening.js` | `async discoverPools`, `async getTopCandidates`, `async getPoolDetail`; internal: `normalizeSymbol`, `scoreCandidate`, `numeric`, `isUsableVolatility`, `includesCaseInsensitive`, `getPoolLaunchpad`, `getPoolBaseMint`, `getVolatilityTimeframe`, `getRawPoolScreeningRejectReason`, `async fetchDiscordSignalCandidates`, `async fetchPoolDiscoveryPage`, `async fetchPoolDiscoveryDetail`, `async applyVolatilityTimeframe`, `async searchAssetsBySymbol`, `async enrichDiscordSignalLaunchpads`, `async findRivalPool`, `async enrichPvpRisk`, `async refreshDiscordOnlyPools`, `condensePool`, `round`, `fix`, `pushFilteredReason` |
| `okx.js` | `async getRiskFlags`, `async getAdvancedInfo`, `async getClusterList`, `async getPriceInfo`, `async getFullTokenAnalysis`; internal: `hasAuth`, `buildAuthHeaders`, `async okxRequest`, `async okxGet`, `async okxPost`, `agentMeridianBaseUrl`, `agentMeridianHeaders`, `async fetchServerOkxEnrichment`, `async getServerOkxEnrichmentOrNull`, `isAffirmative`, `collectRiskEntries` |
| `study.js` | `async studyTopLPers`; internal: `fetchTopLp`, `fetchStudyTopLp`, `buildPatterns`, `countValues`, `avg`, `round`, `isNum`, `fmtPct` |
| `token.js` | `async getTokenNarrative`, `async getTokenInfo`, `async getTokenHolders` |
| `chart-indicators.js` | `async confirmIndicatorPreset`; internal: `normalizeIntervals`, `safeNum`, `buildSignalSummary`, `evaluatePreset`, `async fetchChartIndicatorsForMint` |
| `compute-position-pnl.js` | `computePositionPnl`, `estimateSlippageLamports`; internal: `mulShr` |
| `manage-virtual.js` | `async closeVpManual`, `async runVirtualManagementCycle`; internal: `async getFreshCloseGasSol`, `buildPosForRule`, `buildCloseResult`, `recordVpDeployToPoolMemory`, `async closeVpAndRecord` |
| `virtual-close-rule.js` | `getVirtualCloseRule` |
| `virtual-digest.js` | `async generateVirtualDigest`; internal: `safeNum`, `avg` |
| `merge-virtual-positions.js` | `mergeVirtualPositions` |
| `position-archive.js` | exports `ARCHIVE_DIR`; `cleanRecord`, `appendArchiveRecord`, `appendArchiveRecordIfNew`, `dedupeArchive`, `dedupeAllArchives`, `async readArchive`, `migrateOldArchives`, `purgeCorruptedArchiveRecords`, `compileVpStats`; internal: `ensureDir`, `archivePath`, `currentMonth`, `monthFromRecord`, `cacheIsValid`, `invalidateCache` |
| `gas-estimator.js` | `async samplePriorityFee`, `cuToSolCost`, `async estimateDeployGasSol`, `async estimateCloseGasSol`, `async estimateFullCycleGasSol`, `getRentCostSol`; internal: `async ensureSdkLoaded` |
| `definitions.js` | `tools` (30+ tool schemas); `getToolsForRole` |
| `executor.js` | `executeTool`, `registerCronRestarter`, `registerScreeningTrigger`; internal: `async runSafetyChecks`, `summarizeResult`, `numberOrNull`, `getVolatilityTimeframe`, `poolDetailTvl`, `poolDetailBinStep`, `poolDetailVolatility`, `poolDetailFeeActiveTvlRatio`, `async fetchFreshPoolDetail`, `async validateDeployPoolThresholds`, `coerceBoolean`, `coerceFiniteNumber`, `coerceString`, `coerceStringArray`, `normalizeConfigValue` |
| `dry-run-state.js` | `trackVirtualPosition`, `listVirtualPositions`, `getVirtualPosition`, `updateVirtualPosition`, `parseVirtualPositionAddress`, `closeVirtualPosition`, `archiveVirtualPositions`; internal: `load`, `save`, `nextId` |
| `generate-dry-run-report.js` | `async generateDryRunReport`; internal: `async loadAllClosedPositions`, `groupByDay`, `computeStats`, `positionHtml`, `escapeHtml`, `isSolPosition`, `formatPnl`, `sumPnlByCurrency`, `formatCurrencyTotal`, `findCurrentMonth`, `showMonth`, `panMonth`, `openDay`, `formatDate`, `closeModal`, `buildDayData`, `buildMonths` |
| `agent-meridian.js` | `getAgentMeridianBase`, `getAgentMeridianHeaders`, `getAgentIdForRequests`, `async agentMeridianJson`; internal: `sleep`, `isRetryableStatus`, `retryDelayMs`, `async fetchWithTimeout`, `async agentMeridianJsonOnce` |

### `discord-listener/` (legacy)

| File | Exports / Key Functions |
|------|--------------------------|
| `discord-listener/index.js` | No exports; internal: `isLikelySolanaAddress`, `loadSignals`, `saveSignal`, `async processAddress` |
| `discord-listener/pre-checks.js` | `dedupCheck`, `blacklistCheck`, `async resolvePool`, `async rugCheck`, `async deployerCheck`, `async feesCheck`, `async runPreChecks` |

### `scripts/` (legacy)

| File | Exports / Key Functions |
|------|--------------------------|
| `scripts/envrypt.js` | No exports; internal: `usage` (CLI help) |
| `scripts/measure-gas.js` | No exports |
| `scripts/patch-anchor.js` | No exports; internal: `removeBNFromSpecifiers` |
| `scripts/validate-slippage.js` | No exports; internal: `async findPools`, `async loadBinData`, `withTimeout` |

## File Migration Map

> For per-function breakdowns and validation checklists, see:
> - [`01-external.md`](../docs/migration/01-external.md) | [`02-core.md`](../docs/migration/02-core.md) | [`03-llm-bots.md`](../docs/migration/03-llm-bots.md) | [`04-utils-config.md`](../docs/migration/04-utils-config.md)

### Root Files (legacy)

> Cross-check: each entry below maps to a section in [`docs/migration/04-utils-config.md`](../docs/migration/04-utils-config.md) (or `01-external.md` for hivemind).

---

#### `index.js` → `index.ts`

> Doc: [`docs/migration/04-utils-config.md:300-454`](../docs/migration/04-utils-config.md#index.ts)

Exports:
- [x] `async runManagementCycle` — [`04-utils-config.md:308`](../docs/migration/04-utils-config.md#indexts)
- [x] `async runScreeningCycle` — [`04-utils-config.md:309`](../docs/migration/04-utils-config.md#indexts)
- [x] `startCronJobs` — [`04-utils-config.md:310`](../docs/migration/04-utils-config.md#indexts)

Internal:
- [x] `async shutdown` — [`04-utils-config.md:378`](../docs/migration/04-utils-config.md#indexts)
- [x] `nextRunIn` (line 75) — [`04-utils-config.md:354`](../docs/migration/04-utils-config.md#indexts)
- [x] `formatCountdown` (line 81) — [`04-utils-config.md:354`](../docs/migration/04-utils-config.md#indexts)
- [x] `buildPrompt` (line 88) — [`04-utils-config.md:345`](../docs/migration/04-utils-config.md#indexts)
- [x] `stripThink` (line 111) — [`04-utils-config.md:346`](../docs/migration/04-utils-config.md#indexts)
- [x] `sanitizeUntrustedPromptText` (line 116) — [`04-utils-config.md:346`](../docs/migration/04-utils-config.md#indexts)
- [x] `shouldUsePnlRecheck` — [`04-utils-config.md:347`](../docs/migration/04-utils-config.md#indexts)
- [x] `schedulePeakConfirmation` — [`04-utils-config.md:349`](../docs/migration/04-utils-config.md#indexts)
- [x] `scheduleTrailingDropConfirmation` — [`04-utils-config.md:350`](../docs/migration/04-utils-config.md#indexts)
- [x] `async runBriefing` — [`04-utils-config.md:351`](../docs/migration/04-utils-config.md#indexts)
- [x] `async maybeRunMissedBriefing` — [`04-utils-config.md:352`](../docs/migration/04-utils-config.md#indexts)
- [x] `stopCronJobs` — [`04-utils-config.md:353`](../docs/migration/04-utils-config.md#indexts)
- [x] `tryStartScreening` — [`04-utils-config.md:356`](../docs/migration/04-utils-config.md#indexts)
- [x] `withTimeout` — [`04-utils-config.md:379`](../docs/migration/04-utils-config.md#indexts)
- [x] `getDeterministicCloseRule` — [`04-utils-config.md:357`](../docs/migration/04-utils-config.md#indexts)
- [x] `formatCandidates` — [`04-utils-config.md:358`](../docs/migration/04-utils-config.md#indexts)
- [x] `setLatestCandidates` / `getLatestCandidatesMeta` / `describeLatestCandidates` — [`04-utils-config.md:341`](../docs/migration/04-utils-config.md#indexts)
- [x] `formatWalletStatus` — [`04-utils-config.md:359`](../docs/migration/04-utils-config.md#indexts)
- [x] `formatConfigSnapshot` — [`04-utils-config.md:360`](../docs/migration/04-utils-config.md#indexts)
- [x] `parseConfigValue` / `settingValue` / `fmtSettingValue` / `settingButton` / `toggleButton` / `stepButtons` — [`04-utils-config.md:361-366`](../docs/migration/04-utils-config.md#indexts)
- [x] `renderSettingsMenu` — [`04-utils-config.md:367`](../docs/migration/04-utils-config.md#indexts)
- [x] `async showSettingsMenu` — [`04-utils-config.md:368`](../docs/migration/04-utils-config.md#indexts)
- [x] `normalizeMenuValue` / `applySettingsMenuCallback` — [`04-utils-config.md:369-370`](../docs/migration/04-utils-config.md#indexts)
- [x] `formatHelpText` — [`04-utils-config.md:371`](../docs/migration/04-utils-config.md#indexts)
- [x] `async runDeterministicScreen` — [`04-utils-config.md:372`](../docs/migration/04-utils-config.md#indexts)
- [x] `async deployLatestCandidate` — [`04-utils-config.md:373`](../docs/migration/04-utils-config.md#indexts)
- [x] `appendHistory` / `refreshPrompt` / `async drainTelegramQueue` — [`04-utils-config.md:374-376`](../docs/migration/04-utils-config.md#indexts)
- [x] `async telegramHandler` — [`04-utils-config.md:377`](../docs/migration/04-utils-config.md#indexts)

Telegram command handlers (inside `telegramHandler`, src:1516-1868):
- [x] `/briefing` — [`04-utils-config.md:396`](../docs/migration/04-utils-config.md#indexts)
- [x] `/help` — [`04-utils-config.md:397`](../docs/migration/04-utils-config.md#indexts)
- [x] `/wallet` / `/status` — [`04-utils-config.md:398`](../docs/migration/04-utils-config.md#indexts)
- [x] `/config` — [`04-utils-config.md:399`](../docs/migration/04-utils-config.md#indexts)
- [x] `/positions` — [`04-utils-config.md:400`](../docs/migration/04-utils-config.md#indexts)
- [x] `/vp` / `/vp report` — [`04-utils-config.md:401`](../docs/migration/04-utils-config.md#indexts)
- [x] `/pool <n>` — [`04-utils-config.md:402`](../docs/migration/04-utils-config.md#indexts)
- [x] `/close <n>` — [`04-utils-config.md:403`](../docs/migration/04-utils-config.md#indexts)
- [x] `/closeall` — [`04-utils-config.md:404`](../docs/migration/04-utils-config.md#indexts)
- [x] `/set <n> <note>` — [`04-utils-config.md:405`](../docs/migration/04-utils-config.md#indexts)
- [x] `/setcfg <key> <value>` — [`04-utils-config.md:406`](../docs/migration/04-utils-config.md#indexts)
- [x] `/screen` — [`04-utils-config.md:407`](../docs/migration/04-utils-config.md#indexts)
- [x] `/candidates` — [`04-utils-config.md:408`](../docs/migration/04-utils-config.md#indexts)
- [x] `/deploy <n>` — [`04-utils-config.md:409`](../docs/migration/04-utils-config.md#indexts)
- [x] `/pause` — [`04-utils-config.md:410`](../docs/migration/04-utils-config.md#indexts)
- [x] `/resume` — [`04-utils-config.md:411`](../docs/migration/04-utils-config.md#indexts)
- [x] `/hive` / `/hive pull` — [`04-utils-config.md:412`](../docs/migration/04-utils-config.md#indexts)
- [x] free-form chat — [`04-utils-config.md:413`](../docs/migration/04-utils-config.md#indexts)

REPL input handlers (src:2010-2236):
- [x] `1`/`2`/`3` deploy — [`04-utils-config.md:419-420`](../docs/migration/04-utils-config.md#indexts)
- [x] `auto` — [`04-utils-config.md:421`](../docs/migration/04-utils-config.md#indexts)
- [x] `go` — [`04-utils-config.md:422`](../docs/migration/04-utils-config.md#indexts)
- [x] `/stop` — [`04-utils-config.md:423`](../docs/migration/04-utils-config.md#indexts)
- [x] `/status` — [`04-utils-config.md:424`](../docs/migration/04-utils-config.md#indexts)
- [x] `/briefing` — [`04-utils-config.md:425`](../docs/migration/04-utils-config.md#indexts)
- [x] `/candidates` — [`04-utils-config.md:426`](../docs/migration/04-utils-config.md#indexts)
- [x] `/thresholds` — [`04-utils-config.md:427`](../docs/migration/04-utils-config.md#indexts)
- [x] `/learn [addr]` — [`04-utils-config.md:428`](../docs/migration/04-utils-config.md#indexts)
- [x] `/evolve` — [`04-utils-config.md:429`](../docs/migration/04-utils-config.md#indexts)
- [x] `/vp` / `/vp report` — [`04-utils-config.md:430`](../docs/migration/04-utils-config.md#indexts)
- [x] free-form — [`04-utils-config.md:431`](../docs/migration/04-utils-config.md#indexts)

Startup paths:
- [x] `isMain && isTTY` → REPL + Telegram — [`04-utils-config.md:447`](../docs/migration/04-utils-config.md#indexts)
- [x] `isMain && !isTTY` → cron only — [`04-utils-config.md:448`](../docs/migration/04-utils-config.md#indexts)

Cron jobs:
- [x] Management `*/N * * * *` → `runManagementCycle` — [`04-utils-config.md:385`](../docs/migration/04-utils-config.md#indexts)
- [x] Screening `*/N * * * *` → `runScreeningCycle` — [`04-utils-config.md:386`](../docs/migration/04-utils-config.md#indexts)
- [x] Health check `0 * * * *` → `agentLoop(...)` — [`04-utils-config.md:387`](../docs/migration/04-utils-config.md#indexts)
- [x] Briefing `0 1 * * *` UTC → `runBriefing` — [`04-utils-config.md:388`](../docs/migration/04-utils-config.md#indexts)
- [x] Briefing watchdog `0 */6 * * *` UTC → `maybeRunMissedBriefing` — [`04-utils-config.md:389`](../docs/migration/04-utils-config.md#indexts)
- [x] PnL poller every 30s → trailing TP + exit rule checks — [`04-utils-config.md:390`](../docs/migration/04-utils-config.md#indexts)

#### `agent.js` → `llm/agent.ts`

> Doc: [`docs/migration/03-llm-bots.md:5-79`](../docs/migration/03-llm-bots.md#llm/agent.ts)

Exports:
- [ ] `async agentLoop` — [`03-llm-bots.md:48`](../docs/migration/03-llm-bots.md#llm/agent.ts)

Internal:
- [ ] `getToolsForRole` — [`03-llm-bots.md:45`](../docs/migration/03-llm-bots.md#llm/agent.ts)
- [ ] `shouldRequireRealToolUse` — [`03-llm-bots.md:47`](../docs/migration/03-llm-bots.md#llm/agent.ts)
- [ ] `buildMessages` — [`03-llm-bots.md:47`](../docs/migration/03-llm-bots.md#llm/agent.ts)
- [ ] `MANAGER_TOOLS` — [`03-llm-bots.md:30`](../docs/migration/03-llm-bots.md#llm/agent.ts)
- [ ] `SCREENER_TOOLS` — [`03-llm-bots.md:31`](../docs/migration/03-llm-bots.md#llm/agent.ts)
- [ ] `GENERAL_INTENT_ONLY_TOOLS` — [`03-llm-bots.md:32`](../docs/migration/03-llm-bots.md#llm/agent.ts)
- [ ] `INTENT_TOOLS` — [`03-llm-bots.md:34`](../docs/migration/03-llm-bots.md#llm/agent.ts)
- [ ] `INTENT_PATTERNS` — [`03-llm-bots.md:35`](../docs/migration/03-llm-bots.md#llm/agent.ts)
- [ ] `DEFAULT_MODEL` — [`03-llm-bots.md:36`](../docs/migration/03-llm-bots.md#llm/agent.ts)
- [ ] `MUTATING_TOOL_INTENTS` — [`03-llm-bots.md:37`](../docs/migration/03-llm-bots.md#llm/agent.ts)
- [ ] `LIVE_DATA_TOOL_INTENTS` — [`03-llm-bots.md:38`](../docs/migration/03-llm-bots.md#llm/agent.ts)
- [ ] `CONFIG_READ_ONLY_INTENTS` — [`03-llm-bots.md:39`](../docs/migration/03-llm-bots.md#llm/agent.ts)
- [ ] `DECISION_EXPLANATION_INTENTS` — [`03-llm-bots.md:40`](../docs/migration/03-llm-bots.md#llm/agent.ts)
- [ ] `isSystemRoleError` — [`03-llm-bots.md:135`](../docs/migration/03-llm-bots.md#llm/agent.ts)
- [ ] `sleep` — [`03-llm-bots.md:442`](../docs/migration/03-llm-bots.md#llm/agent.ts)

agentLoop internals:
- [ ] Provider fallback (system → user_embedded) — [`03-llm-bots.md:217`](../docs/migration/03-llm-bots.md#llm/agent.ts)
- [ ] tool_choice fallback — [`03-llm-bots.md:225`](../docs/migration/03-llm-bots.md#llm/agent.ts)
- [ ] Malformed JSON repair — [`03-llm-bots.md:259`](../docs/migration/03-llm-bots.md#llm/agent.ts)
- [ ] ONCE_PER_SESSION locks — [`03-llm-bots.md:175`](../docs/migration/03-llm-bots.md#llm/agent.ts)
- [ ] Rate limit retry — [`03-llm-bots.md:427`](../docs/migration/03-llm-bots.md#llm/agent.ts)
- [ ] SCREENER deploy guard — [`03-llm-bots.md:288`](../docs/migration/03-llm-bots.md#llm/agent.ts)

Validation checklist:
- [ ] `getToolsForRole("MANAGER", ...)` → only 6 manager tools in array — [`03-llm-bots.md:66`](../docs/migration/03-llm-bots.md#llm/agent.ts)
- [ ] `getToolsForRole("SCREENER", ...)` → only screener tools — [`03-llm-bots.md:67`](../docs/migration/03-llm-bots.md#llm/agent.ts)
- [ ] `getToolsForRole("GENERAL", "deploy")` → deploy-related tools — [`03-llm-bots.md:68`](../docs/migration/03-llm-bots.md#llm/agent.ts)
- [ ] `getToolsForRole("GENERAL", "random chat")` → fallback to non-restricted tools — [`03-llm-bots.md:69`](../docs/migration/03-llm-bots.md#llm/agent.ts)
- [ ] `shouldRequireRealToolUse("deploy", "GENERAL")` → true — [`03-llm-bots.md:70`](../docs/migration/03-llm-bots.md#llm/agent.ts)
- [ ] `shouldRequireRealToolUse("why did you close", "GENERAL")` → false — [`03-llm-bots.md:71`](../docs/migration/03-llm-bots.md#llm/agent.ts)
- [ ] `agentLoop("balance")` → verify tool call path + result — [`03-llm-bots.md:72`](../docs/migration/03-llm-bots.md#llm/agent.ts)
- [ ] `agentLoop("top secret deploy", {}, "SCREENER")` → verify deploy guard fires when no `deploy_position` — [`03-llm-bots.md:73`](../docs/migration/03-llm-bots.md#llm/agent.ts)
- [ ] Malformed tool args → verify jsonrepair path — [`03-llm-bots.md:74`](../docs/migration/03-llm-bots.md#llm/agent.ts)
- [ ] Rate limit `error.status=429` → verify 30s retry — [`03-llm-bots.md:75`](../docs/migration/03-llm-bots.md#llm/agent.ts)

#### `telegram.js` → `bots/telegram/index.ts`

> Doc: import entries at [`04-utils-config.md:324`](../docs/migration/04-utils-config.md#indexts) — **no dedicated `telegram.js` section in docs yet**
>
> Source-side truth (from full read of `telegram.js`, 588 lines):
> - **17 exports**: `isEnabled` (line 82), `sendMessage` (126), `sendMessageWithButtons` (131), `sendHTML` (139), `sendDocument` (148), `sendLongMessage` (190), `editMessage` (230), `editMessageWithButtons` (238), `answerCallbackQuery` (247), `hasActiveLiveMessage` (255), `createLiveMessage` (337), `startPolling` (520), `stopPolling` (528), `notifyDeploy` (533), `notifyClose` (555), `notifySwap` (564), `notifyOutOfRange` (573)
> - **Key internals**: `loadChatId` (26), `saveChatId` (37), `isAuthorizedIncomingMessage` (51), `postTelegram` (86), `postTelegramRaw` (106), `formatMarkdownToTelegramHtml` (173), `splitAtBoundary` (218), `poll` (441), `registerCommands` (506), `createTypingIndicator` (259), `toolLabel` (286), `summarizeToolResult` (310), `BOT_COMMANDS` (483), `sleep` (581), `fmtPct` (585)

Validation checklist:
- [ ] `isEnabled()` → returns token presence — [`source:telegram.js:82`]
- [ ] `sendMessage`/`sendMessageWithButtons`/`sendHTML`/`sendDocument` → all send wrappers guard on TOKEN+chatId — [`source:telegram.js:126-166`]
- [ ] `sendLongMessage` → chunked >4KB, markdown→HTML auto-conversion — [`source:telegram.js:190-216`]
- [ ] `editMessage`/`editMessageWithButtons`/`answerCallbackQuery` → edit/callback paths — [`source:telegram.js:230-253`]
- [ ] `createLiveMessage` → flush-timer live update object with `toolStart`/`toolFinish`/`finalize`/`fail` — [`source:telegram.js:337-437`]
- [ ] `notifyDeploy`/`notifyClose`/`notifySwap`/`notifyOutOfRange` → HTML notification helpers — [`source:telegram.js:533-579`]
- [ ] `startPolling`/`stopPolling` → long-poll getUpdates loop with auth + callback_query support — [`source:telegram.js:520-530`]
- [ ] `getUpdates` response: `isAuthorizedIncomingMessage` rejects unapproved chat/user — [`source:telegram.js:51-79`]
- [ ] `poll` error path: 5s sleep on non-abort failures, `error.status=429` is not in telegram.js (HTTP client, not provider) — [`source:telegram.js:474-480`]
- [ ] `BOT_COMMANDS` array (19 commands) registered via `setMyCommands` on start — [`source:telegram.js:483-518`]

#### `config.js` → `config/index.ts`

> Doc: [`docs/migration/04-utils-config.md:182-227`](../docs/migration/04-utils-config.md#config/index.ts)

Exports:
- [ ] `MIN_SAFE_BINS_BELOW` (35) — [`04-utils-config.md:190`](../docs/migration/04-utils-config.md#config/index.ts)
- [ ] `config` (singleton, 12 subsections, 55-226) — [`04-utils-config.md:191`](../docs/migration/04-utils-config.md#config/index.ts)
- [ ] `computeDeployAmount(walletSol)` — [`04-utils-config.md:192`](../docs/migration/04-utils-config.md#config/index.ts)
- [ ] `reloadScreeningThresholds()` — [`04-utils-config.md:193`](../docs/migration/04-utils-config.md#config/index.ts)

Internals:
- [ ] `numericConfig` — [`source:config.js:17`]
- [ ] `nonEmptyString` — [`source:config.js:46`]

Config shape (from docs + source):
- [ ] `config.risk`: `{ maxPositions, maxDeployAmount }` — [`04-utils-config.md:197`]
- [ ] `config.screening` (27 fields) — [`04-utils-config.md:198`]
- [ ] `config.management` (30+ fields, includes trailing TP, vpGasCostSol, vpSlippagePct(deprecated), vpSlippagePctUnreliable, vpTrendExitCycles) — [`04-utils-config.md:199`]
- [ ] `config.strategy`: `{ strategy, minBinsBelow, maxBinsBelow, defaultBinsBelow }` — [`04-utils-config.md:200`]
- [ ] `config.schedule`: `{ managementIntervalMin, screeningIntervalMin, healthCheckIntervalMin }` — [`04-utils-config.md:201`]
- [ ] `config.llm`: `{ temperature, maxTokens, maxSteps, managementModel, screeningModel, generalModel, thinkingManagement, thinkingScreening, thinkingGeneral }` — [`04-utils-config.md:202`]
- [ ] `config.darwin`: `{ enabled, windowDays, recalcEvery, boostFactor, decayFactor, weightFloor, weightCeiling, minSamples }` — [`04-utils-config.md:203`]
- [ ] `config.tokens`: `{ SOL, USDC, USDT }` — [`04-utils-config.md:204`]
- [ ] `config.hiveMind`: `{ url, apiKey, agentId, pullMode }` — [`04-utils-config.md:205`]
- [ ] `config.api`: `{ url, publicApiKey, lpAgentRelayEnabled }` — [`04-utils-config.md:206`]
- [ ] `config.jupiter`: `{ apiKey, referralAccount, referralFeeBps }` — [`04-utils-config.md:207`]
- [ ] `config.indicators`: `{ enabled, entryPreset, exitPreset, rsiLength, intervals, candles, rsiOversold, rsiOverbought, requireAllIntervals }` — [`04-utils-config.md:208`]

Bootstrap behavior:
- [ ] Reads `user-config.json` → apply to `process.env` (RPC_URL, WALLET_PRIVATE_KEY, LLM_MODEL, LLM_BASE_URL, LLM_API_KEY, DRY_RUN, PUBLIC_API_KEY, AGENT_MERIDIAN_API_URL) — [`04-utils-config.md:212`]
- [ ] `vpSlippagePct` deprecation warning (lines 232-239) — [`04-utils-config.md:214`]

Validation checklist:
- [ ] `config.screening.minTvl` → 10_000 default — [`04-utils-config.md:218`]
- [ ] `config.screening.minTokenAgeHours` → null default — [`04-utils-config.md:219`]
- [ ] `config.screening.timeframe` → "4h" default (source: code = "5m", note discrepancy) — [`04-utils-config.md:220`]
- [ ] `config.management.minClaimAmount` → 5 — [`04-utils-config.md:221`]
- [ ] `config.darwin.enabled` → true — [`04-utils-config.md:222`]
- [ ] `computeDeployAmount(2.0)` → ~0.63 — [`04-utils-config.md:223`]
- [ ] `reloadScreeningThresholds` → mutate user-config.json, call, verify live update — [`04-utils-config.md:224`]
- [ ] `config.tokens.SOL` → verify mint address — [`04-utils-config.md:225`]
- [ ] Env fallback: set `RPC_URL` env, verify `config` reads from env — [`04-utils-config.md:226`]

#### `state.js` → `core/state.ts` (+ `core/live/state.ts` planned split)

> Doc: [`02-core.md:9-126`](../docs/migration/02-core.md#core/state.ts)

Exports (18 total):
- [ ] `trackPosition` — [`02-core.md:17`]
- [ ] `markOutOfRange` — [`02-core.md:18`]
- [ ] `markInRange` — [`02-core.md:19`]
- [ ] `minutesOutOfRange` — [`02-core.md:20`]
- [ ] `recordClaim` — [`02-core.md:21`]
- [ ] `recordClose` — [`02-core.md:22`]
- [ ] `setPositionInstruction` — [`02-core.md:23`]
- [ ] `queuePeakConfirmation` — [`02-core.md:24`]
- [ ] `resolvePendingPeak` — [`02-core.md:25`]
- [ ] `queueTrailingDropConfirmation` — [`02-core.md:26`]
- [ ] `resolvePendingTrailingDrop` — [`02-core.md:27`]
- [ ] `getTrackedPositions` — [`02-core.md:28`]
- [ ] `getTrackedPosition` — [`02-core.md:29`]
- [ ] `getStateSummary` — [`02-core.md:30`]
- [ ] `updatePnlAndCheckExits` — [`02-core.md:31`]
- [ ] `getLastBriefingDate` — [`02-core.md:32`]
- [ ] `setLastBriefingDate` — [`02-core.md:33`]
- [ ] `syncOpenPositions` — [`02-core.md:34`]

Internal helpers:
- [ ] `sanitizeStoredText` (19-28) — [`02-core.md:40`]
- [ ] `load` (30-40) — [`02-core.md:41`]
- [ ] `save` (42-49) — [`02-core.md:42`]
- [ ] `pushEvent` (169-175) — [`02-core.md:43`]

Exported constants:
- [ ] `STATE_FILE` (`"./state.json"`) — [`02-core.md:49`]
- [ ] `SYNC_GRACE_MS` (`5 * 60_000`) — [`02-core.md:50`]

Source-side truth vs docs gap:
- [ ] `updatePnlAndCheckExits` (372-462) checks 5 things: confirmed trailing exit (378-388), stop loss (412-418), trailing TP activation+drop (420-433), out-of-range timeout (435-444), low yield (446-459) — docs checklist only lists 3 (stop loss, OOR, low yield) — [`source:state.js:372-462` vs `02-core.md:107`]

Planned split:
- [ ] `core/live/state.ts` — `syncOpenPositions` + live-only `getTrackedPositions` slice — [`02-core.md:116-125`]

| `agent.js` | `llm/agent.ts` |
| `prompt.js` | `llm/prompt.ts` |
| `telegram.js` | `bots/telegram/index.ts` |
| `config.js` | `config/index.ts` |
| `state.js` | `core/state.ts` (+ `core/live/state.ts`) |

#### `pool-memory.js` → `core/pool-memory.ts`

> Doc: [`docs/migration/02-core.md:415-458`](../docs/migration/02-core.md#core/pool-memory.ts)

Exports (7):
- [ ] `recordPoolDeploy` (101-216) — [`02-core.md:423`]
- [ ] `isPoolOnCooldown` (218-224) — [`02-core.md:424`]
- [ ] `isBaseMintOnCooldown` (226-235) — [`02-core.md:425`]
- [ ] `getPoolMemory` (243-276) — [`02-core.md:426`]
- [ ] `recordPositionSnapshot` (283-323) — [`02-core.md:427`]
- [ ] `recallForPool` (329-370) — [`02-core.md:428`]
- [ ] `addPoolNote` (376-405) — [`02-core.md:429`]

Internal helpers:
- [ ] `sanitizeStoredNote` (15-24) — [`02-core.md:435`]
- [ ] `load` (26-33) — [`02-core.md:436`]
- [ ] `save` (35-37) — [`02-core.md:437`]
- [ ] `isOorCloseReason` (39-42) — [`02-core.md:438`]
- [ ] `isAdjustedWinRateExcludedReason` (44-50) — [`02-core.md:439`]
- [ ] `isFeeGeneratingDeploy` (52-60) — [`02-core.md:440`]
- [ ] `setPoolCooldown` (62-67) — [`02-core.md:441`]
- [ ] `setBaseMintCooldown` (69-79) — [`02-core.md:442`]

Validation checklist:
- [ ] `recordPoolDeploy` — record a close, verify pool entry + aggregates updated — [`02-core.md:451`]
- [ ] `isPoolOnCooldown` — active cooldown, verify true; expired, verify false — [`02-core.md:452`]
- [ ] `isBaseMintOnCooldown` — any pool with that base mint on cooldown, verify true — [`02-core.md:453`]
- [ ] `getPoolMemory` — known pool, verify full object; unknown, verify `known: false` — [`02-core.md:454`]
- [ ] `recordPositionSnapshot` — append, verify capped at 48 — [`02-core.md:455`]
- [ ] `recallForPool` — known pool with history, verify formatted string; unknown, verify null — [`02-core.md:456`]
- [ ] `addPoolNote` — add note, verify saved; empty note, verify error — [`02-core.md:457`]

- [ ] Source-side note:
- [ ] docs omit `addPoolNote`, `isPoolOnCooldown`, `isBaseMintOnCooldown` from the checklist above, but all 7 exports are listed at lines 423-429 — fully covered

| `agent.js` | `llm/agent.ts` |
| `prompt.js` | `llm/prompt.ts` |
| `telegram.js` | `bots/telegram/index.ts` |
| `config.js` | `config/index.ts` |
| `state.js` | `core/state.ts` (+ `core/live/state.ts`) |
| `pool-memory.js` | `core/pool-memory.ts` |
| `strategy-library.js` | `core/strategy-library.ts` |
| `smart-wallets.js` | `core/smart-wallets.ts` |
| `token-blacklist.js` | `core/token-blacklist.ts` |
| `lessons.js` | `core/lessons.ts` |
| `briefing.js` | `core/briefing.ts` |
| `decision-log.js` | `core/decision-log.ts` |
| `signal-tracker.js` | `core/signal-tracker.ts` |
| `signal-weights.js` | `core/signal-weights.ts` |
| `logger.js` | `utils/logger.ts` |
| `setup.js` | `setup.ts` |
| `cli.js` | `cli.ts` |
| `hivemind.js` | `external/hivemind/index.ts` |

Checklist (see [`04-utils-config.md`](../docs/migration/04-utils-config.md) / [`01-external.md`](../docs/migration/01-external.md)):
- [ ] `runManagementCycle`, `runScreeningCycle`, `startCronJobs`
- [ ] internals: `shutdown`, `getDeterministicCloseRule`, `runBriefing`, `telegramHandler`
- [ ] agent/prompt/telegram/config/state/{trackPosition,recordClose,...}/logger/envcrypt/hivemind/{isEnabled,pullHiveMind,...}
- [ ] cli (28 subcommands); setup (3 presets)


#### `pool-memory.js` → `core/pool-memory.ts`

> Doc: [`docs/migration/02-core.md:415-458`](../docs/migration/02-core.md#core/pool-memory.ts)

Exports (7):
- [ ] `recordPoolDeploy` (101-216) — [`02-core.md:423`]
- [ ] `isPoolOnCooldown` (218-224) — [`02-core.md:424`]
- [ ] `isBaseMintOnCooldown` (226-235) — [`02-core.md:425`]
- [ ] `getPoolMemory` (243-276) — [`02-core.md:426`]
- [ ] `recordPositionSnapshot` (283-323) — [`02-core.md:427`]
- [ ] `recallForPool` (329-370) — [`02-core.md:428`]
- [ ] `addPoolNote` (376-405) — [`02-core.md:429`]

Internal helpers:
- [ ] `sanitizeStoredNote` (15-24) — [`02-core.md:435`]
- [ ] `load` (26-33) — [`02-core.md:436`]
- [ ] `save` (35-37) — [`02-core.md:437`]
- [ ] `isOorCloseReason` (39-42) — [`02-core.md:438`]
- [ ] `isAdjustedWinRateExcludedReason` (44-50) — [`02-core.md:439`]
- [ ] `isFeeGeneratingDeploy` (52-60) — [`02-core.md:440`]
- [ ] `setPoolCooldown` (62-67) — [`02-core.md:441`]
- [ ] `setBaseMintCooldown` (69-79) — [`02-core.md:442`]

Validation checklist:
- [ ] `recordPoolDeploy` — record a close, verify pool entry + aggregates updated — [`02-core.md:451`]
- [ ] `isPoolOnCooldown` — active cooldown, verify true; expired, verify false — [`02-core.md:452`]
- [ ] `isBaseMintOnCooldown` — any pool with that base mint on cooldown, verify true — [`02-core.md:453`]
- [ ] `getPoolMemory` — known pool, verify full object; unknown, verify `known: false` — [`02-core.md:454`]
- [ ] `recordPositionSnapshot` — append, verify capped at 48 — [`02-core.md:455`]
- [ ] `recallForPool` — known pool with history, verify formatted string; unknown, verify null — [`02-core.md:456`]
- [ ] `addPoolNote` — add note, verify saved; empty note, verify error — [`02-core.md:457`]

Source-side note:
- [ ] docs omit `addPoolNote`, `isPoolOnCooldown`, `isBaseMintOnCooldown` from the checklist above, but all 7 exports are listed at lines 423-429 — fully covered


#### `strategy-library.js` → `core/strategy-library.ts`

> Doc: [`docs/migration/02-core.md:461-504`](../docs/migration/02-core.md#core/strategy-library.ts)

Exports (6):
- [ ] `addStrategy` (122-162) — [`02-core.md:469`]
- [ ] `listStrategies` (167-179) — [`02-core.md:470`]
- [ ] `getStrategy` (184-190) — [`02-core.md:471`]
- [ ] `setActiveStrategy` (195-203) — [`02-core.md:472`]
- [ ] `removeStrategy` (208-218) — [`02-core.md:473`]
- [ ] `getActiveStrategy` (223-227) — [`02-core.md:474`]

Internal:
- [ ] `load` (14-21), `save` (23-25) — [`02-core.md:480-481`]
- [ ] `ensureDefaultStrategies` (94-114) — seeds 5 defaults on first run — [`02-core.md:482`]
- [ ] `DEFAULT_STRATEGIES` (28-92) — 5 built-in strategies — [`02-core.md:483`]

Default strategies:
- [ ] `custom_ratio_spot` — spot, directional bias — [`02-core.md:489`]
- [ ] `single_sided_reseed` — bid_ask, re-seed on dip — [`02-core.md:490`]
- [ ] `fee_compounding` — any, claim→re-add — [`02-core.md:491`]
- [ ] `multi_layer` — mixed, composite shape — [`02-core.md:492`]
- [ ] `partial_harvest` — any, progressive profit-taking — [`02-core.md:493`]


#### `smart-wallets.js` → `core/smart-wallets.ts`

> Doc: [`docs/migration/02-core.md:506-538`](../docs/migration/02-core.md#core/smart-wallets.ts)

Exports (4):
- [ ] `addSmartWallet` (24-37) — [`02-core.md:514`]
- [ ] `removeSmartWallet` (39-47) — [`02-core.md:515`]
- [ ] `listSmartWallets` (49-52) — [`02-core.md:516`]
- [ ] `checkSmartWalletsOnPool` (58-103) — [`02-core.md:517`]

Internal:
- [ ] `loadWallets` (9-16) — [`02-core.md:523`]
- [ ] `saveWallets` (18-20) — [`02-core.md:524`]
- [ ] `_cache` (55) — 5-min position cache — [`02-core.md:525-526`]
- [ ] `CACHE_TTL` (56) — 5 minutes — [`02-core.md:525-526`]
- [ ] `SOLANA_PUBKEY_RE` (22) — address validator — [`source:smart-wallets.js:22`]

Dynamic import:
- [ ] `import("./tools/dlmm.js")` — used inside `checkSmartWalletsOnPool` — [`source:smart-wallets.js:72` vs `02-core.md:530`]

Validation checklist:
- [ ] `addSmartWallet` — valid address, verify added; duplicate, verify error; invalid address, verify error — [`02-core.md:534`]
- [ ] `removeSmartWallet` — remove, verify gone; nonexistent, verify error — [`02-core.md:535`]
- [ ] `listSmartWallets` — verify `{ total, wallets[] }` — [`02-core.md:536`]
- [ ] `checkSmartWalletsOnPool` — wallets in pool, verify `signal: "STRONG"`; none, verify `neutral` — [`02-core.md:537`]


#### `token-blacklist.js` → `core/token-blacklist.ts`

> Doc: [`docs/migration/02-core.md:541-581`](../docs/migration/02-core.md#core/token-blacklist.ts)

Source: `token-blacklist.js` (103 lines) + `dev-blocklist.js` (66 lines)

Exports from `token-blacklist.js`:
- [ ] `isBlacklisted` (33-37) — [`02-core.md:551`]
- [ ] `addToBlacklist` (44-68) — [`02-core.md:552`]
- [ ] `removeFromBlacklist` (73-87) — [`02-core.md:553`]
- [ ] `listBlacklist` (92-103) — [`02-core.md:554`]

Exports from `dev-blocklist.js`:
- [ ] `isDevBlocked` (28-31) — [`02-core.md:560`]
- [ ] `getBlockedDevs` (33-35) — [`02-core.md:561`]
- [ ] `blockDev` (37-49) — [`02-core.md:562`]
- [ ] `unblockDev` (51-59) — [`02-core.md:563`]
- [ ] `listBlockedDevs` (62-66) — [`02-core.md:564`]

Exported constants:
- [ ] `BLACKLIST_FILE` (`"./token-blacklist.json"`) — [`02-core.md:570`]
- [ ] `BLOCKLIST_FILE` (`"./dev-blocklist.json"`) — [`02-core.md:571`]

Validation checklist:
- [ ] `isBlacklisted` — known mint, verify true; unknown, verify false — [`02-core.md:575`]
- [ ] `addToBlacklist` — add, verify saved; duplicate, verify `already_blacklisted` — [`02-core.md:576`]
- [ ] `removeFromBlacklist` — remove, verify gone; not found, verify error — [`02-core.md:577`]
- [ ] `listBlacklist` — verify count + entries — [`02-core.md:578`]
- [ ] `isDevBlocked` — known dev, verify true — [`02-core.md:579`]
- [ ] `blockDev`/`unblockDev`/`listBlockedDevs` — same pattern as token blacklist — [`02-core.md:580`]


#### `lessons.js` → `core/lessons.ts`

> Doc: [`docs/migration/02-core.md:584-?`](../docs/migration/02-core.md#core/lessons.ts)

Source: `lessons.js` (not yet fully read in this pass — TODO)

Next entries from the File Migration Map:
- [ ] `briefing.js` → `core/briefing.ts` — [`02-core.md` TODO]
- [ ] `decision-log.js` → `core/decision-log.ts` — [`02-core.md` TODO]
- [ ] `signal-tracker.js` → `core/signal-tracker.ts` — [`02-core.md` TODO]
- [ ] `signal-weights.js` → `core/signal-weights.ts` — [`02-core.md` TODO]


#### `briefing.js` → `core/briefing.ts`

> Doc: [`docs/migration/02-core.md` TODO (not yet read)]

Source: `briefing.js` (not yet read — TODO)


#### `decision-log.js` → `core/decision-log.ts`

> Doc: [`docs/migration/02-core.md` TODO (not yet read)]

Source: `decision-log.js` (not yet read — TODO)


#### `signal-tracker.js` → `core/signal-tracker.ts`

> Doc: [`docs/migration/02-core.md` TODO (not yet read)]

Source: `signal-tracker.js` (not yet read — TODO)


#### `signal-weights.js` → `core/signal-weights.ts`

> Doc: [`docs/migration/02-core.md` TODO (not yet read)]

Source: `signal-weights.js` (not yet read — TODO)


#### `logger.js` → `utils/logger.ts`

> Doc: README only — [`docs/migration/README.md:107`](../docs/migration/README.md)

Source: `logger.js` (not yet read — TODO)


#### `setup.js` → `setup.ts`

> Doc: README only — [`docs/migration/README.md:107`](../docs/migration/README.md)

Source: `setup.js` (not yet read — TODO)


#### `cli.js` → `cli.ts`

> Doc: [`docs/migration/02-core.md:232-?`](../docs/migration/02-core.md#cli.ts)

Source: `cli.js` (676 lines — not yet read in this pass — TODO)


#### `hivemind.js` → `external/hivemind/index.ts`

> Doc: [`docs/migration/01-external.md` TODO (not yet read)]

Source: `hivemind.js` (not yet read — TODO)

| `agent.js` | `llm/agent.ts` |
| `prompt.js` | `llm/prompt.ts` |
| `telegram.js` | `bots/telegram/index.ts` |
| `config.js` | `config/index.ts` |
| `state.js` | `core/state.ts` (+ `core/live/state.ts`) |
| `pool-memory.js` | `core/pool-memory.ts` |
| `strategy-library.js` | `core/strategy-library.ts` |
| `smart-wallets.js` | `core/smart-wallets.ts` |
| `token-blacklist.js` | `core/token-blacklist.ts` |
| `lessons.js` | `core/lessons.ts` |
| `briefing.js` | `core/briefing.ts` |
| `decision-log.js` | `core/decision-log.ts` |
| `signal-tracker.js` | `core/signal-tracker.ts` |
| `signal-weights.js` | `core/signal-weights.ts` |
| `logger.js` | `utils/logger.ts` |
| `setup.js` | `setup.ts` |
| `cli.js` | `cli.ts` |
| `hivemind.js` | `external/hivemind/index.ts` |

Checklist (see [`04-utils-config.md`](../docs/migration/04-utils-config.md) / [`01-external.md`](../docs/migration/01-external.md)):
- [ ] `runManagementCycle`, `runScreeningCycle`, `startCronJobs`
- [ ] internals: `shutdown`, `getDeterministicCloseRule`, `runBriefing`, `telegramHandler`
- [ ] agent/prompt/telegram/config/state/{trackPosition,recordClose,...}/logger/envcrypt/hivemind/{isEnabled,pullHiveMind,...}
- [ ] cli (28 subcommands); setup (3 presets)

### `tools/` Directory Layout (legacy — 19 files)
| Source | New File |
|--------|----------|
| `dlmm.js` | `external/meteora/index.ts` |
| `wallet.js` (Helius parts) | `external/helius/index.ts` |
| `wallet.js` (Jupiter parts) | `external/jupiter/index.ts` |
| `screening.js` | `external/meteora/pool-discovery.ts` |
| `chart-indicators.js` | `external/meteora/indicators.ts` |
| `compute-position-pnl.js` | `core/pnl.ts` |
| `gas-estimator.js` | `external/meteora/gas.ts` |
| `manage-virtual.js` | `core/vp/manage.ts` |
| `virtual-close-rule.js` | `core/vp/close-rule.ts` |
| `virtual-digest.js` | `core/vp/digest.ts` |
| `merge-virtual-positions.js` | `core/vp/merge.ts` |
| `position-archive.js` | `core/archive.ts` |
| `dry-run-state.js` | `core/vp/state.ts` |
| `generate-dry-run-report.js` | `core/vp/report.ts` |
| `definitions.js` | `bots/tools/definitions.ts` |
| `executor.js` | `bots/tools/executor.ts` |
| `okx.js` | `external/okx/index.ts` |
| `study.js` | `external/lpagent/index.ts` |
| `agent-meridian.js` | `external/lpagent/index.ts` |
| `token.js` | `external/jupiter/token.ts` |

### `discord-listener/` (legacy)

> Details: [`docs/migration/03-llm-bots.md`](../docs/migration/03-llm-bots.md) — Discord selfbot listener

| Source | New File |
|--------|----------|
| `discord-listener/index.js` | `bots/discord/index.ts` |
| `discord-listener/pre-checks.js` | `bots/discord/pre-checks.ts` |

### `scripts/` (legacy)

> Details: [`docs/migration/04-utils-config.md`](../docs/migration/04-utils-config.md) — utility scripts

| Source | New File |
|--------|----------|
| `scripts/envrypt.js` | `utils/envrypt.ts` |
| `scripts/measure-gas.js` | `external/meteora/measure-gas.ts` |
| `scripts/patch-anchor.js` | `utils/patch-anchor.ts` |
| `scripts/validate-slippage.js` | `core/pnl/validate-slippage.ts` |

## Key Interfaces

### `external/caller.ts`

```ts
export async function call(
  method: string,
  url: string,
  options: CallOptions
): Promise<Response>

interface CallOptions {
  body?: any;
  headers?: Record<string, string>;
  retry?: number;
  timeout?: number;
}
```

### `external/sdk.ts`

```ts
export async function getBalance(address: string): Promise<Balance>
export async function getBins(pool: string): Promise<Bins>

interface Balance { sol: number; tokens: any[]; usd: number; }
interface Bins { bins: any[]; activeBin: number; }
```

### `core/state.ts`

```ts
export async function getState(position: Position): Promise<StateManager> {
  if (position.vp_id !== undefined) return import("./vp/state");
  return import("./live/state");
}

interface Position { vp_id?: string; [key: string]: any; }
interface StateManager { [key: string]: any; }
```

## Refactoring Steps

### 3.1 Create Directory Structure

```bash
mkdir -p external/{meteora,helius,jupiter,okx,lpagent,hivemind}
mkdir -p core/vp
mkdir -p llm
mkdir -p bots/{tools,discord}
mkdir -p utils config test
```

### 3.2 Bootstrap TypeScript Config

```bash
npx tsc --init
# Adjust tsconfig.json: moduleResolution, target, outDir, rootDir, strict
```

### 3.3 Core Interfaces First

Copy `external/caller.ts` and `external/sdk.ts` stubs. They give every other module something to import against.

### 3.4 Migrate by Layer (not by file)

1. `external/` adapters — keep them pure. Each file exports functions that call exactly one external API/SDK.
2. `core/` logic — move pure functions first (`pnl.ts`, `vp/close-rule.ts`), then stateful ones (`state.ts`, `vp/state.ts`).
3. `llm/` — minimal refactor, mostly rename.
4. `bots/` — update imports to use new `core/` and `external/` paths.
5. `utils/` and `config/` — late migration; they have the fewest dependencies.

### 3.5 Update Entry Points

`index.ts` → `cli.ts` → `setup.ts`. They are the integration seam; update them last.

## Testing Strategy

### 4.1 Baseline Capture

```bash
DRY_RUN=true node index.js --cycle > /tmp/baseline-telegram.txt
node -e "console.log(JSON.stringify(require('./state.json'), null, 2))" > /tmp/baseline-state.json
npm test > /tmp/baseline-tests.txt
```

### 4.2 Phase-by-Phase Verification

```bash
# Phase 1: External adapters
npm test -- test/test-screening.ts
DRY_RUN=true npm test
diff /tmp/baseline-telegram.txt <(DRY_RUN=true node index.js --cycle)
diff /tmp/baseline-state.json <(node -e "console.log(JSON.stringify(require('./state.json'), null, 2))"))

# Phase 2: Core modules
npm test -- test/test-compute-position-pnl.ts
npm test -- test/test-vp-pnl.ts
npm test -- test/test-screening.ts

# Phase 3: Import updates
npx tsc --noEmit && npm test

# Phase 4: Full cycle
DRY_RUN=true npm start -- --cycle
```

### 4.3 Output Verification Checklist

- [ ] Telegram output matches baseline (pool screening, position status)
- [ ] `state.json` matches baseline (position registry)
- [ ] VP archive matches baseline (`dry-run-state.json`)
- [ ] All unit tests pass
- [ ] Integration tests pass
- [ ] TypeScript compiles (`npx tsc --noEmit`)
- [ ] DRY_RUN mode works identically
- [ ] No functional regression in PnL calculations

## Migration Status

| Phase | Files | Status |
|-------|-------|--------|
| TypeScript bootstrap | tsconfig, build scripts | Pending |
| External API adapters | `external/` | Pending |
| Core business logic | `core/` | Pending |
| LLM integration | `llm/` | Pending |
| Bot platforms | `bots/` | Pending |
| Utils & config | `utils/`, `config/` | Pending |
| Tests | `test/` | Pending |

## Summary

Total files to migrate: ~48 (`.js` → `.ts`)

- `external/`: 11 files (9 unique adapters + 2 splits for `wallet.js` and `agent-meridian.js`)
- `core/`: 21 files
- `llm/`: 2 files
- `bots/`: 5 files
- `utils/`: 3 files
- `config/`: 4 files (incl. 3 non-code)
- Entry points: 3 files

**Branch:** `git checkout -b refactor`
