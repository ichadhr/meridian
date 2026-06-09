import { agentMeridianJson, getAgentMeridianHeaders } from "../../providers/hivemind/index.js";

interface TopLpEntry {
  owner: string;
  ownerShort?: string;
  totalLp?: number;
  avgAgeHours?: number;
  pnlPerInflowPct?: number;
  feePercent?: number;
  totalPnlUsd?: number;
  totalInflowUsd?: number;
  winRatePct?: number;
  roiPct?: number;
}

interface HistoricalOwner {
  owner: string;
  preferredStrategy?: string;
  preferredRangeStyle?: string;
  topPositions?: Array<{
    ageHours?: number;
    pnlUsd?: number;
    pnlPct?: number;
    feeUsd?: number;
    inRange?: boolean;
    strategy?: string;
    rangeStyle?: string;
    inputValue?: number;
    feePercent?: number;
    widthBins?: number;
    lowerBinId?: number;
    upperBinId?: number;
  }>;
  avgHoldHours?: number;
  avgPnlPct?: number;
  avgFeePercent?: number;
}

interface PoolOverview {
  name?: string;
  tokenXSymbol?: string;
  tokenYSymbol?: string;
}

interface StudyResult {
  pool: string;
  pool_name?: string;
  message: string;
  patterns: Record<string, unknown>;
  lpers: Array<Record<string, unknown>>;
}

export async function studyTopLPers({
  pool_address,
  limit = 4,
}: {
  pool_address: string;
  limit?: number;
}): Promise<StudyResult> {
  const [poolRes, signalRes] = await Promise.all([
    fetchTopLp(pool_address),
    fetchStudyTopLp(pool_address),
  ]);

  const poolData = poolRes;
  const signalData = signalRes;
  const topLpers: TopLpEntry[] = Array.isArray(poolData.topLpers)
    ? (poolData.topLpers as TopLpEntry[])
    : [];
  const historicalOwners: HistoricalOwner[] = Array.isArray(poolData.historicalOwners)
    ? (poolData.historicalOwners as HistoricalOwner[])
    : [];
  const ranked = topLpers.slice(0, Math.max(1, limit));

  if (!ranked.length) {
    return {
      pool: pool_address,
      message: "No LPAgent top LPer data found for this pool yet.",
      patterns: {},
      lpers: [],
    };
  }

  const historicalMap = new Map(historicalOwners.map((owner) => [owner.owner, owner]));

  const lpers = ranked.map((owner) => {
    const history = historicalMap.get(owner.owner);
    return {
      owner: owner.owner,
      owner_short: owner.ownerShort || `${owner.owner.slice(0, 8)}...`,
      signal_tags: [
        history?.preferredStrategy ? `strategy:${history.preferredStrategy}` : null,
        history?.preferredRangeStyle ? `range:${history.preferredRangeStyle}` : null,
      ].filter(Boolean),
      summary: {
        total_positions: owner.totalLp || history?.topPositions?.length || 0,
        avg_hold_hours: round(owner.avgAgeHours ?? history?.avgHoldHours ?? 0, 2),
        avg_open_pnl_pct: round(owner.pnlPerInflowPct ?? history?.avgPnlPct ?? 0, 2),
        avg_fee_per_tvl_24h_pct: round(owner.feePercent ?? history?.avgFeePercent ?? 0, 2),
        total_pnl_usd: round(owner.totalPnlUsd ?? 0, 2),
        total_balance_usd: round(owner.totalInflowUsd ?? 0, 2),
        avg_range_width_pct: null,
        avg_distance_to_active_pct: null,
        win_rate: round((owner.winRatePct ?? 0) / 100, 2),
        roi: round((owner.roiPct ?? 0) / 100, 4),
        fee_pct_of_capital: round(owner.feePercent ?? 0, 2),
        preferred_strategy: history?.preferredStrategy || "unknown",
        preferred_range_style: history?.preferredRangeStyle || "unknown",
      },
      positions: Array.isArray(history?.topPositions)
        ? history.topPositions.map((position) => ({
            pool: pool_address,
            pair: (poolData.overview as PoolOverview)?.name || "Unknown pool",
            hold_hours: round(position.ageHours ?? 0, 2),
            pnl_usd: round(position.pnlUsd ?? 0, 2),
            pnl_pct: fmtPct(position.pnlPct),
            fee_usd: round(position.feeUsd ?? 0, 2),
            in_range_pct: position.inRange == null ? null : position.inRange ? 100 : 0,
            strategy: position.strategy || null,
            closed_reason: position.rangeStyle || null,
            balance_usd: round(position.inputValue ?? 0, 2),
            fee_per_tvl_24h_pct: round(position.feePercent ?? 0, 2),
            range_width_pct: position.widthBins ?? null,
            distance_to_active_pct: null,
            lower_bin_id: position.lowerBinId ?? null,
            upper_bin_id: position.upperBinId ?? null,
          }))
        : [],
    };
  });

  const overview = (poolData.overview || {}) as PoolOverview;
  const patterns = buildPatterns(ranked, historicalOwners, signalData, overview);

  return {
    pool: pool_address,
    pool_name:
      overview.name ||
      `${overview.tokenXSymbol || "TOKEN"}-${overview.tokenYSymbol || "SOL"}`,
    message:
      "LPAgent-backed top LP study from Agent Meridian 30m cached owner aggregates plus owner historical positions.",
    patterns,
    lpers,
  };
}

