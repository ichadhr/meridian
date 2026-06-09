/**
 * Live screening cycle — discovers new pools, evaluates candidates,
 * invokes LLM for deploy decisions.
 *
 * Extracted from index.ts to separate cycle logic from REPL/Telegram wiring.
 */

import { agentLoop } from "../../llm/index.js";
import { log } from "../../utils/logger.js";
import { getMyPositions } from "../../providers/meteora/index.js";
import { getWalletBalances } from "../../providers/solana/index.js";
import { getTopCandidates } from "../../providers/meteora/pool-discovery.js";
import { getActiveBin } from "../../providers/meteora/index.js";
import { config, computeDeployAmount } from "../../config/index.js";
import { sendLongMessage, isEnabled as telegramEnabled, createLiveMessage } from "../../interfaces/index.js";
import { checkSmartWalletsOnPool } from "../smart-wallets.js";
import { getTokenNarrative, getTokenInfo } from "../../providers/jupiter/index.js";
import { stageSignals } from "../signal-tracker.js";
import { getWeightsSummary } from "../signal-weights.js";
import { recallForPool } from "../pool-memory.js";
import { appendDecision } from "../decision-log.js";
import { getActiveStrategy } from "../strategy-library.js";
import { stripThink, sanitizeUntrustedPromptText } from "../../utils/text.js";
import { screeningBusy, setScreeningBusy, screeningLastTriggered, setScreeningLastTriggered, timers, SCREENING_COOLDOWN_MS } from "./cycle-state.js";

// ── Types ─────────────────────────────────────────────────────
type AnyObj = Record<string, any>;

interface Candidate {
  pool: AnyObj;
  sw: any;
  n: any;
  ti: any;
  mem: any;
  [key: string]: any;
}

// ── Helpers ───────────────────────────────────────────────────

export function getLoneCandidateSkipReason({ pool, sw, n, ti }: Candidate = {} as Candidate): string | null {
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
  if (!hasNarrative && smartWalletCount === 0) return "only candidate has no narrative and no smart-wallet confirmation";
  return null;
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
  if (Date.now() - screeningLastTriggered < SCREENING_COOLDOWN_MS) {
    const remaining: number = Math.ceil((SCREENING_COOLDOWN_MS - (Date.now() - screeningLastTriggered)) / 1000);
    log("cron", `Screening skipped (${source}) — cooldown active (${remaining}s remaining)`);
    return false;
  }
  runScreeningCycle({ silent }).catch((e: Error) => log("cron_error", `${source} failed: ${e.message}`));
  return true;
}

// ── Screening Cycle ───────────────────────────────────────────

