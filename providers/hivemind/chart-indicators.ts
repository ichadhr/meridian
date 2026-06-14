import { config } from "../../config/index.js";
import { log } from "../../utils/logger.js";
import { agentMeridianJson, getAgentMeridianHeaders } from "./api.js";
import { safeNumber } from "../../utils/number.js";

const DEFAULT_INTERVALS = ["5_MINUTE"];
const DEFAULT_CANDLES = 298;

function normalizeIntervals(intervals: unknown): string[] {
  const list = Array.isArray(intervals) ? intervals : DEFAULT_INTERVALS;
  return list
    .map((value: unknown) => String(value || "").trim().toUpperCase())
    .filter((value: string) => value === "5_MINUTE" || value === "15_MINUTE");
}

function safeNum(value: unknown): number | null {
  return safeNumber(value, null);
}

interface SignalSummary {
  close: number | null;
  previousClose: number | null;
  rsi: number | null;
  lowerBand: number | null;
  middleBand: number | null;
  upperBand: number | null;
  supertrendValue: number | null;
  supertrendDirection: string;
  supertrendBreakUp: boolean;
  supertrendBreakDown: boolean;
  fib50: number | null;
  fib618: number | null;
  fib786: number | null;
}

function buildSignalSummary(payload: Record<string, unknown>): SignalSummary {
  const latest = (payload?.latest || {}) as Record<string, unknown>;
  const candle = (latest?.candle || {}) as Record<string, unknown>;
  const previousCandle = (latest?.previousCandle || {}) as Record<string, unknown>;
  const rsiVal = latest?.rsi as Record<string, unknown> | undefined;
  const rsi = safeNum(rsiVal?.value);
  const bollinger = (latest?.bollinger || {}) as Record<string, unknown>;
  const supertrend = (latest?.supertrend || {}) as Record<string, unknown>;
  const fibonacciLevels = (
    (latest?.fibonacci as Record<string, unknown>)?.levels || {}
  ) as Record<string, unknown>;
  const states = (latest?.states || {}) as Record<string, unknown>;
  return {
    close: safeNum(candle.close),
    previousClose: safeNum(previousCandle.close),
    rsi,
    lowerBand: safeNum(bollinger.lower),
    middleBand: safeNum(bollinger.middle),
    upperBand: safeNum(bollinger.upper),
    supertrendValue: safeNum(supertrend.value),
    supertrendDirection: String(supertrend.direction || "unknown"),
    supertrendBreakUp: !!states.supertrendBreakUp,
    supertrendBreakDown: !!states.supertrendBreakDown,
    fib50: safeNum(fibonacciLevels["0.500"]),
    fib618: safeNum(fibonacciLevels["0.618"]),
    fib786: safeNum(fibonacciLevels["0.786"]),
  };
}

interface EvaluationResult {
  confirmed: boolean;
  reason: string;
  signal: SignalSummary;
}

