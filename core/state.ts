/**
 * Core state dispatcher — routes state calls to Live or Virtual Position submodules.
 */

import { log } from "../utils/logger.js";
import { config } from "../config/index.js";
import { getMyPositions as getLivePositionsOnChain, getBinsInRange } from "../providers/meteora/index.js";
import { fetchSolPrice } from "../providers/jupiter/index.js";
import { computePositionPnl } from "./pnl.js";
import type { StateSummary } from "../types/index.js";

// Live state imports
import {
  load as loadLiveState,
  save as saveLiveState,
  trackLivePosition,
  recordLiveClose,
  setLivePositionInstruction,
  minutesLiveOutOfRange,
  getLivePosition,
  getLivePositions,
} from "./live/state.js";

// VP state imports
import {
  trackVpPosition,
  listVpPositions,
  updateVpPosition,
  getVpPosition,
} from "./vp/state.js";
import { closeVpPosition } from "./vp/manage.js";
import { mergeVpPositions } from "./vp/merge.js";
import { readArchive } from "./archive.js";

// ─── Dispatcher getMyPositions ───────────────────────────────────

export async function getMyPositions(options?: { force?: boolean }) {
  // 1. Fetch live positions from Meteora API
  let liveResult = { wallet: null, total_positions: 0, positions: [], request_id: null, error: undefined };
  try {
    liveResult = await getLivePositionsOnChain(options) as any;
  } catch (err: any) {
    log("state", `On-chain getMyPositions failed: ${err.message}`);
    liveResult.error = err.message;
  }
  
  const livePositions = liveResult.positions || [];
  
  // 2. Fetch VPs from listVpPositions
  const openVps = listVpPositions("open");
  
  // 3. For each VP, compute fresh PnL to construct the freshPnlMap
  const freshPnlMap = new Map();
  const solPrice = await fetchSolPrice().catch(() => null);
  
  if (openVps.length > 0 && solPrice != null) {
    await Promise.all(openVps.map(async (vp) => {
      try {
        const binResult = await getBinsInRange({
          pool_address: vp.pool,
          lower_bin: vp.lower_bin!,
          upper_bin: vp.upper_bin!,
        });
        const poolParams = binResult.binStep != null && binResult.sParameter != null && binResult.vParameter != null
          ? { binStep: binResult.binStep, sParameter: binResult.sParameter, vParameter: binResult.vParameter }
          : null;
        const pnl = computePositionPnl(vp as any, binResult.bins, solPrice, {
          activeBinId: binResult.activeBin,
          poolParams: poolParams ?? undefined,
        });
        freshPnlMap.set(vp.id, { pnl, activeBinId: binResult.activeBin });
      } catch (err: any) {
        log("state", `Failed to get fresh PnL for VP ${vp.id} during getMyPositions: ${err.message}`);
      }
    }));
  }
  
  // 4. Merge using mergeVpPositions
  const mergedResult = mergeVpPositions(livePositions as any, openVps, solPrice ?? 0, Date.now(), freshPnlMap);
  return {
    wallet: liveResult.wallet,
    total_positions: mergedResult.total_positions,
    positions: mergedResult.positions,
    request_id: liveResult.request_id,
    error: liveResult.error,
  };
}

// ─── Dispatcher trackPosition ────────────────────────────────────

export function trackPosition(params: any): void {
  const isDryRun = process.env.DRY_RUN === "true";
  if (isDryRun) {
    trackVpPosition(params);
  } else {
    trackLivePosition(params);
  }
}

// ─── Dispatcher getTrackedPosition(s) ─────────────────────────────

export function getTrackedPosition(positionAddress: string): any {
  if (positionAddress.startsWith("vp:")) {
    const vpId = positionAddress.slice(3);
    return getVpPosition(vpId);
  } else {
    return getLivePosition(positionAddress);
  }
}

export function getTrackedPositions(openOnly = false): any[] {
  const live = getLivePositions(openOnly);
  const vp = listVpPositions(openOnly ? "open" : undefined);
  return [...live, ...vp];
}

// ─── Dispatcher closePosition ────────────────────────────────────

// Renamed from closePosition on-chain to closeLivePosition as per convention
export async function closeLivePosition({ position_address, reason }: { position_address: string; reason: string }) {
  const { closePosition: closePositionOnChain } = await import("../providers/meteora/index.js");
  const result = await closePositionOnChain({ position_address, reason });
  if (result && result.success) {
    recordLiveClose(position_address, reason);
  }
  return result;
}

