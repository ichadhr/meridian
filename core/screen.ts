/**
 * Live screening cycle — discovers new pools, evaluates candidates,
 * invokes LLM for deploy decisions.
 *
 * Extracted from index.ts to separate cycle logic from REPL/Telegram wiring.
 */

import { agentLoop } from "../llm/index.js";
import { log } from "../utils/logger.js";
import { getMyPositions } from "./state.js";
import { getWalletBalances } from "../providers/solana/index.js";
import { getTopCandidates } from "../providers/meteora/index.js";
import { getActiveBin } from "../providers/meteora/index.js";
import { config, computeDeployAmount } from "../config/index.js";
import { sendLongMessage, isEnabled as telegramEnabled, createLiveMessage, dryRunTag } from "../interfaces/index.js";
import { checkSmartWalletsOnPool } from "./smart-wallets.js";
import { getTokenNarrative, getTokenInfo } from "../providers/jupiter/index.js";
import { stageSignals } from "./signal-tracker.js";
import { getWeightsSummary } from "./signal-weights.js";
import { recallForPool } from "./pool-memory.js";
import { appendDecision } from "./decision-log.js";
import { getActiveStrategy } from "./strategy-library.js";
import { stripThink, sanitizeUntrustedPromptText } from "../utils/text.js";
import { screeningBusy, setScreeningBusy, screeningLastStarted, setScreeningLastStarted, timers, SCREENING_COOLDOWN_MS } from "./coordination-state.js";
import { scanTokens } from "../providers/okx/index.js";
import type { SafetyVerdict } from "../providers/okx/index.js";

// ── Types ─────────────────────────────────────────────────────
type AnyObj = Record<string, any>;

interface Candidate {
  pool: AnyObj;
  sw: any;
  swFailed?: boolean;
  n: any;
  nFailed?: boolean;
  ti: any;
  mem: any;
  [key: string]: any;
}

// ── Retry helper ──────────────────────────────────────────────

const REQUIRED_TOOL_RETRIES = 3;
const REQUIRED_TOOL_BACKOFF_MS = [200, 500, 1000];

async function callWithRetry<T>(
  fn: () => Promise<T>,
  name: string,
  { retries = REQUIRED_TOOL_RETRIES, backoff = REQUIRED_TOOL_BACKOFF_MS }: { retries?: number; backoff?: number[] } = {},
): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      const msg = err?.message ?? String(err);
      const isTransient = /429|5\d{2}|timeout|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET|EAI_AGAIN/i.test(msg);
      if (!isTransient || attempt === retries) throw err;
      const base = backoff[attempt] ?? backoff[backoff.length - 1];
      const delay = base + Math.random() * 100; // jitter
      log("screening", `Retry ${attempt + 2}/${retries + 1} for ${name}: ${msg} (waiting ${Math.round(delay)}ms)`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError!;
}

// ── Consecutive failure tracking ──────────────────────────────

let _consecutiveRequiredFailures = 0;
const REQUIRED_FAILURE_ALERT_THRESHOLD = 3;

// ── Helpers ───────────────────────────────────────────────────

export function getLoneCandidateSkipReason({ pool, sw, swFailed, n, nFailed, ti }: Candidate = {} as Candidate): string | null {
  if (!pool) return "missing candidate data";
  const smartWalletCount: number = Math.max(sw?.in_pool?.length ?? 0, Number(pool.gmgn_smart_wallets ?? 0) || 0);
  const tokenInfo: any = ti || {};
  const hasNarrative: boolean = !!n?.narrative;
  const globalFeesSol: number = Number(tokenInfo.global_fees_sol ?? pool.gmgn_total_fee_sol);
  const top10Pct: number = Number(tokenInfo.audit?.top_holders_pct ?? pool.gmgn_token_info_top10_pct ?? pool.gmgn_top10_holder_pct);
  const botPct: number = Number(tokenInfo.audit?.bot_holders_pct ?? pool.gmgn_bot_degen_pct);
  if (pool.is_wash) return "wash trading was flagged";
  if (pool.is_rugpull && smartWalletCount === 0) return "rugpull risk was flagged and no smart wallets offset it";
  if (pool.is_pvp && smartWalletCount === 0) return "PVP symbol conflict and no smart-wallet confirmation";
  if (Number.isFinite(globalFeesSol) && globalFeesSol < config.screening.minTokenFeesSol) {
    return `token fees ${globalFeesSol} SOL below minimum ${config.screening.minTokenFeesSol} SOL`;
  }
  if (Number.isFinite(top10Pct) && top10Pct > config.screening.maxTop10Pct) {
    return `top10 concentration ${top10Pct}% above maximum ${config.screening.maxTop10Pct}%`;
  }
  if (Number.isFinite(botPct) && botPct > config.screening.maxBotHoldersPct) {
    return `bot holders ${botPct}% above maximum ${config.screening.maxBotHoldersPct}%`;
  }
  // Only skip for missing narrative/smart-wallet data if the tools actually succeeded
  // and returned nothing. If a tool failed, treat it as UNKNOWN, not as missing.
  const narrativeMissing = !nFailed && !hasNarrative;
  const smartWalletsMissing = !swFailed && smartWalletCount === 0;
  if (narrativeMissing && smartWalletsMissing) return "only candidate has no narrative and no smart-wallet confirmation";
  return null;
}

