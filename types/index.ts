// types/index.ts — Shared type definitions for Meridian

// ─── Config ────────────────────────────────────────────────────

export interface RiskConfig {
  maxPositions: number;
  maxDeployAmount: number;
}

export interface ScreeningConfig {
  excludeHighSupplyConcentration: boolean;
  minFeeActiveTvlRatio: number;
  minTvl: number;
  maxTvl: number;
  minVolume: number;
  minOrganic: number;
  minQuoteOrganic: number;
  minHolders: number;
  minMcap: number;
  maxMcap: number;
  minBinStep: number;
  maxBinStep: number;
  timeframe: string;
  category: string;
  minTokenFeesSol: number;
  useDiscordSignals: boolean;
  discordSignalMode: "merge" | "only";
  avoidPvpSymbols: boolean;
  blockPvpSymbols: boolean;
  maxBundlePct: number;
  maxBotHoldersPct: number;
  maxTop10Pct: number;
  allowedLaunchpads: string[];
  blockedLaunchpads: string[];
  minTokenAgeHours: number | null;
  maxTokenAgeHours: number | null;
  athFilterPct: number | null;
  maxDevRugCount: number;
  okxFailClosed: boolean;
}

export interface ManagementConfig {
  minClaimAmount: number;
  autoSwapAfterClaim: boolean;
  outOfRangeBinsToClose: number;
  outOfRangeWaitMinutes: number;
  oorCooldownTriggerCount: number;
  oorCooldownHours: number;
  repeatDeployCooldownEnabled: boolean;
  repeatDeployCooldownTriggerCount: number;
  repeatDeployCooldownHours: number;
  repeatDeployCooldownScope: "pool" | "token" | "both";
  repeatDeployCooldownMinFeeEarnedPct: number;
  minVolumeToRebalance: number;
  stopLossPct: number;
  takeProfitPct: number;
  minFeePerTvl24h: number;
  minAgeBeforeYieldCheck: number;
  minSolToOpen: number;
  deployAmountSol: number;
  gasReserve: number;
  rentBuffer: number;
  positionSizePct: number;
  trailingTakeProfit: boolean;
  trailingTriggerPct: number;
  trailingDropPct: number;
  pnlSanityMaxDiffPct: number;
  solMode: boolean;
  vpGasCostSol: number;
  vpSlippagePct: number;
  vpSlippagePctUnreliable: number;
  vpTrendExitCycles: number;
}

export interface StrategyConfig {
  strategy: string;
  minBinsBelow: number;
  maxBinsBelow: number;
  defaultBinsBelow: number;
}

export interface ScheduleConfig {
  managementIntervalMin: number;
  screeningIntervalMin: number;
  healthCheckIntervalMin: number;
}

export interface LlmConfig {
  temperature: number;
  maxTokens: number;
  maxSteps: number;
  managementModel: string;
  screeningModel: string;
  generalModel: string;
  thinkingManagement: boolean;
  thinkingScreening: boolean;
  thinkingGeneral: boolean;
}

export interface DarwinConfig {
  enabled: boolean;
  windowDays: number;
  recalcEvery: number;
  boostFactor: number;
  decayFactor: number;
  weightFloor: number;
  weightCeiling: number;
  minSamples: number;
}

export interface TokenMints {
  SOL: string;
  USDC: string;
  USDT: string;
}

export interface HiveMindConfig {
  url: string;
  apiKey: string;
  agentId: string | null;
  pullMode: string;
}

export interface ApiConfig {
  url: string;
  publicApiKey: string;
  lpAgentRelayEnabled: boolean;
}

export interface JupiterConfig {
  apiKey: string;
  referralAccount: string;
  referralFeeBps: number;
}

export interface IndicatorsConfig {
  enabled: boolean;
  entryPreset: string;
  exitPreset: string;
  rsiLength: number;
  intervals: string[];
  candles: number;
  rsiOversold: number;
  rsiOverbought: number;
  requireAllIntervals: boolean;
}

export interface Config {
  risk: RiskConfig;
  screening: ScreeningConfig;
  management: ManagementConfig;
  strategy: StrategyConfig;
  schedule: ScheduleConfig;
  llm: LlmConfig;
  darwin: DarwinConfig;
  tokens: TokenMints;
  hiveMind: HiveMindConfig;
  api: ApiConfig;
  jupiter: JupiterConfig;
  indicators: IndicatorsConfig;
}

// ─── Position ──────────────────────────────────────────────────

export interface Position {
  pool: string;
  baseMint: string;
  quoteMint: string;
  lowerBin: number;
  upperBin: number;
  amount: number;
  deployed_at?: string;
  closed?: boolean;
  closed_at?: string;
  vp_id?: string;
  [key: string]: unknown;
}

// ─── Pool / Screening ──────────────────────────────────────────

export interface PoolCandidate {
  pool: string;
  name: string;
  baseMint: string;
  quoteMint: string;
  fee_active_tvl_ratio: number;
  fee_tvl_ratio?: number;
  volatility: number;
  organic_score: number;
  volume_window?: number;
  active_tvl?: number;
  active_pct?: number;
  [key: string]: unknown;
}

// ─── Logger ────────────────────────────────────────────────────

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface ToolAction {
  tool: string;
  success: boolean;
  duration_ms?: number;
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
  [key: string]: unknown;
}

// ─── Decision Log ──────────────────────────────────────────────

export interface DecisionEntry {
  type?: string;
  actor?: string;
  pool?: string;
  pool_name?: string;
  position?: string;
  summary?: string;
  reason?: string;
  risks?: string[];
  metrics?: Record<string, unknown>;
  rejected?: string[];
}

export interface Decision {
  id: string;
  ts: string;
  type: string;
  actor: string;
  pool: string | null;
  pool_name: string | null;
  position: string | null;
  summary: string | null;
  reason: string | null;
  risks: string[];
  metrics: Record<string, unknown>;
  rejected: string[];
}

// ─── Blacklist ─────────────────────────────────────────────────

export interface BlacklistEntry {
  symbol: string;
  reason: string;
  added_at: string;
  added_by: string;
}

export interface BlocklistEntry {
  label: string;
  reason: string;
  added_at: string;
}

// ─── Performance ───────────────────────────────────────────────

export interface PerformanceSummary {
  total_positions_closed: number;
  total_pnl_usd: number;
  avg_pnl_pct: number;
  avg_range_efficiency_pct: number;
  win_rate_pct: number;
  total_lessons: number;
}

// ─── Secure Env ────────────────────────────────────────────────

export interface SecureEnvOptions {
  envPath?: string;
  keyPath?: string;
  override?: boolean;
}

export interface EncryptRawOptions {
  rawPath?: string;
  outPath?: string;
  keyPath?: string;
}