function evaluatePreset(
  side: string,
  preset: string,
  payload: Record<string, unknown>,
): EvaluationResult {
  const summary = buildSignalSummary(payload);
  const oversold = Number(config.indicators.rsiOversold ?? 30);
  const overbought = Number(config.indicators.rsiOverbought ?? 80);
  const close = summary.close;
  const previousClose = summary.previousClose;
  const lowerBand = summary.lowerBand;
  const upperBand = summary.upperBand;
  const rsi = summary.rsi;
  const isBullish = summary.supertrendDirection === "bullish";
  const isBearish = summary.supertrendDirection === "bearish";
  const crossedUp = (level: number | null): boolean =>
    level != null &&
    close != null &&
    previousClose != null &&
    previousClose < level &&
    close >= level;
  const crossedDown = (level: number | null): boolean =>
    level != null &&
    close != null &&
    previousClose != null &&
    previousClose > level &&
    close <= level;

  switch (preset) {
    case "supertrend_break":
      return side === "entry"
        ? {
            confirmed:
              summary.supertrendBreakUp ||
              (isBullish &&
                close != null &&
                summary.supertrendValue != null &&
                close >= summary.supertrendValue),
            reason: summary.supertrendBreakUp
              ? "Supertrend flipped bullish"
              : "Price is above bullish Supertrend",
            signal: summary,
          }
        : {
            confirmed:
              summary.supertrendBreakDown ||
              (isBearish &&
                close != null &&
                summary.supertrendValue != null &&
                close <= summary.supertrendValue),
            reason: summary.supertrendBreakDown
              ? "Supertrend flipped bearish"
              : "Price is below bearish Supertrend",
            signal: summary,
          };
    case "rsi_reversal":
      return side === "entry"
        ? {
            confirmed: rsi != null && rsi <= oversold,
            reason: `RSI ${rsi ?? "n/a"} <= oversold ${oversold}`,
            signal: summary,
          }
        : {
            confirmed: rsi != null && rsi >= overbought,
            reason: `RSI ${rsi ?? "n/a"} >= overbought ${overbought}`,
            signal: summary,
          };
    case "bollinger_reversion":
      return side === "entry"
        ? {
            confirmed: close != null && lowerBand != null && close <= lowerBand,
            reason: `Close ${close ?? "n/a"} <= lower band ${lowerBand ?? "n/a"}`,
            signal: summary,
          }
        : {
            confirmed: close != null && upperBand != null && close >= upperBand,
            reason: `Close ${close ?? "n/a"} >= upper band ${upperBand ?? "n/a"}`,
            signal: summary,
          };
    case "rsi_plus_supertrend":
      return side === "entry"
        ? {
            confirmed:
              (rsi != null && rsi <= oversold) &&
              (summary.supertrendBreakUp || isBullish),
            reason: "RSI oversold with bullish Supertrend context",
            signal: summary,
          }
        : {
            confirmed:
              (rsi != null && rsi >= overbought) &&
              (summary.supertrendBreakDown || isBearish),
            reason: "RSI overbought with bearish Supertrend context",
            signal: summary,
          };
    case "supertrend_or_rsi":
      return side === "entry"
        ? {
            confirmed:
              summary.supertrendBreakUp ||
              (isBullish &&
                close != null &&
                summary.supertrendValue != null &&
                close >= summary.supertrendValue) ||
              (rsi != null && rsi <= oversold),
            reason: "Supertrend bullish confirmation or RSI oversold",
            signal: summary,
          }
        : {
            confirmed:
              summary.supertrendBreakDown ||
              (isBearish &&
                close != null &&
                summary.supertrendValue != null &&
                close <= summary.supertrendValue) ||
              (rsi != null && rsi >= overbought),
            reason: "Supertrend bearish confirmation or RSI overbought",
            signal: summary,
          };
    case "bb_plus_rsi":
      return side === "entry"
        ? {
            confirmed:
              close != null &&
              lowerBand != null &&
              close <= lowerBand &&
              rsi != null &&
              rsi <= oversold,
            reason: "Close at/below lower band with RSI oversold",
            signal: summary,
          }
        : {
            confirmed:
              close != null &&
              upperBand != null &&
              close >= upperBand &&
              rsi != null &&
              rsi >= overbought,
            reason: "Close at/above upper band with RSI overbought",
            signal: summary,
          };
    case "fibo_reclaim":
      return side === "entry"
        ? {
            confirmed:
              crossedUp(summary.fib618) ||
              crossedUp(summary.fib50) ||
              crossedUp(summary.fib786),
            reason: "Price reclaimed a key Fibonacci level",
            signal: summary,
          }
        : {
            confirmed:
              crossedUp(summary.fib618) || crossedUp(summary.fib50),
            reason: "Price reclaimed a key Fibonacci level upward",
            signal: summary,
          };
    case "fibo_reject":
      return side === "entry"
        ? {
            confirmed:
              crossedDown(summary.fib618) || crossedDown(summary.fib50),
            reason: "Price rejected from a key Fibonacci level",
            signal: summary,
          }
        : {
            confirmed:
              crossedDown(summary.fib618) ||
              crossedDown(summary.fib50) ||
              crossedDown(summary.fib786),
            reason: "Price rejected below a key Fibonacci level",
            signal: summary,
          };
    default:
      return {
        confirmed: false,
        reason: `Unknown preset ${preset}`,
        signal: summary,
      };
  }
}

interface IndicatorResult {
  interval: string;
  ok: boolean;
  confirmed: boolean | null;
  reason: string;
  signal: SignalSummary | null;
  latest: Record<string, unknown> | null;
}

