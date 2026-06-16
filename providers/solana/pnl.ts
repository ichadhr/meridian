import { Connection, PublicKey } from "@solana/web3.js";
import { config } from "../../config/index.js";
import { log } from "../../utils/logger.js";
import {
  getTrackedPosition,
  markLiveOutOfRange,
  markLiveInRange,
  minutesLiveOutOfRange,
} from "../../core/index.js";
import { fetchSolPrice } from "../jupiter/index.js";

const JUPITER_PRICE_API = "https://api.jup.ag/price/v3";
const METEORA_PNL = "https://dlmm.datapi.meteora.ag/positions";

// Lazy SDK load — mirrors tools/dlmm.js (CJS dir-imports break in ESM at import time).
let _DLMM: any = null;
async function loadDlmmSdk() {
  if (!_DLMM) {
    const mod = await import("@meteora-ag/dlmm");
    _DLMM = mod.default;
  }
  return _DLMM;
}

let _pnlConnection: Connection | null = null;
export function getPnlConnection(): Connection {
  if (!_pnlConnection) {
    _pnlConnection = new Connection(config.pnl.rpcUrl, "confirmed");
  }
  return _pnlConnection;
}

function safeNum(value: any): number {
  const n = parseFloat(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function maybeNum(value: any): number | null {
  if (value == null || value === "") return null;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function round(value: any, decimals = 4): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function unique(arr: (string | null | undefined)[]): string[] {
  return [...new Set(arr.filter(Boolean))] as string[];
}

// ─── Meteora /pnl per pool (deposit history) ────────────────────
export async function fetchDlmmPnlForPool(poolAddress: string, walletAddress: string): Promise<Record<string, any>> {
  const url = `${METEORA_PNL}/${poolAddress}/pnl?user=${walletAddress}&status=open&pageSize=100&page=1`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log("pnl_api", `HTTP ${res.status} for pool ${poolAddress.slice(0, 8)}: ${body.slice(0, 120)}`);
      return {};
    }
    const data = await res.json() as any;
    const positions = data.positions || data.data || [];
    const byAddress: Record<string, any> = {};
    for (const p of positions) {
      const addr = p.positionAddress || p.address || p.position;
      if (addr) byAddress[addr] = p;
    }
    return byAddress;
  } catch (e: any) {
    log("pnl_api", `Fetch error for pool ${poolAddress.slice(0, 8)}: ${e.message}`);
    return {};
  }
}

// ─── Jupiter prices via price/v3 (never cached for tokens) ───────
const PRICE_CHUNK_SIZE = 100;

/** Fetch token prices in chunks and merge results. */
async function fetchPriceChunks(mints: string[]): Promise<Record<string, number | null>> {
  const out: Record<string, number | null> = {};
  const chunks: string[][] = [];
  for (let i = 0; i < mints.length; i += PRICE_CHUNK_SIZE) {
    chunks.push(mints.slice(i, i + PRICE_CHUNK_SIZE));
  }

  const results = await Promise.allSettled(
    chunks.map(async (chunk) => {
      const ids = chunk.join(",");
      const res = await fetch(`${JUPITER_PRICE_API}?ids=${ids}`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) {
        log("pnl_price", `Jupiter price/v3 error: ${res.status} (${chunk.length} mints)`);
        return {};
      }
      const data = await res.json() as Record<string, any>;
      const batch: Record<string, number | null> = {};
      for (const mint of chunk) {
        batch[mint] = maybeNum(data?.[mint]?.usdPrice);
      }
      return batch;
    }),
  );

  for (const result of results) {
    if (result.status === "fulfilled") {
      Object.assign(out, result.value);
    }
  }
  return out;
}

export async function getJupiterPrices(mints: (string | null | undefined)[]): Promise<Record<string, number | null>> {
  const list = unique(mints.map((m) => String(m || "").trim()));
  if (!list.length) return {};

  const solMint = config.tokens.SOL;
  const tokenMints = list.filter((m) => m !== solMint);

  // Pre-fill every requested mint with null so callers always get an entry
  const out: Record<string, number | null> = {};
  for (const mint of list) out[mint] = null;

  // Use fetchSolPrice for SOL (cached, validated, Helius fallback)
  const solPrice = await fetchSolPrice();
  if (solPrice != null) out[solMint] = solPrice;

  // Fetch token prices via price/v3 (batched to avoid URL length limits)
  if (tokenMints.length > 0) {
    const tokenPrices = await fetchPriceChunks(tokenMints);
    Object.assign(out, tokenPrices);
  }

  return out;
}

interface CacheEntry {
  at: number;
  byPosition: Record<string, any>;
  sigByPosition: Record<string, string | null>;
}

// ─── Deposit-history cache (sig-invalidated + TTL) ──────────────
const _meteoraCache = new Map<string, CacheEntry>();
let _pollCount = 0;

async function getLatestSig(conn: Connection, addr: string): Promise<string | null> {
  try {
    const sigs = await conn.getSignaturesForAddress(new PublicKey(addr), { limit: 1 });
    return sigs?.[0]?.signature ?? null;
  } catch {
    return null;
  }
}

async function getMeteoraData(conn: Connection, walletAddress: string, flat: any[]): Promise<Record<string, any>> {
  const ttlMs = Math.max(0, Number(config.pnl.depositCacheTtlSec ?? 300)) * 1000;
  const positionsByPool = new Map<string, string[]>();
  for (const f of flat) {
    if (!positionsByPool.has(f.pool)) positionsByPool.set(f.pool, []);
    positionsByPool.get(f.pool)!.push(f.position);
  }

  const byPosition: Record<string, any> = {};
  await Promise.all([...positionsByPool.entries()].map(async ([pool, positionAddrs]) => {
    const cached = _meteoraCache.get(pool);
    const sigByPosition: Record<string, string | null> = {};
    await Promise.all(positionAddrs.map(async (addr) => {
      sigByPosition[addr] = await getLatestSig(conn, addr);
    }));

    const ageOk = cached && Date.now() - cached.at < ttlMs;
    const sigsMatch = cached && positionAddrs.every((a) => cached.sigByPosition?.[a] === sigByPosition[a]);

    let data: Record<string, any>;
    if (ageOk && sigsMatch) {
      data = cached.byPosition;
    } else {
      data = await fetchDlmmPnlForPool(pool, walletAddress);
      _meteoraCache.set(pool, { at: Date.now(), byPosition: data, sigByPosition });
    }
    for (const addr of positionAddrs) {
      byPosition[addr] = data[addr] || null;
    }
  }));

  return byPosition;
}

function mapEntries(map: any): [string, any][] {
  return map instanceof Map ? [...map.entries()] : Object.entries(map || {});
}

// ─── Build the shaped position object (matches getMyPositions output) ──
function buildPosition(f: any, prices: Record<string, number | null>, solUsd: number | null, meteora: any, solMode: boolean): any {
  const priceX = f.baseMint ? (prices[f.baseMint] ?? 0) : 0;

  const xHuman = safeNum(f.xRaw) / 10 ** f.decX;
  const yHuman = safeNum(f.yRaw) / 10 ** f.decY;
  const balancesUsd = xHuman * priceX + yHuman * (solUsd ?? 0);
  const balancesSol = solUsd ? balancesUsd / solUsd : yHuman;

  const feeXHuman = safeNum(f.feeXRaw) / 10 ** f.decX;
  const feeYHuman = safeNum(f.feeYRaw) / 10 ** f.decY;
  const claimableUsd = feeXHuman * priceX + feeYHuman * (solUsd ?? 0);
  const claimableSol = solUsd ? claimableUsd / solUsd : feeYHuman;

  const depositsUsd = safeNum(meteora?.allTimeDeposits?.total?.usd);
  const depositsSol = safeNum(meteora?.allTimeDeposits?.total?.sol);
  const withdrawUsd = safeNum(meteora?.allTimeWithdrawals?.total?.usd);
  const withdrawSol = safeNum(meteora?.allTimeWithdrawals?.total?.sol);
  const claimedUsd = safeNum(meteora?.allTimeFees?.total?.usd);
  const claimedSol = safeNum(meteora?.allTimeFees?.total?.sol);

  const pnlUsd = balancesUsd + withdrawUsd + claimableUsd + claimedUsd - depositsUsd;
  const pnlSol = balancesSol + withdrawSol + claimableSol + claimedSol - depositsSol;
  const pctUsd = depositsUsd > 0 ? (pnlUsd / depositsUsd) * 100 : 0;
  const pctSol = depositsSol > 0 ? (pnlSol / depositsSol) * 100 : 0;

  const ourPct = solMode ? pctSol : pctUsd;

  const reportedPct = solMode ? maybeNum(meteora?.pnlSolPctChange) : maybeNum(meteora?.pnlPctChange);
  const pnlPctDiff = reportedPct != null ? Math.abs(ourPct - reportedPct) : null;

  const holdsTokenX = xHuman > 0 || feeXHuman > 0;
  const priceMissing = !(solUsd && solUsd > 0) || (holdsTokenX && !!f.baseMint && !(priceX > 0));
  const depositsMissing = (solMode ? depositsSol : depositsUsd) <= 0;
  const pnlPctSuspicious = priceMissing || depositsMissing;
  if (pnlPctSuspicious) {
    log("pnl_warn", `${f.position.slice(0, 8)} suspicious tick — priceMissing=${priceMissing} depositsMissing=${depositsMissing} (solUsd=${solUsd}, priceX=${priceX})`);
  }

  const inRange = f.active != null && f.lower != null && f.upper != null
    ? f.active >= f.lower && f.active <= f.upper
    : (meteora ? !meteora.isOutOfRange : true);

  const tracked = getTrackedPosition(f.position);
  const ageFromState = tracked?.deployed_at
    ? Math.floor((Date.now() - new Date(tracked.deployed_at).getTime()) / 60000)
    : null;
  const ageMinutes = meteora?.createdAt ? Math.floor((Date.now() - meteora.createdAt * 1000) / 60000) : ageFromState;

  return {
    position:           f.position,
    pool:               f.pool,
    pair:               tracked?.pool_name || (meteora ? `${meteora.tokenX ?? "?"}/${meteora.tokenY ?? "SOL"}` : "?/SOL"),
    base_mint:          f.baseMint,
    lower_bin:          f.lower ?? tracked?.bin_range?.min ?? null,
    upper_bin:          f.upper ?? tracked?.bin_range?.max ?? null,
    active_bin:         f.active ?? tracked?.bin_range?.active ?? null,
    in_range:           inRange,
    unclaimed_fees_usd: round(solMode ? claimableSol : claimableUsd),
    unclaimed_fees_true_usd: round(claimableUsd),
    total_value_usd:    round(solMode ? balancesSol : balancesUsd),
    total_value_true_usd: round(balancesUsd),
    collected_fees_usd: round(solMode ? claimedSol : claimedUsd),
    collected_fees_true_usd: round(claimedUsd),
    pnl_usd:            round(solMode ? pnlSol : pnlUsd),
    pnl_true_usd:       round(pnlUsd),
    pnl_pct:            round(ourPct, 2),
    pnl_pct_derived:    round(ourPct, 2),
    pnl_pct_diff:       pnlPctDiff != null ? round(pnlPctDiff, 2) : null,
    pnl_pct_suspicious: !!pnlPctSuspicious,
    fee_per_tvl_24h:    meteora ? Math.round(safeNum(meteora.feePerTvl24h) * 100) / 100 : null,
    age_minutes:        ageMinutes,
    minutes_out_of_range: null as number | null,
    instruction:        tracked?.instruction ?? null,
  };
}

// ─── Main entry: compute positions from public infra ────────────
export async function computePositions(walletAddress: string): Promise<any> {
  const solMode = !!config.management?.solMode;
  const SOL_MINT = config.tokens.SOL;
  const conn = getPnlConnection();
  const DLMM = await loadDlmmSdk();

  const map = await DLMM.getAllLbPairPositionsByUser(conn, new PublicKey(walletAddress));
  _pollCount++;
  if (_pollCount % 20 === 1) {
    const n = [...mapEntries(map)].reduce((s, [, i]) => s + (i?.lbPairPositionsData?.length ?? 0), 0);
    log("pnl_tick", `poller alive — ${n} position(s) tracked (tick #${_pollCount})`);
  }

  const flat: any[] = [];
  for (const [lbPairKey, info] of mapEntries(map)) {
    const decX = info?.tokenX?.mint?.decimals ?? 9;
    const decY = info?.tokenY?.mint?.decimals ?? 9;
    const baseMint = info?.tokenX?.mint?.address?.toString?.() ?? null;
    const active = info?.lbPair?.activeId ?? null;
    for (const p of info?.lbPairPositionsData || []) {
      const d = p.positionData || {};
      flat.push({
        position: p.publicKey.toString(),
        pool: lbPairKey,
        baseMint,
        decX,
        decY,
        active,
        lower: d.lowerBinId ?? null,
        upper: d.upperBinId ?? null,
        xRaw: d.totalXAmount,
        yRaw: d.totalYAmount,
        feeXRaw: d.feeX?.toString?.() ?? d.feeX ?? 0,
        feeYRaw: d.feeY?.toString?.() ?? d.feeY ?? 0,
      });
    }
  }

  if (flat.length === 0) {
    return { wallet: walletAddress, total_positions: 0, positions: [], source: "rpc" };
  }

  const [prices, meteoraByPosition] = await Promise.all([
    getJupiterPrices([SOL_MINT, ...flat.map((f) => f.baseMint)]),
    getMeteoraData(conn, walletAddress, flat),
  ]);
  const solUsd = prices[SOL_MINT] ?? null;

  const positions = flat.map((f) => buildPosition(f, prices, solUsd, meteoraByPosition[f.position], solMode));

  // State mutations moved out of buildPosition (providers = I/O only).
  // markLiveInRange/Out + minutesLiveOutOfRange now called here.
  for (const p of positions) {
    if (p.in_range) markLiveInRange(p.position);
    else markLiveOutOfRange(p.position);
    p.minutes_out_of_range = minutesLiveOutOfRange(p.position);
  }

  return { wallet: walletAddress, total_positions: positions.length, positions, source: "rpc" };
}
