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

/**
 * Operational position shape used by the management cycle.
 * Includes PnL, fees, range state — the canonical type for live position data.
 */
export interface LivePosition {
  position: string;
  pool: string;
  pair: string;
  pnl_pct: number | null;
  pnl_pct_suspicious?: boolean;
  unclaimed_fees_usd: number | null;
  total_value_usd: number | null;
  fee_per_tvl_24h: number | null;
  lower_bin: number;
  upper_bin: number;
  active_bin: number | null;
  minutes_out_of_range: number;
  in_range: boolean | null;
  age_minutes: number | null;
  instruction?: string | null;
  pnl_usd?: number | null;
  recall?: any;
  [key: string]: any;
}

/** Return type for getMyPositions() */
export interface PositionsResult {
  wallet: string | null;
  total_positions: number;
  positions: LivePosition[];
  request_id?: string | null;
  error?: string;
}

/** Simpler position shape for getWalletPositions() — lacks management-cycle fields */
export interface WalletPosition {
  position: string;
  pool: string;
  lower_bin: number | null;
  upper_bin: number | null;
  active_bin: number | null;
  in_range: boolean | null;
  unclaimed_fees_usd: number;
  total_value_usd: number;
  pnl_usd: number;
  pnl_pct: number;
  age_minutes: number | null;
  [key: string]: any;
}

/** Return type for getWalletPositions() */
export interface WalletPositionsResult {
  wallet: string;
  total_positions: number;
  positions: WalletPosition[];
  error?: string;
}

/**
 * Result of a VP management cycle action.
 * Canonical type — replaces VPResult (manage.ts) and VpCycleResult (vp/manage.ts).
 */
export interface VpResult {
  id?: string;
  pair: string;
  action: "CLOSED" | "STAY";
  reason?: string;
  age_minutes?: number;
  pnl_pct?: number;
  pnl_usd?: number;
  pnl_sol_pct?: number;
  pnl_sol?: number;
  il_sol?: number;
  unclaimed_fees_sol?: number;
  cost_sol?: number;
  il_usd?: number;
  unclaimed_fees_usd?: number;
  cost_usd?: number;
  value_sol?: number;
  value_usd?: number;
  oor?: string;
  [key: string]: any;
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
  result?: unknown;
  [key: string]: unknown;
}

// ─── Decision Log ──────────────────────────────────────────────

export interface DecisionEntry {
  type?: string;
  actor?: string;
  pool?: string;
  pool_name?: string;
  position?: string | null;
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

// ─── Virtual Position ──────────────────────────────────────────

export interface VirtualPosition {
  id: string;
  pool: string;
  pair?: string;
  pool_name?: string;
  base_mint?: string;
  lower_bin?: number;
  upper_bin?: number;
  deployed_at?: string;
  [key: string]: unknown;
}

export interface VpSnapshot {
  pnl_pct?: number;
  pnl_sol_pct?: number;
  [key: string]: unknown;
}

// ─── Strategy Library ──────────────────────────────────────────

export interface StrategyEntry {
  id: string;
  name: string;
  author: string;
  lp_strategy: string;
  token_criteria: Record<string, unknown>;
  entry: Record<string, unknown>;
  range: Record<string, unknown>;
  exit: Record<string, unknown>;
  best_for: string;
  raw?: string;
  added_at?: string;
  updated_at?: string;
}

export interface StrategyDB {
  active: string | null;
  strategies: Record<string, StrategyEntry>;
}

// ─── Signal Weights ────────────────────────────────────────────

export interface SignalWeightChange {
  signal: string;
  from: number;
  to: number;
  lift: number;
  action: string;
}

export interface SignalWeightHistoryEntry {
  timestamp: string;
  changes: SignalWeightChange[];
  window_size: number;
  win_count: number;
  loss_count: number;
}

export interface SignalWeightsDB {
  weights: Record<string, number>;
  last_recalc: string | null;
  recalc_count: number;
  history: SignalWeightHistoryEntry[];
}

// ─── Smart Wallets ─────────────────────────────────────────────

export interface SmartWallet {
  name: string;
  address: string;
  category: string;
  type: string;
  addedAt?: string;
}

export interface SmartWalletsDB {
  wallets: SmartWallet[];
}

// ─── Pool Memory ───────────────────────────────────────────────

export interface PoolDeploy {
  deployed_at: string | null;
  closed_at: string;
  pnl_pct: number | null;
  pnl_usd: number | null;
  fees_earned_usd: number | null;
  fees_earned_sol: number | null;
  fee_earned_pct: number | null;
  range_efficiency: number | null;
  minutes_held: number | null;
  close_reason: string | null;
  strategy: string | null;
  volatility_at_deploy: number | null;
}

export interface PoolSnapshot {
  ts: string;
  position: string;
  pnl_pct: number | null;
  pnl_usd: number | null;
  in_range: boolean | null;
  unclaimed_fees_usd: number | null;
  minutes_out_of_range: number | null;
  age_minutes: number | null;
}

export interface PoolNote {
  note: string;
  added_at: string;
}

export interface PoolMemoryEntry {
  name: string;
  base_mint: string | null;
  deploys: PoolDeploy[];
  total_deploys: number;
  avg_pnl_pct: number;
  win_rate: number;
  adjusted_win_rate: number;
  adjusted_win_rate_sample_count: number;
  last_deployed_at: string | null;
  last_outcome: string | null;
  notes: PoolNote[];
  snapshots?: PoolSnapshot[];
  cooldown_until?: string;
  cooldown_reason?: string;
  base_mint_cooldown_until?: string;
  base_mint_cooldown_reason?: string;
}

// ─── Lessons ───────────────────────────────────────────────────

export interface Lesson {
  id: number;
  rule: string;
  tags: string[];
  outcome: string;
  sourceType?: string;
  pinned?: boolean;
  role?: string | null;
  confidence?: number;
  context?: string;
  pnl_pct?: number;
  fees_earned_usd?: number;
  initial_value_usd?: number;
  range_efficiency?: number;
  close_reason?: string;
  pool?: string;
  created_at?: string;
}

export interface PerformanceRecord {
  position?: string;
  pool?: string;
  pool_name?: string;
  strategy?: string;
  bin_range?: number | Record<string, unknown>;
  bin_step?: number;
  volatility?: number;
  fee_tvl_ratio?: number;
  organic_score?: number;
  amount_sol?: number;
  fees_earned_usd?: number;
  fees_earned_sol?: number;
  final_value_usd?: number;
  initial_value_usd?: number;
  minutes_in_range?: number;
  minutes_held?: number;
  close_reason?: string;
  base_mint?: string;
  deployed_at?: string;
  signal_snapshot?: Record<string, unknown>;
  pnl_usd?: number;
  pnl_pct?: number;
  range_efficiency?: number;
  recorded_at?: string;
  [key: string]: unknown;
}

export interface LessonsDB {
  lessons: Lesson[];
  performance: PerformanceRecord[];
}

// ─── Pool Candidate Filter ─────────────────────────────────────

export interface PoolCandidateFilter {
  pool_address: string;
}
