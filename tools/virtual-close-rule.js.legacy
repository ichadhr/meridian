/**
 * getVirtualCloseRule — pure function that decides whether a VP should close.
 *
 * Extracted from tools/manage-virtual.js to make it testable without pulling
 * in the full runtime (RPC, wallet, gas estimator, envcrypt). Mirrors the
 * signature shape of the live getDeterministicCloseRule in index.js:992.
 *
 * Rules (in order, first match wins):
 *   1. Stop loss     — pnl_pct <= stopLossPct
 *   2. Take profit   — pnl_pct >= takeProfitPct
 *   3. Pumped above  — active_bin > upper_bin + outOfRangeBinsToClose
 *   4. OOR too long  — active_bin > upper_bin AND effectiveOorMinutes >= outOfRangeWaitMinutes
 *   5. Low yield     — synthetic 24h fee/TVL ratio < minFeePerTvl24h
 *   6. Trend exit    — vpTrendExitCycles consecutive down snapshots
 *
 * Polymorphic unit contract for Rules 1-5: position.pnl_pct,
 * position.total_value_usd, and position.unclaimed_fees_usd are
 * polymorphic — SOL values when solMode=true, USD when solMode=false.
 * The caller (runVirtualManagementCycle) is responsible for selecting
 * the unit based on config.management.solMode.
 *
 * Note (Step 7, meridian-wie): Rule 5 no longer reads
 * position.total_fees_earned_usd (the lifetime accumulator was a lie
 * for a "is it earning right now?" check). It now reads
 * position.unclaimed_fees_usd (current cycle's pending fees).
 *
 * Rule 6 exception: the function DOES read managementConfig.solMode to
 * decide whether to compare pnl_sol_pct or pnl_pct from the snapshot
 * history. Snapshots are stored with both fields, so this is just a
 * field-name selector, not a unit conversion.
 *
 * @param {object} position          Polymorphic VP snapshot (matches live position shape)
 * @param {object} managementConfig  Management config (takeProfitPct, stopLossPct, etc.)
 * @param {number} effectiveOorMinutes  This cycle's accumulated OOR minutes (avoids stale stored value)
 * @returns {object|null}            { action, rule, reason } or null if no close
 */
export function getVirtualCloseRule(position, managementConfig, effectiveOorMinutes = 0) {
  const stopLossPct = managementConfig.stopLossPct ?? -50;
  const takeProfitPct = managementConfig.takeProfitPct;
  const oorWaitMinutes = managementConfig.outOfRangeWaitMinutes ?? 30;

  // Guard against corrupted position state
  if (position.upper_bin == null || position.active_bin == null) return null;

  // Suspect PnL: a huge negative PnL while the position still has value
  // usually means the bin state went wrong. Skip PnL-based rules.
  const pnlSuspect = position.pnl_pct != null
    && position.pnl_pct < -90
    && (position.total_value_usd ?? 0) > 0.01;

  // Stop loss
  if (!pnlSuspect && position.pnl_pct != null && position.pnl_pct <= stopLossPct) {
    return { action: "CLOSE", rule: 1, reason: "stop loss" };
  }

  // Take profit
  if (!pnlSuspect && position.pnl_pct != null && position.pnl_pct >= takeProfitPct) {
    return { action: "CLOSE", rule: 2, reason: "take profit" };
  }

  // Pumped far above range
  const oorBinsToClose = managementConfig.outOfRangeBinsToClose ?? 5;
  if (position.active_bin > position.upper_bin + oorBinsToClose) {
    return { action: "CLOSE", rule: 3, reason: "pumped far above range" };
  }

  // OOR too long
  if (position.active_bin > position.upper_bin && effectiveOorMinutes >= oorWaitMinutes) {
    return { action: "CLOSE", rule: 4, reason: "OOR" };
  }

  // Low yield — synthetic approximation of live Rule 5.
  // Live uses Meteora API's fee_per_tvl_24h; VP computes a backward-looking
  // equivalent from its own accumulated fee data:
  //   syntheticYield = (totalFees / currentValue) * (1440 / ageMinutes) * 100
  // Extrapolates the actual fee-to-TVL ratio to a 24h window.
  // Numerator and denominator are in the SAME unit (both polymorphic), so
  // the ratio is unit-agnostic. The threshold (minFeePerTvl24h) is a % ratio.
  const minFeePerTvl24h = managementConfig.minFeePerTvl24h ?? 7;
  const minAgeForYieldCheck = managementConfig.minAgeBeforeYieldCheck ?? 60;
  const ageMinutes = position.deployed_at
    ? Math.floor((Date.now() - new Date(position.deployed_at).getTime()) / 60000)
    : 0;

  if (ageMinutes >= minAgeForYieldCheck && (position.total_value_usd ?? 0) > 0) {
    // Step 7 (meridian-wie): use unclaimed_fees_usd (current cycle's pending
    // fees) instead of total_fees_earned_usd (lifetime accumulated). The
    // current cycle's unclaimed is the better "is this position earning
    // right now?" signal. Lifetime accumulation is misleading — a position
    // could have high lifetime fees but be stagnant right now.
    const currentFees = position.unclaimed_fees_usd || 0;
    const syntheticFeeYield = (currentFees / position.total_value_usd) * (1440 / ageMinutes) * 100;
    if (syntheticFeeYield < minFeePerTvl24h) {
      return { action: "CLOSE", rule: 5, reason: "low yield" };
    }
  }

  // Rule 6: Consecutive down trend exit (early warning).
  // Snapshots store BOTH pnl_pct (USD) and pnl_sol_pct (SOL). The function
  // reads managementConfig.solMode to pick the field name. For old snapshots
  // lacking pnl_sol_pct, the fallback to pnl_pct (USD) keeps the direction
  // check valid within a single snapshot pair (units stay consistent).
  const trendCycles = managementConfig.vpTrendExitCycles ?? 3;
  if (trendCycles != null && trendCycles > 0 && position.snapshots && position.snapshots.length >= trendCycles + 1) {
    const isSol = !!managementConfig.solMode;
    const pnlField = isSol ? "pnl_sol_pct" : "pnl_pct";

    const recent = position.snapshots.slice(-(trendCycles + 1));
    const currentPnl = recent[recent.length - 1][pnlField] ?? recent[recent.length - 1].pnl_pct ?? 0;

    // Rule only applies when currently in a loss
    if (currentPnl < 0) {
      let isTrendingDown = true;
      for (let i = 1; i < recent.length; i++) {
        // Fall back to pnl_pct when pnl_sol_pct is missing (pre-fix snapshots)
        const prev = recent[i - 1][pnlField] ?? recent[i - 1].pnl_pct ?? 0;
        const curr = recent[i][pnlField] ?? recent[i].pnl_pct ?? 0;
        if (curr >= prev) {
          isTrendingDown = false;
          break;
        }
      }
      if (isTrendingDown) {
        return { action: "CLOSE", rule: 6, reason: `consecutive down-trend (${trendCycles} cycles)` };
      }
    }
  }

  return null;
}
