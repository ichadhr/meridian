// config/index.ts — Runtime configuration & env loading
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { Config } from "../types/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(process.cwd(), "user-config.json");
const DEFAULT_HIVEMIND_URL = "https://api.agentmeridian.xyz";
const DEFAULT_AGENT_MERIDIAN_API_URL = "https://api.agentmeridian.xyz/api";
const DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY = "bWVyaWRpYW4taXMtdGhlLWJlc3QtYWdlbnRz";
const DEFAULT_HIVEMIND_API_KEY = DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY;

const u: Record<string, unknown> = fs.existsSync(USER_CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
  : {};

export const MIN_SAFE_BINS_BELOW = 35;

// ─── JSON File Helpers ─────────────────────────────────────────

/** Load a JSON file with a fallback default. */
export function loadJsonRecord<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Save a value as JSON to a file. */
export function saveJsonRecord(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

// ─── Config Helpers ────────────────────────────────────────────

function numericConfig(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Read a number from user config with fallback default. */
function num(key: string, def: number): number {
  const v = Number(u[key]);
  return Number.isFinite(v) ? v : def;
}

/** Read a string from user config with fallback default. */
function str(key: string, def: string): string {
  const v = u[key];
  return typeof v === "string" && v.trim() ? v.trim() : def;
}

/** Read a boolean from user config with fallback default. */
function bool(key: string, def: boolean): boolean {
  const v = u[key];
  return typeof v === "boolean" ? v : def;
}

/** Read a nullable number from user config (null = no minimum/maximum). */
function optNum(key: string): number | null {
  const v = u[key];
  if (v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Read a nullable boolean from user config. */
function optBool(key: string): boolean | undefined {
  const v = u[key];
  return typeof v === "boolean" ? v : undefined;
}

/** Read a string array from user config with fallback default. */
function strArray(key: string, def: string[]): string[] {
  const v = u[key];
  return Array.isArray(v) ? v : def;
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
    maxPositions:    num("maxPositions", 3),
    maxDeployAmount: num("maxDeployAmount", 50),
  },

  // ─── Pool Screening Thresholds ───────────
  screening: {
    excludeHighSupplyConcentration: bool("excludeHighSupplyConcentration", true),
    minFeeActiveTvlRatio: num("minFeeActiveTvlRatio", 0.05),
    minTvl:            num("minTvl", 10_000),
    maxTvl:            u.maxTvl !== undefined ? num("maxTvl", 150_000) : 150_000,
    minVolume:         num("minVolume", 500),
    minOrganic:        num("minOrganic", 60),
    minQuoteOrganic:   num("minQuoteOrganic", 60),
    minHolders:        num("minHolders", 500),
    minMcap:           num("minMcap", 150_000),
    maxMcap:           num("maxMcap", 10_000_000),
    minBinStep:        num("minBinStep", 80),
    maxBinStep:        num("maxBinStep", 125),
    timeframe:         str("timeframe", "5m"),
    category:          str("category", "trending"),
    minTokenFeesSol:   num("minTokenFeesSol", 30),
    useDiscordSignals: bool("useDiscordSignals", false),
    discordSignalMode: (str("discordSignalMode", "merge") as "merge" | "only"),
    avoidPvpSymbols:   bool("avoidPvpSymbols", true),
    blockPvpSymbols:   bool("blockPvpSymbols", false),
    maxBundlePct:      num("maxBundlePct", 30),
    maxBotHoldersPct:  num("maxBotHoldersPct", 30),
    maxTop10Pct:       num("maxTop10Pct", 60),
    allowedLaunchpads: strArray("allowedLaunchpads", []),
    blockedLaunchpads:  strArray("blockedLaunchpads", []),
    minTokenAgeHours:   optNum("minTokenAgeHours"),
    maxTokenAgeHours:   optNum("maxTokenAgeHours"),
    athFilterPct:       optNum("athFilterPct"),
    maxDevRugCount:     num("maxDevRugCount", 2),
    okxFailClosed:      bool("okxFailClosed", false),
  },

  // ─── Position Management ────────────────
  management: {
    minClaimAmount:        num("minClaimAmount", 5),
    autoSwapAfterClaim:    bool("autoSwapAfterClaim", false),
    outOfRangeBinsToClose: num("outOfRangeBinsToClose", 10),
    outOfRangeWaitMinutes: num("outOfRangeWaitMinutes", 30),
    oorCooldownTriggerCount: num("oorCooldownTriggerCount", 3),
    oorCooldownHours:       num("oorCooldownHours", 12),
    repeatDeployCooldownEnabled: bool("repeatDeployCooldownEnabled", true),
    repeatDeployCooldownTriggerCount: num("repeatDeployCooldownTriggerCount", 3),
    repeatDeployCooldownHours: num("repeatDeployCooldownHours", 12),
    repeatDeployCooldownScope: (str("repeatDeployCooldownScope", "token") as "pool" | "token" | "both"),
    repeatDeployCooldownMinFeeEarnedPct: num("repeatDeployCooldownMinFeeEarnedPct", num("repeatDeployCooldownMinFeeYieldPct", 0)),
    minVolumeToRebalance:  num("minVolumeToRebalance", 1000),
    stopLossPct:           num("stopLossPct", num("emergencyPriceDropPct", -50)),
    takeProfitPct:         num("takeProfitPct", num("takeProfitFeePct", 5)),
    minFeePerTvl24h:       num("minFeePerTvl24h", 7),
    minAgeBeforeYieldCheck: num("minAgeBeforeYieldCheck", 60),
    minSolToOpen:          num("minSolToOpen", 0.55),
    deployAmountSol:       num("deployAmountSol", 0.5),
    gasReserve:            num("gasReserve", 0.2),
    rentBuffer:            num("rentBuffer", 0.15),
    positionSizePct:       num("positionSizePct", 0.35),
    trailingTakeProfit:    bool("trailingTakeProfit", true),
    trailingTriggerPct:    num("trailingTriggerPct", 3),
    trailingDropPct:       num("trailingDropPct", 1.5),
    pnlSanityMaxDiffPct:   num("pnlSanityMaxDiffPct", 5),
    solMode:               bool("solMode", false),
    vpGasCostSol:          num("vpGasCostSol", 0.0002),
    vpSlippagePct:         num("vpSlippagePct", 0.3),
    vpSlippagePctUnreliable: num("vpSlippagePctUnreliable", 2.0),
    vpTrendExitCycles:     num("vpTrendExitCycles", 3),
  },

  // ─── Strategy Mapping ───────────────────
  strategy: {
    strategy:     str("strategy", "bid_ask"),
    minBinsBelow: strategyMinBinsBelow,
    maxBinsBelow: strategyMaxBinsBelow,
    defaultBinsBelow: strategyDefaultBinsBelow,
  },

  // ─── Scheduling ─────────────────────────
  schedule: {
    managementIntervalMin:  num("managementIntervalMin", 10),
    screeningIntervalMin:   num("screeningIntervalMin", 30),
    healthCheckIntervalMin: num("healthCheckIntervalMin", 60),
  },

  // ─── LLM Settings ──────────────────────
  llm: {
    temperature: num("temperature", 0.373),
    maxTokens:   num("maxTokens", 4096),
    maxSteps:    num("maxSteps", 20),
    managementModel: str("managementModel", process.env.LLM_MODEL ?? "openrouter/healer-alpha"),
    screeningModel:  str("screeningModel", process.env.LLM_MODEL ?? "openrouter/hunter-alpha"),
    generalModel:    str("generalModel", process.env.LLM_MODEL ?? "openrouter/healer-alpha"),
    thinkingManagement: bool("thinkingManagement", false),
    thinkingScreening:  bool("thinkingScreening", true),
    thinkingGeneral:    bool("thinkingGeneral", false),
  },

  // ─── Darwinian Signal Weighting ───────
  darwin: {
    enabled:        bool("darwinEnabled", true),
    windowDays:     num("darwinWindowDays", 60),
    recalcEvery:    num("darwinRecalcEvery", 5),
    boostFactor:    num("darwinBoost", 1.05),
    decayFactor:    num("darwinDecay", 0.95),
    weightFloor:    num("darwinFloor", 0.3),
    weightCeiling:  num("darwinCeiling", 2.5),
    minSamples:     num("darwinMinSamples", 10),
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
    agentId: str("agentId", ""),
    pullMode: str("hiveMindPullMode", "auto"),
  },

  api: {
    url: nonEmptyString(u.agentMeridianApiUrl, process.env.AGENT_MERIDIAN_API_URL, DEFAULT_AGENT_MERIDIAN_API_URL) ?? DEFAULT_AGENT_MERIDIAN_API_URL,
    publicApiKey: nonEmptyString(u.publicApiKey, process.env.PUBLIC_API_KEY, DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY) ?? DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY,
    lpAgentRelayEnabled: bool("lpAgentRelayEnabled", false),
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

  indicators: (() => {
    const ic = (u.chartIndicators ?? {}) as Record<string, unknown>;
    return {
      enabled: typeof ic.enabled === "boolean" ? ic.enabled : false,
      entryPreset: typeof ic.entryPreset === "string" ? ic.entryPreset : "supertrend_break",
      exitPreset: typeof ic.exitPreset === "string" ? ic.exitPreset : "supertrend_break",
      rsiLength: typeof ic.rsiLength === "number" ? ic.rsiLength : 2,
      intervals: Array.isArray(ic.intervals) ? (ic.intervals as string[]) : ["5_MINUTE"],
      candles: typeof ic.candles === "number" ? ic.candles : 298,
      rsiOversold: typeof ic.rsiOversold === "number" ? ic.rsiOversold : 30,
      rsiOverbought: typeof ic.rsiOverbought === "number" ? ic.rsiOverbought : 80,
      requireAllIntervals: typeof ic.requireAllIntervals === "boolean" ? ic.requireAllIntervals : false,
    };
  })(),
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
  const gasReserve = config.management.gasReserve;
  const rentBuffer = config.management.rentBuffer;
  const pct        = config.management.positionSizePct;
  const floor      = config.management.deployAmountSol;
  const ceil       = config.risk.maxDeployAmount;
  const deployable = Math.max(0, walletSol - gasReserve - rentBuffer);
  const dynamic    = deployable * pct;
  const result     = Math.min(ceil, Math.max(floor, dynamic));
  return parseFloat(result.toFixed(2));
}

/**
 * Compute bins_below for a position based on pool volatility.
 *
 * Formula: linear interpolation between minBinsBelow and maxBinsBelow,
 * scaled by volatility (0-5 range), clamped to [minBinsBelow, maxBinsBelow].
 */
export function computeBinsBelow(volatility: any): number {
  const parsedVolatility: number = Number(volatility);
  if (!Number.isFinite(parsedVolatility) || parsedVolatility <= 0) {
    throw new Error(`Invalid volatility ${volatility ?? "unknown"} — refusing volatility-scaled deploy.`);
  }
  const lo: number = config.strategy.minBinsBelow;
  const hi: number = config.strategy.maxBinsBelow;
  return Math.max(lo, Math.min(hi, Math.round(lo + (parsedVolatility / 5) * (hi - lo))));
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
