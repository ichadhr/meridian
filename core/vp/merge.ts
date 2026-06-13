/**
 * Pure merge helper — combines on-chain positions with virtual positions
 * (VPs) for the LLM-facing getMyPositions() view.
 *
 * Lives in its own file (no side-effecting imports) so tests can import
 * it without loading envcrypt, RPC, or wallet balance modules.
 *
 * Polymorphic `_usd` convention: when solMode is true (solPrice > 0),
 * the merged `_usd` fields contain SOL values (matching getMyPositions).
 * When solMode is false (solPrice = 0), they contain USD values.
 */

import type { VpPosition } from "../../types/index.js";

export interface VpMergedPosition {
  position: string;
  pool: string;
  pair: string;
  base_mint: string | null;
  lower_bin: number | null;
  upper_bin: number | null;
  active_bin: number | null;
  in_range: boolean | null;
  unclaimed_fees_usd: number | null;
  total_value_usd: number | null;
  pnl_usd: number | null;
  pnl_pct: number | null;
  age_minutes: number | null;
  instruction: string | null;
  source: string;
  [key: string]: unknown;
}

export interface VpMergeFreshPnl {
  pnl?: {
    currentValueUsd: number;
    pnlUsd: number;
    pnlPct: number;
    unclaimedFeesSol: number;
    unclaimedFeesUsd: number;
    positionValueSol: number;
    netPnlSol: number;
    pnlSolPct: number;
  };
  activeBinId?: number;
}

export function mergeVpPositions(
  positions: VpMergedPosition[],
  vps: VpPosition[],
  solPrice = 0,
  now = Date.now(),
  freshPnlMap: Map<string, VpMergeFreshPnl> | null = null
): { positions: VpMergedPosition[]; total_positions: number } {
  if (!Array.isArray(vps) || vps.length === 0) {
    return { positions, total_positions: positions.length };
  }
  const solMode = solPrice > 0;

  const merged = [...positions];
  for (const vp of vps) {
    const fresh = freshPnlMap?.get(vp.id);

    // ── PnL field resolution ────────────────────────────────────────
    let currentValue: number | null, pnlUsdValue: number | null, pnlPctValue: number | null,
        unclaimedFeesValue: number | null, totalValueUsd: number | null,
        pnlUsdDisplay: number | null, pnlPctDisplay: number | null,
        activeBinId: number | null, inRange: boolean | null;

    if (fresh && fresh.pnl) {
      currentValue = fresh.pnl.currentValueUsd;
      pnlUsdValue = fresh.pnl.pnlUsd;
      pnlPctValue = fresh.pnl.pnlPct;
      unclaimedFeesValue = solMode ? fresh.pnl.unclaimedFeesSol : fresh.pnl.unclaimedFeesUsd;
      totalValueUsd = solMode ? fresh.pnl.positionValueSol : fresh.pnl.currentValueUsd;
      pnlUsdDisplay = solMode ? fresh.pnl.netPnlSol : fresh.pnl.pnlUsd;
      pnlPctDisplay = solMode ? fresh.pnl.pnlSolPct : fresh.pnl.pnlPct;
      activeBinId = fresh.activeBinId ?? null;
      inRange = activeBinId != null
        && activeBinId >= (vp.lower_bin ?? 0)
        && activeBinId <= (vp.upper_bin ?? 0);
    } else {
      currentValue = null;
      pnlUsdValue = null;
      pnlPctValue = null;
      unclaimedFeesValue = null;
      totalValueUsd = null;
      pnlUsdDisplay = null;
      pnlPctDisplay = null;
      activeBinId = null;
      inRange = null;
    }

    const deployedAt = vp.deployed_at ? new Date(vp.deployed_at).getTime() : null;
    const ageMinutes = deployedAt != null && Number.isFinite(deployedAt)
      ? Math.floor((now - deployedAt) / 60000)
      : null;

    merged.push({
      position: `vp:${vp.id}`,
      pool: vp.pool,
      pair: vp.pair || vp.pool_name || vp.pool.slice(0, 8),
      base_mint: vp.base_mint || null,
      lower_bin: vp.lower_bin ?? null,
      upper_bin: vp.upper_bin ?? null,
      active_bin: activeBinId,
      in_range: inRange,
      unclaimed_fees_usd: unclaimedFeesValue,
      total_value_usd:    totalValueUsd,
      pnl_usd:            pnlUsdDisplay,
      pnl_pct:            pnlPctDisplay,
      age_minutes: ageMinutes,
      instruction: (vp.instruction as string | null) || null,
      source: "virtual",
    });
  }
  return { positions: merged, total_positions: merged.length };
}