// ── Safety pre-step (OKX onchainos) ──────────────────────────

export interface SafetyPreStepResult {
  /** Filtered candidates — CRITICAL/HIGH/(optional MEDIUM)/SCAN_FAILED removed. */
  safePassing: Candidate[];
  /** Per-mint verdicts keyed by mint. */
  verdictMap: Map<string, SafetyVerdict>;
  /** Human-readable summary block for the LLM prompt. */
  summary: string;
  /** True when the entire pre-step failed (binary missing, network, etc.). */
  scanFailed: boolean;
}

/**
 * Run the OKX onchainos token-scan over all passing candidates, then
 * hard-filter the results based on risk level:
 *
 *   required=true  (default) — fail-closed:
 *     - CRITICAL, HIGH, SCAN_FAILED verdicts are dropped.
 *     - MEDIUM is dropped if config.safetyScan.dropMediumRisk is true.
 *     - Candidates without a mint address are blocked.
 *     - If the entire binary call fails, safePassing is empty.
 *
 *   required=false — best-effort:
 *     - Same risk-level filtering when the binary succeeds.
 *     - If the binary call fails, all candidates pass through with a
 *       logged warning (no scan data, but the cycle continues).
 *     - Mintless candidates pass through (can't scan, no verdict).
 *
 * @param passing - Pre-fetched candidates (post getActiveBin)
 * @returns Safe candidates to pass to the LLM, plus the verdict map and summary
 */
