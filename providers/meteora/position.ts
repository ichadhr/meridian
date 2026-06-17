// providers/meteora/position.ts
// Position lookup functions: single-position PnL, wallet positions (read-only).

// ─── Single-position PnL ─────────────────────────────────────
import { config } from "../../config/index.js";
import { log } from "../../utils/logger.js";
import { PublicKey } from "@solana/web3.js";
import { getWallet, getConnection, normalizeMint } from "../solana/wallet.js";
import { fetchDlmmPnlForPool } from "../solana/index.js";
import { safeNum, maybeNum, roundNum, deriveOpenPnlPct } from "./pnl.js";
import { getMyPositions } from "./core.js";
import { getDlmmProgramId } from "./dlmm.js";
import { shouldUseLpAgentRelay } from "../lpagent/relay.js";
import type { WalletPositionsResult } from "../../types/index.js";

/**
 * Get PnL snapshot for a single position. Prefers the Agent Meridian
 * LPAgent relay positions endpoint when enabled, otherwise queries the
 * Meteora PnL API. Returns a normalised shape regardless of source.
 */
export async function getPositionPnl({ pool_address, position_address }: { pool_address: string; position_address: string }): Promise<any> {
  pool_address = normalizeMint(pool_address);
  position_address = normalizeMint(position_address);
  const walletAddress = getWallet().publicKey.toString();
  if (shouldUseLpAgentRelay()) {
    try {
      const payload = await getMyPositions({ force: true, silent: true });
      const p = payload?.positions?.find((position: any) => position.position === position_address);
      if (p) {
        return {
          pnl_usd: p.pnl_usd,
          pnl_pct: p.pnl_pct,
          current_value_usd: p.total_value_usd,
          unclaimed_fee_usd: p.unclaimed_fees_usd,
          all_time_fees_usd: p.collected_fees_usd,
          fee_per_tvl_24h: p.fee_per_tvl_24h,
          in_range: p.in_range,
          lower_bin: p.lower_bin,
          upper_bin: p.upper_bin,
          active_bin: p.active_bin,
          age_minutes: p.age_minutes,
          request_id: payload?.request_id || null,
        };
      }
      log("pnl_warn", "Relay positions API did not include requested position; falling back to Meteora PnL path");
    } catch (error: any) {
      log("pnl_warn", `Relay PnL lookup failed; falling back to Meteora PnL path: ${error.message}`);
    }
  }
  try {
    const byAddress = await fetchDlmmPnlForPool(pool_address, walletAddress);
    if (byAddress._api_error) return { error: "PnL API unavailable — cannot evaluate position", api_available: false };
    const p = byAddress[position_address];
    if (!p) return { error: "Position not found in PnL API" };

    const solMode = config.management.solMode;
    const unclaimedValue = solMode
      ? safeNum(p.unrealizedPnl?.unclaimedFeeTokenX?.amountSol) + safeNum(p.unrealizedPnl?.unclaimedFeeTokenY?.amountSol)
      : safeNum(p.unrealizedPnl?.unclaimedFeeTokenX?.usd) + safeNum(p.unrealizedPnl?.unclaimedFeeTokenY?.usd);
    const currentValue = solMode
      ? safeNum(p.unrealizedPnl?.balancesSol)
      : safeNum(p.unrealizedPnl?.balances);
    const reportedPnlPct = solMode
      ? maybeNum(p.pnlSolPctChange)
      : maybeNum(p.pnlPctChange);
    const derivedPnlPct = deriveOpenPnlPct(p, solMode);
    return {
      pnl_usd:           roundNum(solMode ? p.pnlSol : p.pnlUsd, 4),
      pnl_pct:           roundNum(reportedPnlPct ?? derivedPnlPct ?? 0, 2),
      current_value_usd: roundNum(currentValue, 4),
      unclaimed_fee_usd: roundNum(unclaimedValue, 4),
      all_time_fees_usd: roundNum(solMode ? p.allTimeFees?.total?.sol : p.allTimeFees?.total?.usd, 4),
      fee_per_tvl_24h:   Math.round(parseFloat(p.feePerTvl24h || 0) * 100) / 100,
      in_range:    !p.isOutOfRange,
      lower_bin:   p.lowerBinId      ?? null,
      upper_bin:   p.upperBinId      ?? null,
      active_bin:  p.poolActiveBinId ?? null,
      age_minutes: p.createdAt ? Math.floor((Date.now() - p.createdAt * 1000) / 60000) : null,
    };
  } catch (error: any) {
    log("pnl_error", error.message);
    return { error: error.message };
  }
}

