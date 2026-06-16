// cli/orchestrate.ts — Orchestration functions used by both CLI and Telegram handlers
// Extracted from index.ts to break the circular dependency between index.ts ↔ handlers.ts.

import { getTopCandidates } from "../providers/meteora/index.js";
import { getWalletBalances } from "../providers/solana/index.js";
import { config, computeDeployAmount, computeBinsBelow } from "../config/index.js";
import { executeTool } from "../llm/index.js";
import { getLoneCandidateSkipReason, appendDecision, checkSmartWalletsOnPool } from "../core/index.js";
import { getTokenNarrative, getTokenInfo } from "../providers/jupiter/index.js";
import { setLatestCandidates, getLatestCandidatesMeta } from "./repl.js";

export async function runDeterministicScreen(limit: number = 5): Promise<string> {
  const top: any = await getTopCandidates({ limit });
  const candidates: any[] = (top?.candidates || top?.pools || []).slice(0, limit);
  setLatestCandidates(candidates);
  if (candidates.length > 0) {
    const lines: string[] = candidates.map((pool: any, i: number) => {
      const feeTvl = pool.fee_active_tvl_ratio ?? pool.fee_tvl_ratio ?? "?";
      const vol = pool.volume_window ?? pool.volume_24h ?? "?";
      return `${i + 1}. ${pool.name} | ${pool.pool}\n   fee/aTVL ${feeTvl}% | vol $${vol} | organic ${pool.organic_score ?? "?"}`;
    });
    return `Top candidates (${candidates.length})\n\n${lines.join("\n")}`;
  }
  const examples: string = (top?.filtered_examples || []).slice(0, 3)
    .map((entry: any) => `- ${entry.name}: ${entry.reason}`)
    .join("\n");
  return examples
    ? `No candidates available.\nFiltered examples:\n${examples}`
    : "No candidates available right now.";
}

export async function deployLatestCandidate(index: number): Promise<{ result: any; candidate: any; deployAmount: number; binsBelow: number }> {
  const meta = getLatestCandidatesMeta();
  const candidate: any = meta.candidates[index];
  if (!candidate) {
    throw new Error("Invalid candidate index. Run /screen first.");
  }
  if (meta.candidates.length === 1) {
    const mint: string | null = candidate.base?.mint || candidate.base_mint || null;
    const [smartWallets, narrative, tokenInfo] = await Promise.allSettled([
      checkSmartWalletsOnPool({ pool_address: candidate.pool }),
      mint ? getTokenNarrative({ mint }) : Promise.resolve(null),
      mint ? getTokenInfo({ query: mint }) : Promise.resolve(null),
    ]);
    const context: any = {
      pool: candidate,
      sw: smartWallets.status === "fulfilled" ? smartWallets.value : null,
      swFailed: smartWallets.status === "rejected",
      n: narrative.status === "fulfilled" ? narrative.value : null,
      nFailed: narrative.status === "rejected",
      ti: tokenInfo.status === "fulfilled" ? (tokenInfo.value as any)?.results?.[0] : null,
      mem: null,
    };
    const skipReason: string | null = getLoneCandidateSkipReason(context);
    if (skipReason) {
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "Single cached candidate skipped",
        reason: skipReason,
        pool: candidate.pool,
        pool_name: candidate.name,
      });
      throw new Error(`NO DEPLOY: only cached candidate ${candidate.name} is not worth deploying — ${skipReason}`);
    }
  }
  const deployAmount: number = computeDeployAmount((await getWalletBalances()).sol);
  const binsBelow: number = computeBinsBelow(candidate.volatility);
  const result: any = await executeTool("deploy_position", {
    pool_address: candidate.pool,
    amount_y: deployAmount,
    strategy: config.strategy.strategy,
    bins_below: binsBelow,
    bins_above: 0,
    pool_name: candidate.name,
    base_mint: candidate.base?.mint || candidate.base_mint || null,
    bin_step: candidate.bin_step,
    base_fee: candidate.base_fee,
    volatility: candidate.volatility,
    fee_tvl_ratio: candidate.fee_active_tvl_ratio ?? candidate.fee_tvl_ratio,
    organic_score: candidate.organic_score,
  });
  if (result?.success === false || result?.error) {
    throw new Error(result.error || "Deploy failed");
  }
  return { result, candidate, deployAmount, binsBelow };
}
