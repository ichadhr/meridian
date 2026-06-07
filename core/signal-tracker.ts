// core/signal-tracker.ts — Stages screening signals for later attribution
import { log } from "../utils/logger.js";

export interface StagedSignals {
  organic_score?: number;
  fee_tvl_ratio?: number;
  volume?: number;
  mcap?: number;
  holder_count?: number;
  smart_wallets_present?: boolean;
  narrative_quality?: string;
  study_win_rate?: number;
  hive_consensus?: number;
  volatility?: number;
  base_mint?: string;
  baseMint?: string;
  [key: string]: unknown;
}

// In-memory staging area — cleared after retrieval or after 10 minutes
const _staged = new Map<string, StagedSignals & { staged_at: number }>();
const _stagedByBaseMint = new Map<string, string>();
const STAGE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function normalizeKey(value: unknown): string | null {
  return value ? String(value).trim() : null;
}

function cleanupStale(): void {
  const now = Date.now();
  for (const [addr, data] of _staged) {
    if (now - data.staged_at > STAGE_TTL_MS) {
      _staged.delete(addr);
      if (data.base_mint && _stagedByBaseMint.get(data.base_mint) === addr) {
        _stagedByBaseMint.delete(data.base_mint);
      }
    }
  }
}

/**
 * Stage signals for a pool during screening.
 */
export function stageSignals(poolAddress: string, signals: StagedSignals): void {
  cleanupStale();
  const poolKey = normalizeKey(poolAddress);
  if (!poolKey) return;

  const baseMint = normalizeKey(signals.base_mint ?? signals.baseMint);
  _staged.set(poolKey, {
    ...signals,
    base_mint: baseMint ?? signals.base_mint ?? undefined,
    staged_at: Date.now(),
  });
  if (baseMint) {
    _stagedByBaseMint.set(baseMint, poolKey);
  }
}

/**
 * Retrieve and clear staged signals for a pool.
 */
export function getAndClearStagedSignals(poolAddress: string, baseMint: string | null = null): StagedSignals | null {
  cleanupStale();

  let poolKey: string | null = normalizeKey(poolAddress);
  let data = poolKey ? _staged.get(poolKey) : undefined;

  if (!data && baseMint) {
    const baseKey = normalizeKey(baseMint);
    poolKey = baseKey ? (_stagedByBaseMint.get(baseKey) ?? null) : null;
    data = poolKey ? _staged.get(poolKey) : undefined;
  }

  if (!data) return null;
  if (poolKey) {
    _staged.delete(poolKey);
  }
  if (data.base_mint && _stagedByBaseMint.get(data.base_mint) === poolKey) {
    _stagedByBaseMint.delete(data.base_mint);
  }
  const { staged_at: _staged_at, ...signals } = data;
  log("signals", `Retrieved staged signals for ${(poolKey ?? "").slice(0, 8)}: ${Object.keys(signals).filter(k => signals[k] != null).length} signals`);
  return signals;
}

/**
 * Get all currently staged pool addresses (for debugging).
 */
export function getStagedPools(): string[] {
  cleanupStale();
  return [..._staged.keys()];
}
