// config/index.ts — Runtime configuration & env loading
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { Config } from "../types/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");
const DEFAULT_HIVEMIND_URL = "https://api.agentmeridian.xyz";
const DEFAULT_AGENT_MERIDIAN_API_URL = "https://api.agentmeridian.xyz/api";
const DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY = "bWVyaWRpYW4taXMtdGhlLWJlc3QtYWdlbnRz";
const DEFAULT_HIVEMIND_API_KEY = DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY;

const u: Record<string, unknown> = fs.existsSync(USER_CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
  : {};

export const MIN_SAFE_BINS_BELOW = 35;

function numericConfig(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const legacyBinsBelow = numericConfig(u.binsBelow);
const configuredMinBinsBelow = numericConfig(u.minBinsBelow) ?? MIN_SAFE_BINS_BELOW;
const configuredMaxBinsBelow = numericConfig(u.maxBinsBelow)
  ?? (legacyBinsBelow != null ? Math.max(legacyBinsBelow, configuredMinBinsBelow) : 69);
const configuredDefaultBinsBelow = numericConfig(u.defaultBinsBelow) ?? legacyBinsBelow ?? configuredMaxBinsBelow;
const strategyMinBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(configuredMinBinsBelow));
const strategyMaxBinsBelow = Math.max(strategyMinBinsBelow, Math.round(configuredMaxBinsBelow));
const strategyDefaultBinsBelow = Math.max(
  strategyMinBinsBelow,
  Math.min(strategyMaxBinsBelow, Math.round(configuredDefaultBinsBelow)),
);

// Apply wallet/RPC from user-config if not already in env
if (u.rpcUrl)    process.env.RPC_URL            ||= u.rpcUrl as string;
if (u.walletKey) process.env.WALLET_PRIVATE_KEY ||= u.walletKey as string;
if (u.llmModel)  process.env.LLM_MODEL          ||= u.llmModel as string;
if (u.llmBaseUrl) process.env.LLM_BASE_URL      ||= u.llmBaseUrl as string;
if (u.llmApiKey)  process.env.LLM_API_KEY       ||= u.llmApiKey as string;
if (u.dryRun !== undefined) process.env.DRY_RUN ||= String(u.dryRun);
if (u.publicApiKey) process.env.PUBLIC_API_KEY ||= u.publicApiKey as string;
if (u.agentMeridianApiUrl) process.env.AGENT_MERIDIAN_API_URL ||= u.agentMeridianApiUrl as string;

const indicatorUserConfig = (u.chartIndicators ?? {}) as Record<string, unknown>;

function nonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

export const config: Config = {
  // ─── Risk Limits ─────────────────────────
  risk: {
    maxPositions:    (u.maxPositions as number)    ?? 3,
    maxDeployAmount: (u.maxDeployAmount as number) ?? 50,
  },

  // ─── Pool Screening Thresholds ───────────
  screening: {
    excludeHighSupplyConcentration: (u.excludeHighSupplyConcentration as boolean) ?? true,
    minFeeActiveTvlRatio: (u.minFeeActiveTvlRatio as number) ?? 0.05,
    minTvl:            (u.minTvl as number)            ?? 10_000,
    maxTvl:            u.maxTvl !== undefined ? (u.maxTvl as number) : 150_000,
    minVolume:         (u.minVolume as number)         ?? 500,
    minOrganic:        (u.minOrganic as number)        ?? 60,
    minQuoteOrganic:   (u.minQuoteOrganic as number)   ?? 60,
    minHolders:        (u.minHolders as number)        ?? 500,
    minMcap:           (u.minMcap as number)           ?? 150_000,
    maxMcap:           (u.maxMcap as number)           ?? 10_000_000,
    minBinStep:        (u.minBinStep as number)        ?? 80,
    maxBinStep:        (u.maxBinStep as number)        ?? 125,
    timeframe:         (u.timeframe as string)         ?? "5m",
    category:          (u.category as string)          ?? "trending",
    minTokenFeesSol:   (u.minTokenFeesSol as number)   ?? 30,
    useDiscordSignals: (u.useDiscordSignals as boolean) ?? false,
    discordSignalMode: (u.discordSignalMode as "merge" | "only") ?? "merge",
    avoidPvpSymbols:   (u.avoidPvpSymbols as boolean)   ?? true,
    blockPvpSymbols:   (u.blockPvpSymbols as boolean)   ?? false,
    maxBundlePct:      (u.maxBundlePct as number)      ?? 30,
    maxBotHoldersPct:  (u.maxBotHoldersPct as number)  ?? 30,
    maxTop10Pct:       (u.maxTop10Pct as number)       ?? 60,
    allowedLaunchpads: (u.allowedLaunchpads as string[]) ?? [],
    blockedLaunchpads:  (u.blockedLaunchpads as string[])  ?? [],
    minTokenAgeHours:   (u.minTokenAgeHours as number)   ?? null,
    maxTokenAgeHours:   (u.maxTokenAgeHours as number)   ?? null,
    athFilterPct:       (u.athFilterPct as number)       ?? null,
    maxDevRugCount:     (u.maxDevRugCount as number)     ?? 2,
    okxFailClosed:      (u.okxFailClosed as boolean)      ?? false,
  },

  // ─── Position Management ────────────────
  management: {
    minClaimAmount:        (u.minClaimAmount as number)        ?? 5,
    autoSwapAfterClaim:    (u.autoSwapAfterClaim as boolean)    ?? false,
    outOfRangeBinsToClose: (u.outOfRangeBinsToClose as number) ?? 10,
    outOfRangeWaitMinutes: (u.outOfRangeWaitMinutes as number) ?? 30,
    oorCooldownTriggerCount: (u.oorCooldownTriggerCount as number) ?? 3,
    oorCooldownHours:       (u.oorCooldownHours as number)       ?? 12,
    repeatDeployCooldownEnabled: (u.repeatDeployCooldownEnabled as boolean) ?? true,
    repeatDeployCooldownTriggerCount: (u.repeatDeployCooldownTriggerCount as number) ?? 3,
    repeatDeployCooldownHours: (u.repeatDeployCooldownHours as number) ?? 12,
    repeatDeployCooldownScope: (u.repeatDeployCooldownScope as "pool" | "token" | "both") ?? "token",
    repeatDeployCooldownMinFeeEarnedPct: (u.repeatDeployCooldownMinFeeEarnedPct as number) ?? (u.repeatDeployCooldownMinFeeYieldPct as number) ?? 0,
    minVolumeToRebalance:  (u.minVolumeToRebalance as number)  ?? 1000,
    stopLossPct:           (u.stopLossPct as number)           ?? (u.emergencyPriceDropPct as number) ?? -50,
    takeProfitPct:         (u.takeProfitPct as number)         ?? (u.takeProfitFeePct as number) ?? 5,
    minFeePerTvl24h:       (u.minFeePerTvl24h as number)       ?? 7,
    minAgeBeforeYieldCheck: (u.minAgeBeforeYieldCheck as number) ?? 60,
    minSolToOpen:          (u.minSolToOpen as number)          ?? 0.55,
    deployAmountSol:       (u.deployAmountSol as number)       ?? 0.5,
    gasReserve:            (u.gasReserve as number)            ?? 0.2,
    rentBuffer:            (u.rentBuffer as number)            ?? 0.15,
    positionSizePct:       (u.positionSizePct as number)       ?? 0.35,
    trailingTakeProfit:    (u.trailingTakeProfit as boolean)    ?? true,
    trailingTriggerPct:    (u.trailingTriggerPct as number)    ?? 3,
    trailingDropPct:       (u.trailingDropPct as number)       ?? 1.5,
    pnlSanityMaxDiffPct:   (u.pnlSanityMaxDiffPct as number)   ?? 5,
    solMode:               (u.solMode as boolean)               ?? false,
    vpGasCostSol:          (u.vpGasCostSol as number)          ?? 0.0002,
    vpSlippagePct:         (u.vpSlippagePct as number)         ?? 0.3,
    vpSlippagePctUnreliable: (u.vpSlippagePctUnreliable as number) ?? 2.0,
    vpTrendExitCycles:     (u.vpTrendExitCycles as number)     ?? 3,
  },

  // ─── Strategy Mapping ───────────────────
  strategy: {
    strategy:     (u.strategy as string)     ?? "bid_ask",
    minBinsBelow: strategyMinBinsBelow,
    maxBinsBelow: strategyMaxBinsBelow,
    defaultBinsBelow: strategyDefaultBinsBelow,
  },

  // ─── Scheduling ─────────────────────────
  schedule: {
    managementIntervalMin:  (u.managementIntervalMin as number)  ?? 10,
    screeningIntervalMin:   (u.screeningIntervalMin as number)   ?? 30,
    healthCheckIntervalMin: (u.healthCheckIntervalMin as number) ?? 60,
  },

  // ─── LLM Settings ──────────────────────
  llm: {
    temperature: (u.temperature as number) ?? 0.373,
    maxTokens:   (u.maxTokens as number)   ?? 4096,
    maxSteps:    (u.maxSteps as number)    ?? 20,
    managementModel: (u.managementModel as string) ?? process.env.LLM_MODEL ?? "openrouter/healer-alpha",
    screeningModel:  (u.screeningModel as string)  ?? process.env.LLM_MODEL ?? "openrouter/hunter-alpha",
    generalModel:    (u.generalModel as string)    ?? process.env.LLM_MODEL ?? "openrouter/healer-alpha",
    thinkingManagement: (u.thinkingManagement as boolean) ?? false,
    thinkingScreening:  (u.thinkingScreening as boolean)  ?? true,
    thinkingGeneral:    (u.thinkingGeneral as boolean)    ?? false,
  },

  // ─── Darwinian Signal Weighting ───────
  darwin: {
    enabled:        (u.darwinEnabled as boolean)     ?? true,
    windowDays:     (u.darwinWindowDays as number)  ?? 60,
    recalcEvery:    (u.darwinRecalcEvery as number) ?? 5,
    boostFactor:    (u.darwinBoost as number)       ?? 1.05,
    decayFactor:    (u.darwinDecay as number)       ?? 0.95,
    weightFloor:    (u.darwinFloor as number)       ?? 0.3,
    weightCeiling:  (u.darwinCeiling as number)     ?? 2.5,
    minSamples:     (u.darwinMinSamples as number)  ?? 10,
  },

  // ─── Common Token Mints ────────────────
  tokens: {
    SOL:  "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  },

  // ─── HiveMind ─────────────────────────
  hiveMind: {
    url: nonEmptyString(u.hiveMindUrl, DEFAULT_HIVEMIND_URL) ?? DEFAULT_HIVEMIND_URL,
    apiKey: nonEmptyString(u.hiveMindApiKey, process.env.HIVEMIND_API_KEY, DEFAULT_HIVEMIND_API_KEY) ?? DEFAULT_HIVEMIND_API_KEY,
    agentId: (u.agentId as string) ?? null,
    pullMode: (u.hiveMindPullMode as string) ?? "auto",
  },

  api: {
    url: nonEmptyString(u.agentMeridianApiUrl, process.env.AGENT_MERIDIAN_API_URL, DEFAULT_AGENT_MERIDIAN_API_URL) ?? DEFAULT_AGENT_MERIDIAN_API_URL,
    publicApiKey: nonEmptyString(u.publicApiKey, process.env.PUBLIC_API_KEY, DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY) ?? DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY,
    lpAgentRelayEnabled: (u.lpAgentRelayEnabled as boolean) ?? false,
  },

  jupiter: {
    apiKey: process.env.JUPITER_API_KEY ?? "",
    referralAccount:
      process.env.JUPITER_REFERRAL_ACCOUNT ??
      "9MzhDUnq3KxecyPzvhguQMMPbooXQ3VAoCMPDnoijwey",
    referralFeeBps: Number(
      process.env.JUPITER_REFERRAL_FEE_BPS ?? 50,
    ),
  },

  indicators: {
    enabled: (indicatorUserConfig.enabled as boolean) ?? false,
    entryPreset: (indicatorUserConfig.entryPreset as string) ?? "supertrend_break",
    exitPreset: (indicatorUserConfig.exitPreset as string) ?? "supertrend_break",
    rsiLength: (indicatorUserConfig.rsiLength as number) ?? 2,
    intervals: Array.isArray(indicatorUserConfig.intervals)
      ? (indicatorUserConfig.intervals as string[])
      : ["5_MINUTE"],
    candles: (indicatorUserConfig.candles as number) ?? 298,
    rsiOversold: (indicatorUserConfig.rsiOversold as number) ?? 30,
    rsiOverbought: (indicatorUserConfig.rsiOverbought as number) ?? 80,
    requireAllIntervals: (indicatorUserConfig.requireAllIntervals as boolean) ?? false,
  },
};

// Deprecation warning for legacy vpSlippagePct config key.
if (u.vpSlippagePct !== undefined) {
  console.warn(
    "[config] management.vpSlippagePct is deprecated and unused " +
    "(replaced by real-depth estimation in estimateSlippageLamports). " +
    "Remove it from user-config.json. The unreliable-data fallback now " +
    "uses management.vpSlippagePctUnreliable (default 2.0).",
  );
}

/**
 * Compute the optimal deploy amount for a given wallet balance.
 * Scales position size with wallet growth (compounding).
 *
 * Formula: clamp(deployable × positionSizePct, floor=deployAmountSol, ceil=maxDeployAmount)
 *
 * Examples (defaults: gasReserve=0.2, positionSizePct=0.35, floor=0.5):
 *   0.8 SOL wallet → 0.6 SOL deploy  (floor)
 *   2.0 SOL wallet → 0.63 SOL deploy
 *   3.0 SOL wallet → 0.98 SOL deploy
 *   4.0 SOL wallet → 1.33 SOL deploy
 */
export function computeDeployAmount(walletSol: number): number {
  const gasReserve = config.management.gasReserve      ?? 0.2;
  const rentBuffer = config.management.rentBuffer      ?? 0.15;
  const pct        = config.management.positionSizePct ?? 0.35;
  const floor      = config.management.deployAmountSol;
  const ceil       = config.risk.maxDeployAmount;
  const deployable = Math.max(0, walletSol - gasReserve - rentBuffer);
  const dynamic    = deployable * pct;
  const result     = Math.min(ceil, Math.max(floor, dynamic));
  return parseFloat(result.toFixed(2));
}

/**
 * Reload user-config.json and apply updated screening thresholds to the
 * in-memory config object. Called after threshold evolution so the next
 * agent cycle uses the evolved values without a restart.
 */
export function reloadScreeningThresholds(): void {
  try {
    if (!fs.existsSync(USER_CONFIG_PATH)) return;
    const fresh: Record<string, unknown> = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
    const s = config.screening;
    if (fresh.minFeeActiveTvlRatio != null) s.minFeeActiveTvlRatio = fresh.minFeeActiveTvlRatio as number;
    if (fresh.minTokenFeesSol  != null) s.minTokenFeesSol  = fresh.minTokenFeesSol as number;
    if (fresh.maxTop10Pct      != null) s.maxTop10Pct      = fresh.maxTop10Pct as number;
    if (fresh.useDiscordSignals !== undefined) s.useDiscordSignals = fresh.useDiscordSignals as boolean;
    if (fresh.discordSignalMode != null) s.discordSignalMode = fresh.discordSignalMode as "merge" | "only";
    if (fresh.excludeHighSupplyConcentration !== undefined) s.excludeHighSupplyConcentration = fresh.excludeHighSupplyConcentration as boolean;
    if (fresh.minOrganic     != null) s.minOrganic     = fresh.minOrganic as number;
    if (fresh.minQuoteOrganic != null) s.minQuoteOrganic = fresh.minQuoteOrganic as number;
    if (fresh.minHolders     != null) s.minHolders     = fresh.minHolders as number;
    if (fresh.minMcap        != null) s.minMcap        = fresh.minMcap as number;
    if (fresh.maxMcap        != null) s.maxMcap        = fresh.maxMcap as number;
    if (fresh.minTvl         != null) s.minTvl         = fresh.minTvl as number;
    if (fresh.maxTvl         !== undefined) s.maxTvl   = fresh.maxTvl as number;
    if (fresh.minVolume      != null) s.minVolume      = fresh.minVolume as number;
    if (fresh.minBinStep     != null) s.minBinStep     = fresh.minBinStep as number;
    if (fresh.maxBinStep     != null) s.maxBinStep     = fresh.maxBinStep as number;
    if (fresh.timeframe         != null) s.timeframe         = fresh.timeframe as string;
    if (fresh.category          != null) s.category          = fresh.category as string;
    if (fresh.minTokenAgeHours  !== undefined) s.minTokenAgeHours = fresh.minTokenAgeHours as number | null;
    if (fresh.maxTokenAgeHours  !== undefined) s.maxTokenAgeHours = fresh.maxTokenAgeHours as number | null;
    if (fresh.athFilterPct      !== undefined) s.athFilterPct     = fresh.athFilterPct as number | null;
    if (fresh.maxBundlePct      != null) s.maxBundlePct     = fresh.maxBundlePct as number;
    if (fresh.avoidPvpSymbols   !== undefined) s.avoidPvpSymbols = fresh.avoidPvpSymbols as boolean;
    if (fresh.blockPvpSymbols   !== undefined) s.blockPvpSymbols = fresh.blockPvpSymbols as boolean;
    if (fresh.maxBotHoldersPct  != null) s.maxBotHoldersPct = fresh.maxBotHoldersPct as number;
    if (fresh.allowedLaunchpads !== undefined) s.allowedLaunchpads = fresh.allowedLaunchpads as string[];
    if (fresh.maxDevRugCount    != null) s.maxDevRugCount    = fresh.maxDevRugCount as number;
    if (fresh.okxFailClosed     !== undefined) s.okxFailClosed  = fresh.okxFailClosed as boolean;
    if (fresh.blockedLaunchpads !== undefined) s.blockedLaunchpads = fresh.blockedLaunchpads as string[];
    const minBinsBelow = numericConfig(fresh.minBinsBelow) ?? config.strategy.minBinsBelow;
    const maxBinsBelow = numericConfig(fresh.maxBinsBelow) ?? numericConfig(fresh.binsBelow) ?? config.strategy.maxBinsBelow;
    const defaultBinsBelow = numericConfig(fresh.defaultBinsBelow) ?? numericConfig(fresh.binsBelow) ?? config.strategy.defaultBinsBelow ?? maxBinsBelow;
    config.strategy.minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(minBinsBelow!));
    config.strategy.maxBinsBelow = Math.max(config.strategy.minBinsBelow, Math.round(maxBinsBelow!));
    config.strategy.defaultBinsBelow = Math.max(
      config.strategy.minBinsBelow,
      Math.min(config.strategy.maxBinsBelow, Math.round(defaultBinsBelow!)),
    );
  } catch { /* ignore */ }
}