async function fetchChartIndicatorsForMint(
  mint: string,
  {
    interval = "15_MINUTE",
    candles = config.indicators.candles ?? DEFAULT_CANDLES,
    rsiLength = config.indicators.rsiLength ?? 2,
    refresh = false,
  }: {
    interval?: string;
    candles?: number;
    rsiLength?: number;
    refresh?: boolean;
  } = {},
): Promise<Record<string, unknown>> {
  const normalizedInterval = String(interval || "15_MINUTE").trim().toUpperCase();
  const search = new URLSearchParams({
    interval: normalizedInterval,
    candles: String(candles),
    rsiLength: String(rsiLength),
  });
  if (refresh) search.set("refresh", "1");

  return agentMeridianJson(`/chart-indicators/${mint}?${search.toString()}`, {
    headers: getAgentMeridianHeaders(),
  });
}

export interface IndicatorPresetResult {
  enabled: boolean;
  confirmed: boolean;
  skipped?: boolean;
  preset?: string;
  side?: string;
  requireAllIntervals?: boolean;
  reason: string;
  intervals: IndicatorResult[];
}

export async function confirmIndicatorPreset({
  mint,
  side,
  preset = side === "entry"
    ? config.indicators.entryPreset
    : config.indicators.exitPreset,
  intervals = config.indicators.intervals,
  refresh = false,
}: {
  mint?: string;
  side?: string;
  preset?: string;
  intervals?: unknown;
  refresh?: boolean;
} = {}): Promise<IndicatorPresetResult> {
  if (!config.indicators.enabled || !mint || !preset) {
    return {
      enabled: false,
      confirmed: true,
      reason: "Indicators disabled or not configured",
      intervals: [],
    };
  }

  const targets = normalizeIntervals(intervals);
  if (targets.length === 0) {
    return {
      enabled: false,
      confirmed: true,
      reason: "No indicator intervals configured",
      intervals: [],
    };
  }

  const results: IndicatorResult[] = [];
  for (const interval of targets) {
    try {
      const payload = await fetchChartIndicatorsForMint(mint!, { interval, refresh });
      const evaluation = evaluatePreset(side!, preset, payload);
      results.push({
        interval,
        ok: true,
        confirmed: !!evaluation.confirmed,
        reason: evaluation.reason,
        signal: evaluation.signal,
        latest: (payload?.latest as Record<string, unknown>) || null,
      });
    } catch (error: any) {
      log(
        "indicators_warn",
        `Indicator fetch failed for ${mint.slice(0, 8)} ${interval}: ${error.message}`,
      );
      results.push({
        interval,
        ok: false,
        confirmed: null,
        reason: error.message,
        signal: null,
        latest: null,
      });
    }
  }

  const successful = results.filter((entry) => entry.ok);
  if (successful.length === 0) {
    return {
      enabled: true,
      confirmed: true,
      skipped: true,
      preset,
      side,
      reason: "Indicator API unavailable; falling back to existing logic",
      intervals: results,
    };
  }

  const requireAll = !!config.indicators.requireAllIntervals;
  const confirmed = requireAll
    ? successful.every((entry) => entry.confirmed)
    : successful.some((entry) => entry.confirmed);

  return {
    enabled: true,
    confirmed,
    skipped: false,
    preset,
    side,
    requireAllIntervals: requireAll,
    reason: confirmed
      ? `${preset} confirmed on ${successful
          .filter((entry) => entry.confirmed)
          .map((entry) => entry.interval)
          .join(", ")}`
      : `${preset} not confirmed on ${successful.map((entry) => entry.interval).join(", ")}`,
    intervals: results,
  };
}

/**
 * Fetch exit indicator confirmations for a list of positions in parallel.
 * Returns a map keyed by `keyFn(item)` → confirmed boolean.
 * Skipped results (API unavailable) are treated as not confirmed.
 * Errors are silently swallowed — missing data means no exit signal.
 */
export async function fetchExitConfirmations<T>(
  items: T[],
  keyFn: (item: T) => string,
  mintFn: (item: T) => string | null | undefined,
): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();
  if (!config.indicators.enabled || !config.indicators.exitEnabled) {
    return result;
  }
  await Promise.all(
    items.map(async (item) => {
      const mint = mintFn(item);
      if (!mint) return;
      try {
        const r = await confirmIndicatorPreset({ mint, side: "exit" });
        result.set(keyFn(item), !r.skipped && r.confirmed);
      } catch {
        // Graceful degradation
      }
    }),
  );
  return result;
}
