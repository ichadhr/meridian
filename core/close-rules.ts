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
 */

export interface CloseRulePosition {
  upper_bin?: number;
  active_bin?: number;
  pnl_pct?: number;
  total_value_usd?: number;
  unclaimed_fees_usd?: number;
  deployed_at?: string;
  snapshots?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface CloseRuleConfig {
  stopLossPct?: number;
  takeProfitPct?: number;
  outOfRangeBinsToClose?: number;
  outOfRangeWaitMinutes?: number;
  minFeePerTvl24h?: number;
  minAgeBeforeYieldCheck?: number;
  vpTrendExitCycles?: number;
  solMode?: boolean;
  [key: string]: unknown;
}

export interface CloseRuleResult {
  action: "CLOSE";
  rule: number;
  reason: string;
}

export function getVirtualCloseRule(
  position: CloseRulePosition,
  managementConfig: CloseRuleConfig,
  effectiveOorMinutes = 0
): CloseRuleResult | null {
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
  if (!pnlSuspect && position.pnl_pct != null && takeProfitPct != null && position.pnl_pct >= takeProfitPct) {
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
  const minFeePerTvl24h = managementConfig.minFeePerTvl24h ?? 7;
  const minAgeForYieldCheck = managementConfig.minAgeBeforeYieldCheck ?? 60;
  const ageMinutes = position.deployed_at
    ? Math.floor((Date.now() - new Date(position.deployed_at).getTime()) / 60000)
    : 0;

  if (ageMinutes >= minAgeForYieldCheck && (position.total_value_usd ?? 0) > 0) {
    const totalValue = position.total_value_usd ?? 0;
    const currentFees = position.unclaimed_fees_usd || 0;
    const syntheticFeeYield = (currentFees / totalValue) * (1440 / ageMinutes) * 100;
    if (syntheticFeeYield < minFeePerTvl24h) {
      return { action: "CLOSE", rule: 5, reason: "low yield" };
    }
  }

  // Rule 6: Consecutive down trend exit (early warning).
  const trendCycles = managementConfig.vpTrendExitCycles ?? 3;
  if (trendCycles != null && trendCycles > 0 && position.snapshots && position.snapshots.length >= trendCycles + 1) {
    const isSol = !!managementConfig.solMode;
    const pnlField = isSol ? "pnl_sol_pct" : "pnl_pct";

    const recent = position.snapshots.slice(-(trendCycles + 1));
    const currentPnl = (recent[recent.length - 1][pnlField] as number) ?? (recent[recent.length - 1].pnl_pct as number) ?? 0;

    // Rule only applies when currently in a loss
    if (currentPnl < 0) {
      let isTrendingDown = true;
      for (let i = 1; i < recent.length; i++) {
        const prev = (recent[i - 1][pnlField] as number) ?? (recent[i - 1].pnl_pct as number) ?? 0;
        const curr = (recent[i][pnlField] as number) ?? (recent[i].pnl_pct as number) ?? 0;
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
