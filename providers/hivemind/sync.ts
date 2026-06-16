import fs from "fs";
import path from "path";
import { randomBytes, randomUUID } from "crypto";
import { log } from "../../utils/logger.js";
import { config } from "../../config/index.js";

const USER_CONFIG_PATH = path.join(process.cwd(), "user-config.json");
const CACHE_PATH = path.join(process.cwd(), "hivemind-cache.json");
const PACKAGE_JSON_PATH = path.join(process.cwd(), "package.json");
const HEARTBEAT_INTERVAL_MS = 15 * 60 * 1000;

let _heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function readJson<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function sanitizeText(text: unknown, maxLen = 400): string | null {
  if (text == null) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned || null;
}

function getVersion(): string {
  try {
    return JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf8")).version || "1.0.0";
  } catch {
    return "1.0.0";
  }
}

const AGENT_VERSION = getVersion();

interface UserConfig {
  agentId?: string;
  telegramChatId?: string;
}

function readUserConfig(): UserConfig {
  return readJson<UserConfig>(USER_CONFIG_PATH, {});
}

function writeUserConfig(nextConfig: UserConfig): void {
  writeJson(USER_CONFIG_PATH, nextConfig);
}

interface HiveMindCache {
  sharedLessons: NormalizedLesson[];
  presets: unknown[];
  pulledAt: string | null;
}

function readCache(): HiveMindCache {
  return readJson<HiveMindCache>(CACHE_PATH, {
    sharedLessons: [],
    presets: [],
    pulledAt: null,
  });
}

function writeCache(nextCache: HiveMindCache): void {
  writeJson(CACHE_PATH, nextCache);
}

function getBaseUrl(): string {
  return sanitizeText(config.hiveMind?.url || "", 500) || "";
}

function getApiKey(): string {
  return sanitizeText(config.hiveMind?.apiKey || "", 300) || "";
}

function getPullMode(): "auto" | "manual" {
  const mode = sanitizeText(config.hiveMind?.pullMode || "auto", 20) || "auto";
  return mode === "manual" ? "manual" : "auto";
}

export function getHiveMindPullMode(): "auto" | "manual" {
  return getPullMode();
}

export function isHiveMindEnabled(): boolean {
  return !!(getBaseUrl() && getApiKey());
}

export function ensureAgentId(): string {
  const userConfig = readUserConfig();
  if (userConfig.agentId) {
    config.hiveMind.agentId = userConfig.agentId;
    return userConfig.agentId;
  }

  const agentId = `agt_${randomBytes(12).toString("hex")}`;
  userConfig.agentId = agentId;
  writeUserConfig(userConfig);
  config.hiveMind.agentId = agentId;
  log("hivemind", `Generated agentId ${agentId}`);
  return agentId;
}

function getAgentId(): string {
  return config.hiveMind?.agentId || ensureAgentId();
}

function buildUrl(pathname: string, query: Record<string, unknown> = {}): string {
  const url = new URL(pathname, getBaseUrl());
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, unknown>;
}

