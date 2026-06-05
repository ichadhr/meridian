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
export function mergeVirtualPositions(positions, vps, solPrice = 0, now = Date.now()) {
  if (!Array.isArray(vps) || vps.length === 0) {
    return { positions, total_positions: positions.length };
  }
  const solMode = solPrice > 0;

  // Lazy fallback for old VPs deployed before the SOL fields were seeded.
  // Existing VPs in dry-run-state.json have no value_sol/total_fees_earned_sol/pnl_sol_pct
  // until the first management cycle runs and manage-virtual.js populates them.
  const valueSol = (vp) => vp.value_sol ?? vp.amount_sol ?? 0;
  const feesSol = (vp) => vp.total_fees_earned_sol ?? 0;
  const pnlSol = (vp) => vp.pnl_sol ?? 0;
  const pnlSolPct = (vp) => vp.pnl_sol_pct ?? 0;

  const merged = [...positions];
  for (const vp of vps) {
    const initialValue = vp.initial_value_usd;
    const currentValue = vp.current_value_usd;
    const pnlUsd = (currentValue != null && initialValue != null)
      ? currentValue - initialValue
      : null;
    const pnlPct = (currentValue != null && initialValue != null && initialValue > 0)
      ? ((currentValue / initialValue - 1) * 100)
      : null;

    merged.push({
      position: `vp:${vp.id}`,
      pool: vp.pool,
      pair: vp.pair || vp.pool_name || String(vp.pool).slice(0, 8),
      base_mint: vp.base_mint || null,
      lower_bin: vp.lower_bin ?? null,
      upper_bin: vp.upper_bin ?? null,
      active_bin: vp.active_bin_at_deploy ?? null,
      in_range: !vp._oor_since,
      // Polymorphic: SOL when solMode, USD when not. Matches getMyPositions convention.
      unclaimed_fees_usd: solMode ? feesSol(vp) : (vp.total_fees_earned_usd ?? 0),
      total_value_usd:    solMode ? valueSol(vp) : (currentValue ?? initialValue ?? null),
      pnl_usd:            solMode ? pnlSol(vp) : pnlUsd,
      pnl_pct:            solMode ? pnlSolPct(vp) : pnlPct,
      age_minutes: vp.deployed_at
        ? Math.floor((now - new Date(vp.deployed_at).getTime()) / 60000)
        : null,
      instruction: null,
      source: "virtual",
    });
  }
  return { positions: merged, total_positions: merged.length };
}
