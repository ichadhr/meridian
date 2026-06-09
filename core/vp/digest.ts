/**
 * Virtual Digest — lightweight aggregated performance summary from VP closes.
 * Injected into the SCREENER prompt to provide pre-live signal without
 * polluting the main lessons/evolution system.
 *
 * Reads closed VPs from monthly archive files, computes win rates by
 * volatility bucket, fee_tvl_ratio bucket, and flags toxic pools.
 */

import { log } from "../../utils/logger.js";
import { readArchive } from "../archive.js";

function safeNum(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sum = arr.reduce((s, v) => s + safeNum(v), 0);
  return sum / arr.length;
}

interface ArchiveRecord {
  closed_at?: string;
  close_pnl_pct?: number;
  close_fees_usd?: number;
  total_fees_earned_usd?: number;
  volatility?: number;
  fee_tvl_ratio?: number;
  pool?: string;
  pair?: string;
  pool_name?: string;
  close_reason?: string;
  [key: string]: unknown;
}

interface PoolAgg {
  name: string;
  pnls: number[];
}

/**
 * Generate a compact digest string from recent VP closes.
 *
 * @param opts
 * @param opts.hours Lookback window (default 72)
 * @param opts.minCloses Minimum closes before showing digest (default 5)
 * @param opts.maxCloses Maximum positions to sample (default 10)
 * @returns Formatted digest or null if insufficient data
 */
export async function generateVirtualDigest({
  hours = 72,
  minCloses = 5,
  maxCloses = 10,
}: {
  hours?: number;
  minCloses?: number;
  maxCloses?: number;
} = {}): Promise<string | null> {
  const allClosed: ArchiveRecord[] = await readArchive({ source: "paper", hours, limit: maxCloses }) as ArchiveRecord[];

  const now = Date.now();
  const cutoffMs = hours * 60 * 60 * 1000;

  // Filter by closed_at; exclude VPs without a close timestamp
  const inWindow = allClosed.filter((vp) => {
    if (!vp.closed_at) return false;
    const closedAt = new Date(vp.closed_at).getTime();
    return Number.isFinite(closedAt) && now - closedAt <= cutoffMs;
  });

  // Sort chronologically so slice(-N) picks the most recent
  const sorted = inWindow.sort(
    (a, b) => new Date(a.closed_at!).getTime() - new Date(b.closed_at!).getTime(),
  );
  const sample = sorted.slice(-maxCloses);

  if (sample.length < minCloses) return null;

  // ── Basic stats ──────────────────────────────────────────────
  const winners   = sample.filter((vp) => safeNum(vp.close_pnl_pct) >= 0);
  const winRate   = (winners.length / sample.length) * 100;
  const avgPnl    = avg(sample.map((v) => v.close_pnl_pct ?? 0));
  const totalFees = sample.reduce((s, v) => s + safeNum(v.close_fees_usd ?? v.total_fees_earned_usd), 0);

  const lines: string[] = [
    `Closed: ${sample.length} | Win rate: ${winRate.toFixed(0)}% | Avg PnL: ${avgPnl >= 0 ? "+" : ""}${avgPnl.toFixed(1)}% | Fees: $${totalFees.toFixed(2)}`,
  ];

  // ── Patterns by volatility bucket ────────────────────────────
  if (sample.some((v) => v.volatility != null)) {
    const low  = sample.filter((v) => v.volatility != null && v.volatility < 2);
    const high = sample.filter((v) => v.volatility != null && v.volatility >= 4);

    for (const [label, bucket, threshold] of [
      ["high vol (≥4)", high, 3],
      ["low vol (<2)",  low,  3],
    ] as const) {
      if (bucket.length >= threshold) {
        const wins  = bucket.filter((v) => safeNum(v.close_pnl_pct) >= 0).length;
        const bAvg  = avg(bucket.map((v) => v.close_pnl_pct ?? 0));
        lines.push(`• ${label}: ${wins}/${bucket.length} wins, avg ${bAvg >= 0 ? "+" : ""}${bAvg.toFixed(1)}%`);
      }
    }
  }

  // ── Patterns by fee_tvl_ratio bucket ─────────────────────────
  if (sample.some((v) => v.fee_tvl_ratio != null)) {
    const lowFee  = sample.filter((v) => v.fee_tvl_ratio != null && v.fee_tvl_ratio < 0.03);
    const highFee = sample.filter((v) => v.fee_tvl_ratio != null && v.fee_tvl_ratio > 0.1);

    for (const [label, bucket, threshold] of [
      ["fee_tvl < 0.03", lowFee,  3],
      ["fee_tvl > 0.1",  highFee, 3],
    ] as const) {
      if (bucket.length >= threshold) {
        const bAvg = avg(bucket.map((v) => v.close_pnl_pct ?? 0));
        lines.push(`• ${label}: avg ${bAvg >= 0 ? "+" : ""}${bAvg.toFixed(1)}% (${bucket.length} closes)`);
      }
    }
  }

  // ── Toxic pools ─────────────────────────────────────────────
  const poolAgg: Record<string, PoolAgg> = {};
  for (const vp of sample) {
    const key = vp.pool ?? "";
    if (!poolAgg[key]) {
      poolAgg[key] = { name: vp.pair || vp.pool_name || key.slice(0, 8), pnls: [] };
    }
    poolAgg[key].pnls.push(safeNum(vp.close_pnl_pct ?? 0));
  }
  const toxicPools = Object.entries(poolAgg)
    .map(([pool, agg]) => {
      const poolAvg = avg(agg.pnls);
      return { pool, name: agg.name, avg: poolAvg, count: agg.pnls.length };
    })
    .filter((p) => p.count >= 2 && p.avg < -2)
    .sort((a, b) => a.avg - b.avg)
    .slice(0, 3);

  if (toxicPools.length > 0) {
    const toxicStr = toxicPools
      .map((p) => `${p.name} (${p.count}x, avg ${p.avg.toFixed(1)}%)`)
      .join(", ");
    lines.push(`⚠ Toxic: ${toxicStr}`);
  }

  // ── Close reason distribution ────────────────────────────────
  if (sample.length >= 3) {
    const reasons: Record<string, number> = {};
    for (const vp of sample) {
      const r = vp.close_reason || "unknown";
      reasons[r] = (reasons[r] || 0) + 1;
    }
    const reasonStr = Object.entries(reasons)
      .sort((a, b) => b[1] - a[1])
      .map(([r, c]) => `${r} (${c})`)
      .join(", ");
    lines.push(`Closes: ${reasonStr}`);
  }

  return lines.join("\n");
}