export async function runSafetyPreStep(passing: Candidate[]): Promise<SafetyPreStepResult> {
  const empty: SafetyPreStepResult = {
    safePassing: passing,
    verdictMap: new Map(),
    summary: "",
    scanFailed: false,
  };
  if (passing.length === 0) return empty;

  // Extract mints. Candidates without a mint can't be scanned.
  // When required=true they are blocked; when required=false they pass
  // through (no verdict, no blocking).
  const required = config.safetyScan.required;
  const mintByCandidate = new Map<Candidate, string>();
  const mints: string[] = [];
  for (const c of passing) {
    const mint: string | null = c.pool?.base?.mint || c.pool?.base_mint || c.ti?.mint || null;
    if (mint) {
      mintByCandidate.set(c, mint);
      mints.push(mint);
    }
  }

  if (mints.length === 0) {
    // No candidates had extractable mints.
    if (required) {
      return {
        safePassing: [],
        verdictMap: new Map(),
        summary: "⚠️ Safety scan blocked: no mint addresses to scan (required mode)",
        scanFailed: false,
      };
    }
    return { ...empty, summary: "⚠️ Safety scan skipped: no mint addresses in candidates" };
  }

  log("safety_scan", `Scanning ${mints.length} mints via onchainos...`);

  let verdicts: SafetyVerdict[];
  try {
    verdicts = await scanTokens(mints, { timeoutMs: config.safetyScan.timeoutMs });
  } catch (err: any) {
    log("safety_error", `onchainos scan threw: ${err?.message ?? String(err)}`);
    if (config.safetyScan.required) {
      return {
        safePassing: [],   // fail-closed: block all deploys
        verdictMap: new Map(),
        summary: `⚠️ Safety scan failed: ${err?.message ?? String(err)}`,
        scanFailed: true,
      };
    }
    // Best-effort mode: let all candidates through with a warning.
    return {
      safePassing: passing,
      verdictMap: new Map(),
      summary: `⚠️ Safety scan failed (non-required, passing through): ${err?.message ?? String(err)}`,
      scanFailed: true,
    };
  }

  // Index verdicts by mint for filtering and the summary block
  const verdictMap = new Map<string, SafetyVerdict>();
  for (const v of verdicts) verdictMap.set(v.mint, v);

  // Hard filter: drop CRITICAL, HIGH, SCAN_FAILED. Optional MEDIUM.
  const blocked: string[] = [];
  const kept: Candidate[] = [];
  for (const c of passing) {
    const mint = mintByCandidate.get(c);
    if (!mint) {
      // No mint available. When required=true, block; otherwise pass through.
      if (required) {
        blocked.push("(no mint)");
      } else {
        kept.push(c);
      }
      continue;
    }
    const v = verdictMap.get(mint);
    if (!v) {
      // No verdict returned (shouldn't happen — scanTokens fills SCAN_FAILED)
      blocked.push(mint);
      continue;
    }
    if (
      v.riskLevel === "CRITICAL" ||
      v.riskLevel === "HIGH" ||
      v.riskLevel === "SCAN_FAILED" ||
      (config.safetyScan.dropMediumRisk && v.riskLevel === "MEDIUM")
    ) {
      blocked.push(mint);
    } else {
      kept.push(c);
    }
  }

  // Build a compact summary for the LLM prompt
  const summaryLines: string[] = ["OKX safety scan:"];
  for (const v of verdicts) {
    summaryLines.push(`  ${v.mint.slice(0, 8)}…  ${v.riskLevel}  ${v.summary}`);
  }
  summaryLines.push(`Blocked: ${blocked.length}/${verdicts.length} (CRITICAL/HIGH/SCAN_FAILED${config.safetyScan.dropMediumRisk ? "/MEDIUM" : ""})`);

  return {
    safePassing: kept,
    verdictMap,
    summary: summaryLines.join("\n"),
    scanFailed: false,
  };
}

// ── tryStartScreening ─────────────────────────────────────────

/**
 * Fire screening cycle if not already running and cooldown has elapsed.
 * All callers should use this instead of calling runScreeningCycle directly,
 * to avoid overlapping cycles and provide clear source attribution in logs.
 */
export function tryStartScreening(source: string, silent: boolean = false): boolean {
  if (screeningBusy) {
    log("cron", `Screening skipped (${source}) — already running`);
    return false;
  }
  if (Date.now() - screeningLastStarted < SCREENING_COOLDOWN_MS) {
    const remaining: number = Math.ceil((SCREENING_COOLDOWN_MS - (Date.now() - screeningLastStarted)) / 1000);
    log("cron", `Screening skipped (${source}) — cooldown active (${remaining}s remaining)`);
    return false;
  }
  runScreeningCycle({ silent, source }).catch((e: any) => log("cron_error", `${source} failed: ${e?.message ?? String(e)}`));
  return true;
}

// ── Screening Cycle ───────────────────────────────────────────