export async function closePosition(positionAddress: string, reason: string): Promise<any> {
  if (positionAddress.startsWith("vp:")) {
    const vp_id = positionAddress.slice(3);
    return closeVpPosition(vp_id, reason);
  } else {
    return closeLivePosition({ position_address: positionAddress, reason });
  }
}

// ─── Dispatcher setPositionInstruction ───────────────────────────

export function setPositionInstruction(positionAddress: string, instruction: string | null): boolean {
  if (positionAddress.startsWith("vp:")) {
    const vpId = positionAddress.slice(3);
    return updateVpPosition(vpId, { instruction });
  } else {
    return setLivePositionInstruction(positionAddress, instruction);
  }
}

// ─── Dispatcher getLiveStateSummary ──────────────────────────────

export async function getLiveStateSummary(): Promise<StateSummary> {
  const state = loadLiveState();
  const open = Object.values(state.positions).filter((p) => !p.closed);
  const closed = Object.values(state.positions).filter((p) => p.closed);
  const totalFeesClaimed = Object.values(state.positions)
    .reduce((sum, p) => sum + (p.total_fees_claimed_usd || 0), 0);
  
  return {
    open_positions: open.length,
    closed_positions: closed.length,
    total_fees_claimed_usd: Math.round(totalFeesClaimed * 100) / 100,
    positions: open.map((p) => ({
      position: p.position,
      pool: p.pool,
      strategy: p.strategy ?? null,
      deployed_at: p.deployed_at,
      out_of_range_since: p.out_of_range_since,
      minutes_out_of_range: minutesLiveOutOfRange(p.position),
      total_fees_claimed_usd: p.total_fees_claimed_usd,
      initial_fee_tvl_24h: p.initial_fee_tvl_24h ?? null,
      rebalance_count: p.rebalance_count,
      instruction: p.instruction || null,
    })),
    last_updated: state.lastUpdated,
    recent_events: (state.recentEvents || []).slice(-10),
  };
}

// ─── Dispatcher getVpStateSummary ───────────────────────────────

export async function getVpStateSummary(): Promise<StateSummary> {
  const open = listVpPositions("open");
  
  let closedCount = 0;
  let closedFees = 0;
  try {
    const closed = await readArchive({ source: "paper", hours: 720, limit: 5000 });
    closedCount = closed.length;
    closedFees = closed.reduce((sum, p) => sum + (p.close_fees_usd || p.total_fees_earned_usd || 0), 0);
  } catch (err: any) {
    log("state", `Failed to read archive for VP summary: ${err.message}`);
  }

  const openFees = open.reduce((sum, p) => sum + (p.total_fees_claimed_usd || 0), 0);
  const totalFeesClaimed = openFees + closedFees;

  return {
    open_positions: open.length,
    closed_positions: closedCount,
    total_fees_claimed_usd: Math.round(totalFeesClaimed * 100) / 100,
    positions: open.map((p) => {
      let minutesOor = 0;
      if (p._oor_since) {
        const ms = Date.now() - new Date(p._oor_since).getTime();
        minutesOor = Math.floor(ms / 60000);
      }
      return {
        position: `vp:${p.id}`,
        pool: p.pool,
        strategy: p.strategy ?? null,
        deployed_at: p.deployed_at,
        out_of_range_since: p._oor_since || null,
        minutes_out_of_range: minutesOor,
        total_fees_claimed_usd: p.total_fees_claimed_usd || 0,
        initial_fee_tvl_24h: (p.fee_tvl_ratio as number) ?? null,
        rebalance_count: 0,
        instruction: p.instruction || null,
      };
    }),
    last_updated: new Date().toISOString(),
    recent_events: [],
  };
}

// ─── Dispatcher getStateSummary ──────────────────────────────────

export async function getStateSummary(): Promise<StateSummary> {
  if (process.env.DRY_RUN === "true") {
    return getVpStateSummary();
  }
  return getLiveStateSummary();
}

// ─── Briefing Tracking (Shared) ──────────────────────────────────

export function getLastBriefingDate(): string | null {
  const state = loadLiveState();
  return state._lastBriefingDate || null;
}

export function setLastBriefingDate(): void {
  const state = loadLiveState();
  state._lastBriefingDate = new Date().toISOString().slice(0, 10);
  saveLiveState(state);
}