async function requestJson(
  pathname: string,
  { method = "GET", body = null, query = {} }: RequestOptions = {},
): Promise<any> {
  if (!isHiveMindEnabled()) return null;
  const response = await fetch(buildUrl(pathname, query), {
    method,
    headers: {
      accept: "application/json",
      "x-api-key": getApiKey(),
      ...(body != null ? { "content-type": "application/json" } : {}),
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || `HiveMind ${response.status}`);
  }
  return payload;
}

interface SharedLesson {
  id?: string | number;
  lessonId?: string;
  rule?: string;
  tags?: string[];
  role?: string | null;
  outcome?: string;
  sourceType?: string;
  source?: string;
  score?: number;
  confidence?: number | null;
  pool?: string | null;
  pinned?: boolean;
  created_at?: string;
  createdAt?: string;
  context?: string | null;
  entry_mcap?: number | string | null;
  entry_tvl?: number | string | null;
  entry_volume?: number | string | null;
  exit_mcap?: number | string | null;
  exit_tvl?: number | string | null;
  exit_volume?: number | string | null;
}

interface NormalizedLesson {
  id: string;
  rule: string;
  tags: string[];
  role: string | null;
  outcome: string;
  sourceType: string;
  score: number | null;
  created_at: string;
}

function normalizeSharedLesson(lesson: SharedLesson): NormalizedLesson | null {
  const rule = sanitizeText(lesson?.rule, 400);
  if (!rule) return null;
  return {
    id: String(lesson.id || lesson.lessonId || `shared_${Date.now()}`),
    rule,
    tags: Array.isArray(lesson.tags) ? lesson.tags.map((tag) => sanitizeText(tag, 48)).filter(Boolean) as string[] : [],
    role: sanitizeText(lesson.role || "", 20) || null,
    outcome: sanitizeText(lesson.outcome || "shared", 20) || "shared",
    sourceType: sanitizeText(lesson.sourceType || lesson.source || "shared", 24) || "shared",
    score: Number.isFinite(Number(lesson.score)) ? Number(lesson.score) : null,
    created_at: lesson.created_at || lesson.createdAt || new Date().toISOString(),
  };
}

export function getSharedLessonsForPrompt({
  agentType = "GENERAL",
  maxLessons = 6,
} = {}): string | null {
  const role = String(agentType || "GENERAL").toUpperCase();
  const shared = (readCache().sharedLessons || [])
    .filter((lesson) => !lesson.role || lesson.role === role || role === "GENERAL")
    .sort((left, right) => (Number(right.score) || 0) - (Number(left.score) || 0))
    .slice(0, maxLessons);

  if (!shared.length) return null;
  return shared
    .map((lesson) => `[HIVEMIND${lesson.score != null ? ` score=${lesson.score}` : ""}] ${lesson.rule}`)
    .join("\n");
}

export async function registerHiveMindAgent({
  reason = "heartbeat",
} = {}): Promise<any> {
  if (!isHiveMindEnabled()) return null;
  try {
    return await requestJson("/api/hivemind/agents/register", {
      method: "POST",
      body: {
        agentId: getAgentId(),
        version: AGENT_VERSION,
        timestamp: new Date().toISOString(),
        reason,
        capabilities: {
          telegram: !!process.env.TELEGRAM_BOT_TOKEN,
          lpagent: !!process.env.LPAGENT_API_KEY,
          dryRun: process.env.DRY_RUN === "true",
        },
      },
    });
  } catch (error: any) {
    log("hivemind_warn", `Agent register failed: ${error.message}`);
    return null;
  }
}

export async function pullHiveMindLessons(limit = 12): Promise<NormalizedLesson[] | null> {
  if (!isHiveMindEnabled()) return null;
  try {
    const payload = await requestJson("/api/hivemind/lessons/pull", {
      query: { agentId: getAgentId(), limit },
    });
    const cache = readCache();
    cache.sharedLessons = Array.isArray(payload?.lessons)
      ? (payload.lessons as SharedLesson[]).map(normalizeSharedLesson).filter((l): l is NormalizedLesson => l != null)
      : [];
    cache.pulledAt = new Date().toISOString();
    writeCache(cache);
    return cache.sharedLessons;
  } catch (error: any) {
    log("hivemind_warn", `Lesson pull failed: ${error.message}`);
    return null;
  }
}

export async function pullHiveMindPresets(): Promise<unknown[] | null> {
  if (!isHiveMindEnabled()) return null;
  try {
    const payload = await requestJson("/api/hivemind/presets/pull", {
      query: { agentId: getAgentId() },
    });
    const cache = readCache();
    cache.presets = Array.isArray(payload?.presets) ? payload.presets : [];
    cache.pulledAt = new Date().toISOString();
    writeCache(cache);
    return cache.presets;
  } catch (error: any) {
    log("hivemind_warn", `Preset pull failed: ${error.message}`);
    return null;
  }
}

export async function bootstrapHiveMind(): Promise<{
  enabled: boolean;
  agentId: string;
  pullMode: "auto" | "manual";
} | null> {
  if (!isHiveMindEnabled()) return null;
  ensureAgentId();
  const tasks = [registerHiveMindAgent({ reason: "startup" })];
  if (getPullMode() === "auto") {
    tasks.push(pullHiveMindLessons(), pullHiveMindPresets());
  }
  await Promise.allSettled(tasks);
  return { enabled: true, agentId: getAgentId(), pullMode: getPullMode() };
}

export function startHiveMindBackgroundSync(): ReturnType<typeof setInterval> | null {
  if (!isHiveMindEnabled() || _heartbeatTimer) return null;
  _heartbeatTimer = setInterval(() => {
    const tasks = [registerHiveMindAgent({ reason: "heartbeat" })];
    if (getPullMode() === "auto") {
      tasks.push(pullHiveMindLessons(), pullHiveMindPresets());
    }
    Promise.allSettled(tasks).catch(() => null);
  }, HEARTBEAT_INTERVAL_MS);
  return _heartbeatTimer;
}

function numberOrNull(value: any): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function buildMarketFields(source: any): Record<string, number | null> | null {
  const market = {
    entryMcap: numberOrNull(source?.entry_mcap),
    entryTvl: numberOrNull(source?.entry_tvl),
    entryVolume: numberOrNull(source?.entry_volume),
    exitMcap: numberOrNull(source?.exit_mcap),
    exitTvl: numberOrNull(source?.exit_tvl),
    exitVolume: numberOrNull(source?.exit_volume),
  };
  return Object.values(market).some((value) => value != null) ? market : null;
}

interface LessonEvent {
  eventId: string;
  agentId: string;
  version: string;
  timestamp: string;
  lesson: {
    id: string | null;
    rule: string;
    tags: string[];
    role: string | null;
    outcome: string;
    sourceType: string;
    confidence: number | null;
    pool: string | null;
    pinned: boolean;
    context: string | null;
    market: Record<string, number | null> | null;
    metrics: {
      pnlPct: number | null;
      feesUsd: number | null;
      initialValueUsd: number | null;
      rangeEfficiency: number | null;
      closeReason: string | null;
    };
  };
}

function buildLessonEvent(lesson: SharedLesson): LessonEvent | null {
  const rule = sanitizeText(lesson?.rule, 400);
  if (!rule) return null;
  const sourceType = sanitizeText(lesson.sourceType || inferLessonSourceType(lesson), 24) || "manual";
  const market = buildMarketFields(lesson);
  const context = sanitizeText(lesson?.context, 600);
  return {
    eventId: `lesson:${getAgentId()}:${lesson.id || randomUUID()}`,
    agentId: getAgentId(),
    version: AGENT_VERSION,
    timestamp: lesson.created_at || new Date().toISOString(),
    lesson: {
      id: lesson.id != null ? String(lesson.id) : null,
      rule,
      tags: Array.isArray(lesson.tags) ? lesson.tags.map((tag) => sanitizeText(tag, 48)).filter(Boolean) as string[] : [],
      role: sanitizeText(lesson.role || "", 20) || null,
      outcome: sanitizeText(lesson.outcome || "manual", 20) || "manual",
      sourceType,
      confidence: Number.isFinite(Number(lesson.confidence)) ? Number(lesson.confidence) : null,
      pool: sanitizeText((lesson as any).pool || "", 64) || null,
      pinned: !!(lesson as any).pinned,
      context: context || null,
      market,
      metrics: {
        pnlPct: Number.isFinite(Number((lesson as any).pnl_pct)) ? Number((lesson as any).pnl_pct) : null,
        feesUsd: Number.isFinite(Number((lesson as any).fees_earned_usd)) ? Number((lesson as any).fees_earned_usd) : null,
        initialValueUsd: Number.isFinite(Number((lesson as any).initial_value_usd)) ? Number((lesson as any).initial_value_usd) : null,
        rangeEfficiency: Number.isFinite(Number((lesson as any).range_efficiency)) ? Number((lesson as any).range_efficiency) : null,
        closeReason: sanitizeText((lesson as any).close_reason || "", 160) || null,
      },
    },
  };
}

function inferLessonSourceType(lesson: SharedLesson): string {
  const tags = Array.isArray(lesson?.tags) ? lesson.tags.map((tag) => String(tag).toLowerCase()) : [];
  const rule = String(lesson?.rule || "").toLowerCase();
  if (tags.includes("self_tune") || tags.includes("config_change") || rule.startsWith("[self-tuned]")) {
    return "config_change";
  }
  if (lesson?.outcome === "manual") {
    return "manual";
  }
  return "performance";
}

export async function pushHiveLesson(lesson: SharedLesson): Promise<any> {
  if (!isHiveMindEnabled()) return null;
  const body = buildLessonEvent(lesson);
  if (!body) return null;
  try {
    return await requestJson("/api/hivemind/lessons/push", {
      method: "POST",
      body,
    });
  } catch (error: any) {
    log("hivemind_warn", `Lesson push failed: ${error.message}`);
    return null;
  }
}

function shouldCountInAdjustedWinRate(closeReason: unknown): boolean {
  const text = String(closeReason || "").toLowerCase();
  return !(
    text.includes("out of range") ||
    text.includes("pumped far above range") ||
    text === "oor" ||
    text.includes("oor")
  );
}

interface PerformanceEvent {
  eventId?: string;
  position?: string;
  pool?: string;
  pool_name?: string;
  base_mint?: string;
  strategy?: string;
  close_reason?: string;
  pnl_usd?: number;
  pnl_pct?: number;
  fees_earned_usd?: number;
  fees_earned_sol?: number;
  minutes_held?: number;
  recorded_at?: string;
  entry_mcap?: number | string | null;
  entry_tvl?: number | string | null;
  entry_volume?: number | string | null;
  exit_mcap?: number | string | null;
  exit_tvl?: number | string | null;
  exit_volume?: number | string | null;
}

export async function pushHivePerformanceEvent(perf: PerformanceEvent): Promise<any> {
  if (!isHiveMindEnabled()) return null;
  try {
    return await requestJson("/api/hivemind/performance/push", {
      method: "POST",
      body: {
        eventId: sanitizeText(perf.eventId, 200) || `close:${getAgentId()}:${perf.position || perf.pool}:${perf.recorded_at || Date.now()}`,
        agentId: getAgentId(),
        version: AGENT_VERSION,
        timestamp: perf.recorded_at || new Date().toISOString(),
        event: {
          pool: sanitizeText(perf.pool, 64) || null,
          poolName: sanitizeText(perf.pool_name, 80) || null,
          baseMint: sanitizeText(perf.base_mint, 64) || null,
          strategy: sanitizeText(perf.strategy, 32) || null,
          closeReason: sanitizeText(perf.close_reason, 200) || "unknown",
          pnlUsd: Number(perf.pnl_usd || 0),
          pnlPct: Number(perf.pnl_pct || 0),
          feesUsd: Number(perf.fees_earned_usd || 0),
          feesSol: Number(perf.fees_earned_sol || 0),
          minutesHeld: Number(perf.minutes_held || 0),
          countInAdjustedWinRate: shouldCountInAdjustedWinRate(perf.close_reason),
          market: buildMarketFields(perf),
        },
      },
    });
  } catch (error: any) {
    log("hivemind_warn", `Performance push failed: ${error.message}`);
    return null;
  }
}
