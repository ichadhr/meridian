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
 * fields and bottom section read freshly-computed values.
 *
 * Step 7 of meridian-wie (schema reduction): when fresh PnL is absent
 * (RPC failure, solPrice fail, etc.) the function returns NULLS for
 * the affected fields. It does NOT fall back to stale cached fields —
 * the previous "dual-name fallback" re-introduced the exact bug Step 3
 * fixed (stale `!vp._oor_since` for in_range, frozen `vp.active_bin_at_deploy`
 * for active_bin). Brief nulls during a 30s RPC outage are far less
 * dangerous than stale "🟢 IN" when the VP is actually OOR.
 *
 * TODO(meridian-wie post-Step-7): the 5 pre-Step-7 VPs on the server
 * (vp_006, vp_007, vp_009, vp_011, vp_014) still carry legacy fields
 * (value_sol, pnl_sol_pct, total_fees_earned_usd, current_value_usd)
 * in dry-run-state.json. They are no longer read or written by the
 * new code path — they are "dead data". When all 5 close naturally
 * (1-2 weeks typical), do a one-time sweep to delete these dead
 * fields from any surviving pre-Step-7 VPs and remove this TODO.
 */

export function mergeVirtualPositions(positions, vps, solPrice = 0, now = Date.now(), freshPnlMap = null) {
  if (!Array.isArray(vps) || vps.length === 0) {
    return { positions, total_positions: positions.length };
  }
  const solMode = solPrice > 0;

  const merged = [...positions];
  for (const vp of vps) {
    const fresh = freshPnlMap?.get(vp.id);

    // ── PnL field resolution ────────────────────────────────────────
    // Fresh path: use computePositionPnl result. No-fresh path: return nulls.
    // The old fallback to cached fields is removed — it was a "revert to
    // the bug we just fixed" anti-pattern.
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
      // No fresh PnL available (RPC fail, solPrice fail, etc.).
      // Return nulls — do NOT fall back to stale cached fields.
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
