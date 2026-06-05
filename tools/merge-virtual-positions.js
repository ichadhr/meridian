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
 *
 * Step 3 of meridian-wie (P1 cache-free refactor): now accepts an
 * optional `freshPnlMap` (Map<vpId, {pnl, activeBinId}>). When provided,
 * uses FRESH PnL computed by computePositionPnl — eliminating the
 * top/bottom display discrepancy where top section read stale cached
 * fields and bottom section read freshly-computed values. Falls back to
 * cached fields (with dual-name) when fresh pnl is absent (e.g., RPC
 * failure).
 */

export function mergeVirtualPositions(positions, vps, solPrice = 0, now = Date.now(), freshPnlMap = null) {
  if (!Array.isArray(vps) || vps.length === 0) {
    return { positions, total_positions: positions.length };
  }
  const solMode = solPrice > 0;

  // Dual-name fallback for VPs deployed before SOL fields were seeded, OR
  // for the fallback path when fresh PnL is unavailable.
  // Existing VPs in dry-run-state.json have no value_sol/total_fees_earned_sol/pnl_sol_pct
  // until the first management cycle runs and manage-virtual.js populates them.
  const valueSol = (vp) => vp.value_sol ?? vp.amount_sol ?? 0;
  const feesSol = (vp) => vp.total_fees_earned_sol ?? 0;
  const pnlSol = (vp) => vp.pnl_sol ?? 0;
  const pnlSolPct = (vp) => vp.pnl_sol_pct ?? 0;

  const merged = [...positions];
  for (const vp of vps) {
    const initialValue = vp.initial_value_usd;
    const fresh = freshPnlMap?.get(vp.id);

    // ── PnL field resolution ────────────────────────────────────────
    // Fresh path: use computePositionPnl result. Fallback: cached fields
    // (with dual-name for legacy VPs).
    let currentValue, pnlUsdValue, pnlPctValue, unclaimedFeesValue,
        totalValueUsd, pnlUsdDisplay, pnlPctDisplay, activeBinId, inRange;

    if (fresh && fresh.pnl) {
      // Fresh path: values come from computePositionPnl (no staleness)
      currentValue = fresh.pnl.currentValueUsd;
      pnlUsdValue = fresh.pnl.pnlUsd;
      pnlPctValue = fresh.pnl.pnlPct;
      unclaimedFeesValue = solMode ? fresh.pnl.unclaimedFeesSol : fresh.pnl.unclaimedFeesUsd;
      totalValueUsd = solMode ? fresh.pnl.positionValueSol : fresh.pnl.currentValueUsd;
      pnlUsdDisplay = solMode ? fresh.pnl.netPnlSol : fresh.pnl.pnlUsd;
      pnlPctDisplay = solMode ? fresh.pnl.pnlSolPct : fresh.pnl.pnlPct;
      activeBinId = fresh.activeBinId;
      // In-range uses LIVE activeBinId, not stale !vp._oor_since
      inRange = activeBinId != null
        && activeBinId >= vp.lower_bin
        && activeBinId <= vp.upper_bin;
    } else {
      // Fallback path: cached fields (dual-name for legacy)
      currentValue = vp.current_value_usd;
      pnlUsdValue = (currentValue != null && initialValue != null)
        ? currentValue - initialValue
        : null;
      pnlPctValue = (currentValue != null && initialValue != null && initialValue > 0)
        ? ((currentValue / initialValue - 1) * 100)
        : null;
      unclaimedFeesValue = solMode ? feesSol(vp) : (vp.total_fees_earned_usd ?? 0);
      totalValueUsd = solMode ? valueSol(vp) : (currentValue ?? initialValue ?? null);
      pnlUsdDisplay = solMode ? pnlSol(vp) : pnlUsdValue;
      pnlPctDisplay = solMode ? pnlSolPct(vp) : pnlPctValue;
      activeBinId = vp.active_bin_at_deploy ?? null;
      inRange = !vp._oor_since;
    }

    merged.push({
      position: `vp:${vp.id}`,
      pool: vp.pool,
      pair: vp.pair || vp.pool_name || String(vp.pool).slice(0, 8),
      base_mint: vp.base_mint || null,
      lower_bin: vp.lower_bin ?? null,
      upper_bin: vp.upper_bin ?? null,
      active_bin: activeBinId,
      in_range: inRange,
      // Polymorphic: SOL when solMode, USD when not. Matches getMyPositions convention.
      unclaimed_fees_usd: unclaimedFeesValue,
      total_value_usd:    totalValueUsd,
      pnl_usd:            pnlUsdDisplay,
      pnl_pct:            pnlPctDisplay,
      age_minutes: vp.deployed_at
        ? Math.floor((now - new Date(vp.deployed_at).getTime()) / 60000)
        : null,
      instruction: null,
      source: "virtual",
    });
  }
  return { positions: merged, total_positions: merged.length };
}