export async function runScreeningCycle({ silent = false, source, force = false }: { silent?: boolean; source?: string; force?: boolean } = {}): Promise<string | null> {
  if (screeningBusy) {
    log("cron", `Screening skipped${source ? ` (${source})` : ""} — previous cycle still running`);
    return null;
  }
  if (!force && Date.now() - screeningLastStarted < SCREENING_COOLDOWN_MS) {
    const remaining: number = Math.ceil((SCREENING_COOLDOWN_MS - (Date.now() - screeningLastStarted)) / 1000);
    log("cron", `Screening skipped${source ? ` (${source})` : ""} — cooldown active (${remaining}s remaining)`);
    return null;
  }

  setScreeningBusy(true);
  setScreeningLastStarted(Date.now());

  // Hard guards — don't even run the agent if preconditions aren't met
  let prePositions: any, preBalance: any;
  let liveMessage: any = null;
  let screenReport: string | null = null;
  try {
    [prePositions, preBalance] = await Promise.all([getMyPositions({ force: true }), getWalletBalances()]);
    if (prePositions.total_positions >= config.risk.maxPositions) {
      log("cron", `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions})`);
      screenReport = `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions}).`;
      appendDecision({
        type: "skip",
        actor: "SCREENER",
        summary: "Screening skipped",
        reason: `Max positions reached (${prePositions.total_positions}/${config.risk.maxPositions})`,
      });
      return screenReport;
    }
    const minRequired: number = config.management.deployAmountSol + config.management.gasReserve;
    const isDryRun: boolean = process.env.DRY_RUN === "true";
    if (!isDryRun && preBalance.sol < minRequired) {
      log("cron", `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas)`);
      screenReport = `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas).`;
      appendDecision({
        type: "skip",
        actor: "SCREENER",
        summary: "Screening skipped",
        reason: `Insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired})`,
      });
      return screenReport;
    }
  } catch (e: any) {
    log("cron_error", `Screening pre-check failed: ${e?.message ?? String(e)}`);
    screenReport = `Screening pre-check failed: ${e?.message ?? String(e)}`;
    return screenReport;
  }
  if (!silent && telegramEnabled()) {
    liveMessage = await createLiveMessage("🔍 Screening Cycle", "Scanning candidates...");
  }
  timers.screeningLastRun = Date.now();
  log("cron", `Starting screening cycle [model: ${config.llm.screeningModel}]`);
  // Per-cycle failure tracking — increment counter once per cycle, not per tool
  let cycleRequiredToolFailed = false;
  let lastRequiredFailureMsg: string | null = null;
  try {
    const currentBalance: any = preBalance;
    const deployAmount: number = computeDeployAmount(currentBalance.sol);
    log("cron", `Computed deploy amount: ${deployAmount} SOL (wallet: ${currentBalance.sol} SOL)`);

    // Load active strategy
    const activeStrategy: any = getActiveStrategy();
    const strategyBlock: string = activeStrategy
      ? `ACTIVE STRATEGY: ${activeStrategy.name} — LP: ${config.strategy.strategy} | bins_above: ${activeStrategy.range?.bins_above ?? 0} (FIXED — never change) | deposit: ${activeStrategy.entry?.single_side === "sol" ? "SOL only (amount_y, amount_x=0)" : "dual-sided"} | best for: ${activeStrategy.best_for}`
      : `No active strategy — use default ${config.strategy.strategy}, bins_above: 0, SOL only.`;

    // Fetch top candidates (required — retry then abort)
    const topCandidates: any = await callWithRetry(
      () => getTopCandidates({ limit: 10 }),
      "getTopCandidates",
    ).catch((err: Error) => {
      log("screening_error", `getTopCandidates failed after retries: ${err?.message ?? String(err)}`);
      cycleRequiredToolFailed = true;
      lastRequiredFailureMsg = err?.message ?? String(err);
      return null;
    });
    if (!topCandidates) {
      screenReport = "Screening aborted — required tool getTopCandidates failed.";
      appendDecision({ type: "no_deploy", actor: "SCREENER", summary: "Required tool failed", reason: "getTopCandidates" });
      return screenReport;
    }
    const candidates: any[] = (topCandidates?.candidates || topCandidates?.pools || []).slice(0, 10);
    const earlyFilteredExamples: any[] = topCandidates?.filtered_examples || [];

    const allCandidates: Candidate[] = [];
    for (const pool of candidates) {
      const mint: string | undefined = pool.base?.mint;
      const [smartWallets, narrative] = await Promise.allSettled([
        checkSmartWalletsOnPool({ pool_address: pool.pool }),
        mint ? getTokenNarrative({ mint }) : Promise.resolve(null),
      ]);
      // Log optional tool failures at warn level
      if (smartWallets.status === "rejected") log("screening_warn", `checkSmartWalletsOnPool failed for ${pool.name}: ${(smartWallets.reason as Error)?.message ?? String(smartWallets.reason)}`);
      if (narrative.status === "rejected") log("screening_warn", `getTokenNarrative failed for ${pool.name}: ${(narrative.reason as Error)?.message ?? String(narrative.reason)}`);

      // getTokenInfo is required (feeds hard filters) — retry then fail-closed
      let ti: any = null;
      if (mint) {
        try {
          const info = await callWithRetry(() => getTokenInfo({ query: mint }), `getTokenInfo(${pool.name})`);
          ti = (info as any)?.results?.[0] ?? null;
        } catch (err: any) {
          log("screening_error", `getTokenInfo failed for ${pool.name} after retries: ${err?.message ?? String(err)}`);
          cycleRequiredToolFailed = true;
          lastRequiredFailureMsg = `getTokenInfo(${pool.name}): ${err?.message ?? String(err)}`;
        }
      }
      allCandidates.push({
        pool,
        sw: smartWallets.status === "fulfilled" ? smartWallets.value : null,
        swFailed: smartWallets.status === "rejected",
        n: narrative.status === "fulfilled" ? narrative.value : null,
        nFailed: narrative.status === "rejected",
        ti,
        mem: recallForPool(pool.pool),
      });
      await new Promise(r => setTimeout(r, 150));
    }

    // Hard filters
    const filteredOut: AnyObj[] = [];
    let passing: Candidate[] = allCandidates.filter(({ pool, ti }: Candidate) => {
      // Fail-closed: reject candidates without token info (required for safety filters)
      if (!ti) {
        log("screening", `Skipping ${pool.name} — token info unavailable`);
        filteredOut.push({ name: pool.name, reason: "token info unavailable" });
        return false;
      }
      const launchpad: string | null = ti?.launchpad ?? null;
      if (launchpad && config.screening.allowedLaunchpads?.length > 0 && !config.screening.allowedLaunchpads.includes(launchpad)) {
        log("screening", `Skipping ${pool.name} — launchpad ${launchpad} not in allow-list`);
        filteredOut.push({ name: pool.name, reason: `launchpad ${launchpad} not in allow-list` });
        return false;
      }
      if (launchpad && config.screening.blockedLaunchpads.includes(launchpad)) {
        log("screening", `Skipping ${pool.name} — blocked launchpad (${launchpad})`);
        filteredOut.push({ name: pool.name, reason: `blocked launchpad (${launchpad})` });
        return false;
      }
      const botPct: number | null | undefined = ti?.audit?.bot_holders_pct;
      const maxBotHoldersPct: number | null = config.screening.maxBotHoldersPct;
      if (botPct != null && maxBotHoldersPct != null && botPct > maxBotHoldersPct) {
        log("screening", `Bot-holder filter: dropped ${pool.name} — bots ${botPct}% > ${maxBotHoldersPct}%`);
        filteredOut.push({ name: pool.name, reason: `bot holders ${botPct}% > ${maxBotHoldersPct}%` });
        return false;
      }
      return true;
    });

    if (passing.length === 0) {
      const combined: any[] = filteredOut.length > 0 ? filteredOut : earlyFilteredExamples;
      const combinedExamples: string = combined.slice(0, 3)
        .map((entry: any) => `- ${entry.name}: ${entry.reason}`)
        .join("\n");
      screenReport = combinedExamples
        ? `No candidates available.\nFiltered examples:\n${combinedExamples}`
        : `No candidates available (all filtered by launchpad / holder-quality rules).`;
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "No candidates available",
        reason: combinedExamples || "All candidates filtered before deploy",
        rejected: combined.slice(0, 5).map((entry: any) => `${entry.name}: ${entry.reason}`),
      });
      return screenReport;
    }

    if (passing.length === 1) {
      const skipReason: string | null = getLoneCandidateSkipReason(passing[0]);
      if (skipReason) {
        const candidateName: string = passing[0].pool?.name || "unknown";
        screenReport = [
          "⛔ NO DEPLOY",
          "",
          "Cycle finished with no valid entry.",
          "",
          "BEST LOOKING CANDIDATE",
          candidateName,
          "",
          "WHY SKIPPED",
          `Only one candidate survived filtering, but it was not worth deploying: ${skipReason}.`,
          "",
          "REJECTED",
          `- ${candidateName}: ${skipReason}`,
        ].join("\n");
        appendDecision({
          type: "no_deploy",
          actor: "SCREENER",
          summary: "Single candidate skipped",
          reason: skipReason,
          pool: passing[0].pool?.pool,
          pool_name: candidateName,
        });
        return screenReport;
      }
    }

    // Pre-fetch active_bin for all passing candidates (required — retry each).
    // Key by pool.pool so results survive candidate filtering by the safety step.
    const activeBinByPool = new Map<string, any>();
    for (const { pool } of passing) {
      try {
        const bin = await callWithRetry(() => getActiveBin({ pool_address: pool.pool }), `getActiveBin(${pool.name})`);
        activeBinByPool.set(pool.pool, bin);
      } catch (err: any) {
        log("screening_error", `getActiveBin failed for ${pool.name} after retries: ${err?.message ?? String(err)}`);
        cycleRequiredToolFailed = true;
        lastRequiredFailureMsg = `getActiveBin(${pool.name}): ${err?.message ?? String(err)}`;
        screenReport = `Screening aborted — required tool getActiveBin failed for ${pool.name}.`;
        appendDecision({ type: "no_deploy", actor: "SCREENER", summary: "Required tool failed", reason: `getActiveBin(${pool.name})` });
        return screenReport;
      }
    }

    // ── Safety pre-step: OKX onchainos token-scan ───────────────────────
    // Hard-filter CRITICAL/HIGH/SCAN_FAILED mints before the LLM sees them.
    // Run AFTER getActiveBin so the pre-fetch is complete, but BEFORE the
    // candidate blocks are built so we don't waste formatting on dropped ones.
    const safety = await runSafetyPreStep(passing);
    if (safety.scanFailed && config.safetyScan.required) {
      // Required mode + entire pre-step failed → block all deploys.
      screenReport = `Screening aborted — required safety scan failed: ${safety.summary}`;
      appendDecision({ type: "no_deploy", actor: "SCREENER", summary: "Safety scan failed", reason: safety.summary });
      return screenReport;
    }
    if (passing.length > 0 && safety.safePassing.length === 0) {
      // All candidates blocked by safety → no_deploy
      screenReport = `Screening aborted — all ${passing.length} candidates blocked by safety scan.\n${safety.summary}`;
      appendDecision({ type: "no_deploy", actor: "SCREENER", summary: "All blocked by safety scan", reason: safety.summary });
      return screenReport;
    }
    // Reassign passing to the safety-filtered set
    passing = safety.safePassing;

    // Build compact candidate blocks
    const candidateBlocks: string[] = passing.map(({ pool, sw, swFailed, n, nFailed, ti, mem }: Candidate, i: number) => {
      const botPct: any = ti?.audit?.bot_holders_pct ?? "?";
      const top10Pct: any = ti?.audit?.top_holders_pct ?? "?";
      const feesSol: any = ti?.global_fees_sol ?? "?";
      const launchpad: string | null = ti?.launchpad ?? null;
      const priceChange: number | null = ti?.stats_1h?.price_change;
      const netBuyers: number | null = ti?.stats_1h?.net_buyers;
      const binResult = activeBinByPool.get(pool.pool);
      const activeBin: any = binResult?.binId ?? null;

      const okxParts: string = [
        pool.risk_level     != null ? `risk=${pool.risk_level}`               : null,
        pool.bundle_pct     != null ? `bundle=${pool.bundle_pct}%`            : null,
        pool.sniper_pct     != null ? `sniper=${pool.sniper_pct}%`            : null,
        pool.suspicious_pct != null ? `suspicious=${pool.suspicious_pct}%` : null,
        pool.new_wallet_pct != null ? `new_wallets=${pool.new_wallet_pct}%`   : null,
        pool.is_rugpull != null ? `rugpull=${pool.is_rugpull ? "YES" : "NO"}` : null,
        pool.is_wash != null ? `wash=${pool.is_wash ? "YES" : "NO"}` : null,
      ].filter(Boolean).join(", ");
      const okxUnavailable: boolean = !okxParts && pool.price_vs_ath_pct == null;

      const okxTags: string = [
        pool.smart_money_buy    ? "smart_money_buy"    : null,
        pool.kol_in_clusters    ? "kol_in_clusters"    : null,
        pool.dex_boost          ? "dex_boost"          : null,
        pool.dex_screener_paid  ? "dex_screener_paid"  : null,
        pool.dev_sold_all       ? "dev_sold_all(bullish)" : null,
      ].filter(Boolean).join(", ");
      const pvpLine: string | null = pool.is_pvp
        ? `  pvp: HIGH — rival ${pool.pvp_rival_name || pool.pvp_symbol} (${pool.pvp_rival_mint?.slice(0, 8)}...) has pool ${pool.pvp_rival_pool?.slice(0, 8)}..., tvl=$ ${pool.pvp_rival_tvl}, holders=${pool.pvp_rival_holders}, fees=${pool.pvp_rival_fees}SOL`
        : null;
      const extended: string = [
        pool.token_name !== pool.pool_name ? `  token: ${pool.token_name} (name), ${pool.symbol} (symbol)` : null,
        pvpLine,
        `  metrics: bin_step=${pool.bin_step}, fee_pct=${pool.fee_pct}%, fee_tvl=${pool.fee_active_tvl_ratio}, vol=$ ${pool.volume_window}, tvl=$ ${pool.tvl ?? pool.active_tvl}, volatility_${pool.volatility_timeframe || "30m"}=${pool.volatility}, mcap=$ ${pool.mcap}, organic=${pool.organic_score}${pool.token_age_hours != null ? `, age=${pool.token_age_hours}h` : ""}`,
        `  audit: top10=${top10Pct}%, bots=${botPct}%, fees=${feesSol}SOL${launchpad ? `, launchpad=${launchpad}` : ""}`,
        okxParts ? `  okx: ${okxParts}` : okxUnavailable ? `  okx: unavailable` : null,
        okxTags  ? `  tags: ${okxTags}` : null,
        pool.price_vs_ath_pct != null ? `  ath: price_vs_ath=${pool.price_vs_ath_pct}%${pool.top_cluster_trend ? `, top_cluster=${pool.top_cluster_trend}` : ""}` : null,
        swFailed
          ? `  smart_wallets: [FAILED — tool error, do not invent]`
          : `  smart_wallets: ${sw?.in_pool?.length ?? 0} present${sw?.in_pool?.length ? ` → CONFIDENCE BOOST (${sw.in_pool.map((w: any) => w.name).join(", ")})` : ""}`,
        activeBin != null ? `  active_bin: ${activeBin}` : null,
        priceChange != null ? `  1h: price${priceChange >= 0 ? "+" : ""}${priceChange}%, net_buyers=${netBuyers ?? "?"}` : null,
        nFailed
          ? `  narrative_untrusted: [FAILED — tool error, do not invent]`
          : n?.narrative ? `  narrative_untrusted: ${sanitizeUntrustedPromptText(n.narrative, 500)}` : `  narrative_untrusted: none`,
        mem ? `  memory_untrusted: ${sanitizeUntrustedPromptText(mem, 500)}` : null,
      ].filter(Boolean).join("\n");

      // Stage signals for Darwinian weighting
      if (config.darwin?.enabled) {
        const baseMint: string | null = pool.base?.mint || pool.base_mint || ti?.mint || null;
        stageSignals(pool.pool, {
          base_mint:             baseMint ?? undefined,
          organic_score:         pool.organic_score         ?? null,
          fee_tvl_ratio:         pool.fee_active_tvl_ratio  ?? null,
          volume:                pool.volume_window         ?? null,
          mcap:                  pool.mcap                  ?? null,
          holder_count:          ti?.holders                ?? null,
          smart_wallets_present: (sw?.in_pool?.length ?? 0) > 0,
          narrative_quality:     n?.narrative ? "present" : "absent",
          volatility:            pool.volatility            ?? null,
        });
      }

      return extended;
    });

    const weightsSummary: string | null = config.darwin?.enabled ? getWeightsSummary() : null;

    let deployAttempted: boolean = false;
    let deploySucceeded: boolean = false;
    const { content }: { content: string } = await agentLoop(`
SCREENING CYCLE
${strategyBlock}
Positions: ${prePositions.total_positions}/${config.risk.maxPositions} | SOL: ${currentBalance.sol.toFixed(3)} | Deploy: ${deployAmount} SOL
${weightsSummary ? `\n${weightsSummary}\n` : ""}
${safety.summary ? `\n${safety.summary}\n` : ""}
PRE-LOADED CANDIDATES (${passing.length} pools):
${candidateBlocks.join("\n\n")}

STEPS:
1. Decide if any candidate is actually worth deploying. One surviving candidate is not automatically good enough.
2. Pick the best candidate based on narrative quality, smart wallets, and pool metrics.
3. Call deploy_position (active_bin is pre-fetched above — no need to call get_active_bin).
   bins_below = round(${config.strategy.minBinsBelow} + (candidate volatility/5)*(${config.strategy.maxBinsBelow - config.strategy.minBinsBelow})) clamped to [${config.strategy.minBinsBelow},${config.strategy.maxBinsBelow}].
   pass deploy_position.volatility = the candidate volatility value.
   For single-side SOL deploys, do not invent upside:
   set amount_y only, keep amount_x = 0, keep bins_above = 0, and let the upper bin stay at the active bin.
4. Report in this exact format (no tables, no extra sections):
   🚀 DEPLOYED

   <pool name>
   <pool address>

   ◎ <deploy amount> SOL | <strategy> | bin <active_bin>
   Range: <minPrice> → <maxPrice>
   Range cover: <downside %> downside | <upside %> upside | <total width %> total

   IMPORTANT:
   - Do NOT calculate the range percentages yourself.
   - Use the actual deploy_position tool result:
     range_coverage.downside_pct
     range_coverage.upside_pct
     range_coverage.width_pct

   MARKET
   Fee/TVL: <x>%
   Volume: $<x>
   TVL: $<x>
   Volatility: <x>
   Organic: <x>
   Mcap: $<x>
   Age: <x>h

   AUDIT
   Top10: <x>%
   Bots: <x>%
   Fees paid: <x> SOL
   Smart wallets: <names or none>

   RISK
   <If OKX advanced/risk data exists, list only the fields that actually exist: Risk level, Bundle, Sniper, Suspicious, ATH distance, Rugpull, Wash.>
   <If only rugpull/wash exist, list just those.>
   <If OKX enrichment is missing, write exactly: OKX: unavailable>

   WHY THIS WON
   <2-4 concise sentences on why this pool won, key risks, and why it still beat the alternatives>
5. If no pool qualifies, report in this exact format instead:
   ⛔ NO DEPLOY

   Cycle finished with no valid entry.

   BEST LOOKING CANDIDATE
   <name or none>

   WHY SKIPPED
   <2-4 concise sentences explaining why nothing was good enough>

   REJECTED
   <short flat list of top candidate names and why they were skipped>
IMPORTANT:
- Never write "unknown" for OKX. Use real values, omit missing fields, or write exactly "OKX: unavailable".
- [FAILED] markers mean the data source returned an error. Do NOT invent values for failed fields. Treat them as UNKNOWN, not as negative evidence.
- "none" / "unavailable" / "0 present" means the tool succeeded but found nothing. This is a legitimate signal.
- Optional tool failure alone is NOT a reason to skip a candidate.
- Keep the whole report compact and highly scannable for Telegram.
     `, config.llm.maxSteps, [], "SCREENER", config.llm.screeningModel, 2048, {
      safetyVerified: !safety.scanFailed,
      onToolStart: async ({ name }: { name: string }) => {
        if (name === "deploy_position") deployAttempted = true;
        await liveMessage?.toolStart(name);
      },
      onToolFinish: async ({ name, result, success }: { name: string; result: any; success: boolean }) => {
        if (name === "deploy_position") {
          deployAttempted = true;
          deploySucceeded = Boolean(success && result?.success !== false && !result?.error && !result?.blocked);
        }
        await liveMessage?.toolFinish(name, result, success);
      },
    });
    screenReport = content;
    if (/⛔\s*NO DEPLOY/i.test(content)) {
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "LLM chose no deploy",
        reason: stripThink(content).slice(0, 500),
      });
    } else if (!deploySucceeded) {
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: deployAttempted ? "Deploy attempt did not succeed" : "No successful deploy in screening cycle",
        reason: stripThink(content).slice(0, 500),
      });
    }
  } catch (error: any) {
    log("cron_error", `Screening cycle failed: ${error?.message ?? String(error)}`);
    screenReport = `Screening cycle failed: ${error?.message ?? String(error)}`;
  } finally {
    // Update consecutive failure counter (once per cycle)
    if (cycleRequiredToolFailed) {
      _consecutiveRequiredFailures += 1;
      if (_consecutiveRequiredFailures >= REQUIRED_FAILURE_ALERT_THRESHOLD) {
        sendLongMessage(`⚠️ Screening degraded: required tools failing for ${_consecutiveRequiredFailures} consecutive cycles.\nLast error: ${lastRequiredFailureMsg}`).catch(() => {});
      }
    } else {
      _consecutiveRequiredFailures = 0;
    }
    setScreeningBusy(false);
    if (!silent && telegramEnabled()) {
      if (screenReport) {
        if (liveMessage) await liveMessage.finalize(stripThink(screenReport)).catch(() => {});
        else sendLongMessage(dryRunTag(`🔍 Screening Cycle\n\n${stripThink(screenReport)}`)).catch(() => { });
      }
    }
  }
  return screenReport;
}