export async function runScreeningCycle({ silent = false }: { silent?: boolean } = {}): Promise<string | null> {
  if (screeningBusy) {
    log("cron", "Screening skipped — previous cycle still running");
    return null;
  }
  setScreeningBusy(true);

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
      setScreeningBusy(false);
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
      setScreeningBusy(false);
      return screenReport;
    }
  } catch (e: any) {
    log("cron_error", `Screening pre-check failed: ${e.message}`);
    screenReport = `Screening pre-check failed: ${e.message}`;
    setScreeningBusy(false);
    return screenReport;
  }
  setScreeningLastTriggered(Date.now());
  if (!silent && telegramEnabled()) {
    liveMessage = await createLiveMessage("🔍 Screening Cycle", "Scanning candidates...");
  }
  timers.screeningLastRun = Date.now();
  log("cron", `Starting screening cycle [model: ${config.llm.screeningModel}]`);
  try {
    const currentBalance: any = preBalance;
    const deployAmount: number = computeDeployAmount(currentBalance.sol);
    log("cron", `Computed deploy amount: ${deployAmount} SOL (wallet: ${currentBalance.sol} SOL)`);

    // Load active strategy
    const activeStrategy: any = getActiveStrategy();
    const strategyBlock: string = activeStrategy
      ? `ACTIVE STRATEGY: ${activeStrategy.name} — LP: ${activeStrategy.lp_strategy} | bins_above: ${activeStrategy.range?.bins_above ?? 0} (FIXED — never change) | deposit: ${activeStrategy.entry?.single_side === "sol" ? "SOL only (amount_y, amount_x=0)" : "dual-sided"} | best for: ${activeStrategy.best_for}`
      : `No active strategy — use default bid_ask, bins_above: 0, SOL only.`;

    // Fetch top candidates
    const topCandidates: any = await getTopCandidates({ limit: 10 }).catch(() => null);
    const candidates: any[] = (topCandidates?.candidates || topCandidates?.pools || []).slice(0, 10);
    const earlyFilteredExamples: any[] = topCandidates?.filtered_examples || [];

    const allCandidates: Candidate[] = [];
    for (const pool of candidates) {
      const mint: string | undefined = pool.base?.mint;
      const [smartWallets, narrative, tokenInfo] = await Promise.allSettled([
        checkSmartWalletsOnPool({ pool_address: pool.pool }),
        mint ? getTokenNarrative({ mint }) : Promise.resolve(null),
        mint ? getTokenInfo({ query: mint }) : Promise.resolve(null),
      ]);
      allCandidates.push({
        pool,
        sw: smartWallets.status === "fulfilled" ? smartWallets.value : null,
        n: narrative.status === "fulfilled" ? narrative.value : null,
        ti: tokenInfo.status === "fulfilled" ? (tokenInfo.value as any)?.results?.[0] : null,
        mem: recallForPool(pool.pool),
      });
      await new Promise(r => setTimeout(r, 150));
    }

    // Hard filters
    const filteredOut: AnyObj[] = [];
    const passing: Candidate[] = allCandidates.filter(({ pool, ti }: Candidate) => {
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

    // Pre-fetch active_bin for all passing candidates in parallel
    const activeBinResults: PromiseSettledResult<any>[] = await Promise.allSettled(
      passing.map(({ pool }: Candidate) => getActiveBin({ pool_address: pool.pool }))
    );

    // Build compact candidate blocks
    const candidateBlocks: string[] = passing.map(({ pool, sw, n, ti, mem }: Candidate, i: number) => {
      const botPct: any = ti?.audit?.bot_holders_pct ?? "?";
      const top10Pct: any = ti?.audit?.top_holders_pct ?? "?";
      const feesSol: any = ti?.global_fees_sol ?? "?";
      const launchpad: string | null = ti?.launchpad ?? null;
      const priceChange: number | null = ti?.stats_1h?.price_change;
      const netBuyers: number | null = ti?.stats_1h?.net_buyers;
      const activeBin: any = activeBinResults[i]?.status === "fulfilled" ? activeBinResults[i].value?.binId : null;

      const okxParts: string = [
        pool.risk_level     != null ? `risk=${pool.risk_level}`               : null,
        pool.bundle_pct     != null ? `bundle=${pool.bundle_pct}%`            : null,
        pool.sniper_pct     != null ? `sniper=${pool.sniper_pct}%`            : null,
        pool.suspicious_pct != null ? `suspicious=${pool.suspicious_pct}%`    : null,
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
        `  smart_wallets: ${sw?.in_pool?.length ?? 0} present${sw?.in_pool?.length ? ` → CONFIDENCE BOOST (${sw.in_pool.map((w: any) => w.name).join(", ")})` : ""}`,
        activeBin != null ? `  active_bin: ${activeBin}` : null,
        priceChange != null ? `  1h: price${priceChange >= 0 ? "+" : ""}${priceChange}%, net_buyers=${netBuyers ?? "?"}` : null,
        n?.narrative ? `  narrative_untrusted: ${sanitizeUntrustedPromptText(n.narrative, 500)}` : `  narrative_untrusted: none`,
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
- Keep the whole report compact and highly scannable for Telegram.
    `, config.llm.maxSteps, [], "SCREENER", config.llm.screeningModel, 2048, {
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
    log("cron_error", `Screening cycle failed: ${error.message}`);
    screenReport = `Screening cycle failed: ${error.message}`;
  } finally {
    setScreeningBusy(false);
    if (!silent && telegramEnabled()) {
      if (screenReport) {
        if (liveMessage) await liveMessage.finalize(stripThink(screenReport)).catch(() => {});
        else sendLongMessage(`🔍 Screening Cycle\n\n${stripThink(screenReport)}`).catch(() => { });
      }
    }
  }
  return screenReport;
}