function fetchTopLp(poolAddress: string): Promise<Record<string, unknown>> {
  return agentMeridianJson(`/top-lp/${poolAddress}`, {
    headers: getAgentMeridianHeaders(),
  });
}

function fetchStudyTopLp(poolAddress: string): Promise<Record<string, unknown>> {
  return agentMeridianJson(`/study-top-lp/${poolAddress}`, {
    headers: getAgentMeridianHeaders(),
  });
}

function buildPatterns(
  ranked: TopLpEntry[],
  historicalOwners: HistoricalOwner[],
  signalData: Record<string, unknown>,
  overview: PoolOverview,
): Record<string, unknown> {
  const avgHold = avg(ranked.map((o) => o.avgAgeHours).filter((v): v is number => isNum(v)));
  const avgOpenPnlPct = avg(ranked.map((o) => o.pnlPerInflowPct).filter((v): v is number => isNum(v)));
  const avgFeePct = avg(ranked.map((o) => o.feePercent).filter((v): v is number => isNum(v)));
  const avgRoiPct = avg(ranked.map((o) => o.roiPct).filter((v): v is number => isNum(v)));
  const preferredStrategies = countValues(
    historicalOwners.map((o) => o.preferredStrategy).filter(Boolean) as string[],
  );
  const preferredRanges = countValues(
    historicalOwners.map((o) => o.preferredRangeStyle).filter(Boolean) as string[],
  );

  return {
    top_lper_count: ranked.length,
    study_mode: "lpagent_top_lpers",
    pool_name:
      overview.name || `${overview.tokenXSymbol || "TOKEN"}-${overview.tokenYSymbol || "SOL"}`,
    active_position_count: signalData.activePositionCount ?? ranked.length,
    owner_count: signalData.ownerCount ?? ranked.length,
    avg_hold_hours: round(avgHold, 2),
    avg_open_pnl_pct: round(avgOpenPnlPct, 2),
    avg_fee_percent: round(avgFeePct, 2),
    avg_roi_pct: round(avgRoiPct, 2),
    best_open_pnl_pct: ranked[0]
      ? `${round(ranked[0].pnlPerInflowPct || 0, 2)}%`
      : null,
    scalper_count: ranked.filter((o) => (o.avgAgeHours || 0) < 1).length,
    holder_count: ranked.filter((o) => (o.avgAgeHours || 0) >= 4).length,
    preferred_strategies: preferredStrategies,
    preferred_range_styles: preferredRanges,
    top_historical_owners: ((signalData.topHistoricalOwners as unknown[]) || []).slice(0, 3),
    suggested_style: signalData.suggestedStyle || null,
  };
}

function countValues(values: string[]): Record<string, number> {
  const map = new Map<string, number>();
  for (const value of values) {
    map.set(value, (map.get(value) || 0) + 1);
  }
  return Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1]));
}

function avg(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function round(value: number, digits = 2): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(digits));
}

function isNum(value: unknown): boolean {
  return Number.isFinite(Number(value));
}

function fmtPct(value: unknown): string {
  const n = Number(value || 0);
  return `${n >= 0 ? "+" : ""}${round(n, 2)}%`;
}