// ─── Read-only wallet positions ─────────────────────────────────
const DLMM_PROGRAM = getDlmmProgramId();

/**
 * Look up all open DLMM positions for a given wallet.
 * Read-only — no signing required. Returns bin range, PnL, value, and
 * age per position (when available from Meteora PnL API).
 */
export async function getWalletPositions({ wallet_address }: { wallet_address: string }): Promise<WalletPositionsResult> {
  try {
    const accounts = await getConnection().getProgramAccounts(DLMM_PROGRAM, {
      filters: [{ memcmp: { offset: 40, bytes: new PublicKey(wallet_address).toBase58() } }],
    });

    if (accounts.length === 0) {
      return { wallet: wallet_address, total_positions: 0, positions: [] };
    }

    const raw = accounts.map((acc: any) => ({
      position: acc.pubkey.toBase58(),
      pool: new PublicKey(acc.account.data.slice(8, 40)).toBase58(),
    }));

    const uniquePools = [...new Set(raw.map((r: any) => r.pool))];
    const pnlMaps = await Promise.all(uniquePools.map((pool) => fetchDlmmPnlForPool(pool, wallet_address)));
    const pnlByPool: Record<string, any> = {};
    uniquePools.forEach((pool: any, i: any) => { pnlByPool[pool] = pnlMaps[i]; });

    const positions = raw.map((r: any) => {
      const p = pnlByPool[r.pool]?.[r.position] || null;
      const solMode = config.management.solMode;
      const unclaimedValue = p
        ? solMode
          ? safeNum(p.unrealizedPnl?.unclaimedFeeTokenX?.amountSol) + safeNum(p.unrealizedPnl?.unclaimedFeeTokenY?.amountSol)
          : safeNum(p.unrealizedPnl?.unclaimedFeeTokenX?.usd) + safeNum(p.unrealizedPnl?.unclaimedFeeTokenY?.usd)
        : 0;
      const currentValue = p
        ? solMode
          ? safeNum(p.unrealizedPnl?.balancesSol)
          : safeNum(p.unrealizedPnl?.balances)
        : 0;
      const reportedPnlPct = p
        ? solMode
          ? maybeNum(p.pnlSolPctChange)
          : maybeNum(p.pnlPctChange)
        : null;
      const derivedPnlPct = p ? deriveOpenPnlPct(p, solMode) : null;

      return {
        position:           r.position,
        pool:               r.pool,
        lower_bin:          p?.lowerBinId      ?? null,
        upper_bin:          p?.upperBinId      ?? null,
        active_bin:         p?.poolActiveBinId ?? null,
        in_range:           p ? !p.isOutOfRange : null,
        unclaimed_fees_usd: roundNum(unclaimedValue, 4),
        total_value_usd:    roundNum(currentValue, 4),
        pnl_usd:            roundNum(p ? (solMode ? p.pnlSol : p.pnlUsd) : 0, 4),
        pnl_pct:            roundNum(reportedPnlPct ?? derivedPnlPct ?? 0, 2),
        age_minutes:        p?.createdAt ? Math.floor((Date.now() - p.createdAt * 1000) / 60000) : null,
      };
    });

    return { wallet: wallet_address, total_positions: positions.length, positions };
  } catch (error: any) {
    log("wallet_positions_error", error.message);
    return { wallet: wallet_address, total_positions: 0, positions: [], error: error.message };
  }
}
