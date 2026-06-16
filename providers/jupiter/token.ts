import { config } from "../../config/index.js";
import { getGmgnTokenFees, hasGmgnApiKey } from "../gmgn/index.js";

const DATAPI_BASE = "https://datapi.jup.ag/v1";

async function resolveGlobalFeesSol(mint: string, jupiterFees: number | null | undefined): Promise<number | null> {
  const jup = jupiterFees != null ? parseFloat(jupiterFees.toFixed(2)) : null;
  if (!mint || config.gmgn?.feeSource !== "gmgn" || !hasGmgnApiKey()) return jup;
  const fees = await getGmgnTokenFees(mint);
  if (fees?.total_fee != null) return parseFloat(fees.total_fee.toFixed(2));
  return jup;
}

/**
 * Get the narrative/story behind a token from Jupiter ChainInsight.
 * Useful for understanding if a token has a real community/theme vs nothing.
 */
export async function getTokenNarrative({
  mint,
}: {
  mint: string;
}): Promise<{ mint: string; narrative: string | null; status: unknown }> {
  const res = await fetch(`${DATAPI_BASE}/chaininsight/narrative/${mint}`);
  if (!res.ok) throw new Error(`Narrative API error: ${res.status}`);
  const data = await res.json();
  return {
    mint,
    narrative: data.narrative || null,
    status: data.status,
  };
}

export interface TokenSearchResult {
  mint: string;
  name: string;
  symbol: string;
  mcap: number | null;
  price: number | null;
  liquidity: number | null;
  holders: number | null;
  organic_score: number | null;
  organic_label: string | null;
  launchpad: string | null;
  graduated: boolean;
  global_fees_sol: number | null;
  audit: {
    mint_disabled: boolean | null;
    freeze_disabled: boolean | null;
    top_holders_pct: string | null;
    bot_holders_pct: string | null;
    dev_migrations: unknown;
  } | null;
  stats_1h: {
    price_change: string | null;
    buy_vol: string | null;
    sell_vol: string | null;
    buyers: number | null;
    net_buyers: number | null;
  } | null;
  stats_24h_net_buyers: number | null;
  risk_level?: number | null;
  bundle_pct?: number | null;
  sniper_pct?: number | null;
  suspicious_pct?: number | null;
  new_wallet_pct?: number | null;
  smart_money_buy?: boolean | null;
  tags?: string[];
  kol_in_clusters?: boolean;
  top_cluster_trend?: unknown;
  clusters?: unknown[];
}

/**
 * Search for token data by name, symbol, or mint address.
 * Returns condensed token info useful for confidence scoring.
 */
export async function getTokenInfo({
  query,
}: {
  query: string;
}): Promise<
  | { found: false; query: string }
  | { found: true; query: string; results: TokenSearchResult[] }
> {
  const url = `${DATAPI_BASE}/assets/search?query=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Token search API error: ${res.status}`);
  const data = await res.json();
  const tokens = Array.isArray(data) ? data : [data];
  if (!tokens.length) return { found: false, query };

  const results: TokenSearchResult[] = tokens.slice(0, 5).map((t: any) => ({
    mint: t.id,
    name: t.name,
    symbol: t.symbol,
    mcap: t.mcap,
    price: t.usdPrice,
    liquidity: t.liquidity,
    holders: t.holderCount,
    organic_score: t.organicScore,
    organic_label: t.organicScoreLabel,
    launchpad: t.launchpad,
    graduated: !!t.graduatedPool,
    global_fees_sol: t.fees != null ? parseFloat(t.fees.toFixed(2)) : null,
    audit: t.audit
      ? {
          mint_disabled: t.audit.mintAuthorityDisabled,
          freeze_disabled: t.audit.freezeAuthorityDisabled,
          top_holders_pct: t.audit.topHoldersPercentage?.toFixed(2),
          bot_holders_pct: t.audit.botHoldersPercentage?.toFixed(2),
          dev_migrations: t.audit.devMigrations,
        }
      : null,
    stats_1h: t.stats1h
      ? {
          price_change: t.stats1h.priceChange?.toFixed(2),
          buy_vol: t.stats1h.buyVolume?.toFixed(0),
          sell_vol: t.stats1h.sellVolume?.toFixed(0),
          buyers: t.stats1h.numOrganicBuyers,
          net_buyers: t.stats1h.numNetBuyers,
        }
      : null,
    stats_24h_net_buyers: t.stats24h ? t.stats24h.numNetBuyers : null,
  }));

  // Enrich first result with smart money + risk data
  if (results[0]?.mint) {
    results[0].risk_level = null;
    results[0].bundle_pct = null;
    results[0].sniper_pct = null;
    results[0].suspicious_pct = null;
    results[0].new_wallet_pct = null;
    results[0].smart_money_buy = null;
    results[0].tags = [];
    results[0].kol_in_clusters = false;
    results[0].top_cluster_trend = null;
    results[0].clusters = [];
    results[0].global_fees_sol = await resolveGlobalFeesSol(results[0].mint, tokens[0]?.fees);
  }

  return { found: true, query, results };
}

export interface HolderEntry {
  address?: string;
  wallet?: string;
  amount: number;
  pct?: number;
  percentage?: number;
  solBalanceDisplay?: string;
  solBalance?: string;
  tags?: Array<{ name?: string; id?: string } | string>;
  addressInfo?: {
    fundingAddress?: string;
    fundingAmount?: unknown;
    fundingSlot?: unknown;
  };
}

export interface HolderResult {
  address?: string;
  amount: number;
  pct: number | null;
  sol_balance?: string;
  tags?: string[];
  is_pool?: boolean;
  funding?: {
    address: string;
    amount: unknown;
    slot: unknown;
  };
}

export interface SmartWalletHolding {
  name: string;
  category: string;
  address: string;
  pct: number | null;
  sol_balance?: string;
  pnl: Record<string, unknown> | null;
}

/**
 * Get holder distribution for a token mint.
 * Fetches top 100 holders — caller decides how many to display.
 */
export async function getTokenHolders({
  mint,
  limit = 20,
}: {
  mint: string;
  limit?: number;
}): Promise<{
  mint: string;
  global_fees_sol: number | null;
  total_fetched: number;
  showing: number;
  top_10_real_holders_pct: string;
  risk_level: number | null;
  bundle_pct: number | null;
  sniper_pct: number | null;
  suspicious_pct: number | null;
  new_wallet_pct: number | null;
  smart_wallets_holding: SmartWalletHolding[];
  holders: HolderResult[];
}> {
  // Fetch holders and total supply in parallel
  const [holdersRes, tokenRes] = await Promise.all([
    fetch(`${DATAPI_BASE}/holders/${mint}?limit=100`),
    fetch(`${DATAPI_BASE}/assets/search?query=${mint}`),
  ]);
  if (!holdersRes.ok) throw new Error(`Holders API error: ${holdersRes.status}`);
  const data = await holdersRes.json();
  const tokenData = tokenRes.ok ? await tokenRes.json() : null;
  const tokenInfo = Array.isArray(tokenData) ? tokenData[0] : tokenData;
  const totalSupply: number | null =
    tokenInfo?.totalSupply || tokenInfo?.circSupply || null;

  const holders: HolderEntry[] = Array.isArray(data)
    ? data
    : data.holders || data.data || [];

  const mapped: HolderResult[] = holders.slice(0, Math.min(limit, 100)).map((h) => {
    const tags = (h.tags || []).map((t: any) => t.name || t.id || t);
    const isPool = tags.some((t: string) => /pool|amm|liquidity|raydium|orca|meteora/i.test(t));
    const pct = totalSupply
      ? (Number(h.amount) / totalSupply) * 100
      : h.percentage ?? h.pct ?? null;
    return {
      address: h.address || h.wallet,
      amount: h.amount,
      pct: pct != null ? parseFloat(pct.toFixed(4)) : null,
      sol_balance: h.solBalanceDisplay ?? h.solBalance,
      tags: tags.length ? tags : undefined,
      is_pool: isPool || undefined,
      funding: h.addressInfo?.fundingAddress
        ? {
            address: h.addressInfo.fundingAddress,
            amount: h.addressInfo.fundingAmount,
            slot: h.addressInfo.fundingSlot,
          }
        : undefined,
    };
  });

  const realHolders = mapped.filter((h) => !h.is_pool);
  const top10Pct = realHolders
    .slice(0, 10)
    .reduce((s, h) => s + (Number(h.pct) || 0), 0);

  // ─── Bundle / Cluster Analysis (OKX) ─────────────────────────
  const advancedData: any = null;
  const clusterList: any[] = [];


  // ─── Smart Wallet / KOL Cross-reference ──────────────────────
  const { listSmartWallets } = await import("../../core/smart-wallets.js");
  const { wallets: smartWallets } = listSmartWallets();
  let smartWalletsHolding: SmartWalletHolding[] = [];

  if (smartWallets.length > 0) {
    const addresses = smartWallets.map((w: any) => w.address).join(",");
    const kwRes = await fetch(
      `${DATAPI_BASE}/holders/${mint}?addresses=${addresses}`,
    ).catch(() => null);
    const kwData = kwRes?.ok ? await kwRes.json() : null;
    const kwHolders: HolderEntry[] = Array.isArray(kwData)
      ? kwData
      : kwData?.holders || kwData?.data || [];

    const smartWalletMap = new Map(smartWallets.map((w: any) => [w.address, w]));
    const matchedHolders = kwHolders
      .map((h) => ({ ...h, addr: h.address || h.wallet }))
      .filter((h) => h.addr && smartWalletMap.has(h.addr));

    await Promise.all(
      matchedHolders.map(async (h) => {
        const wallet = smartWalletMap.get(h.addr);
        const pct = totalSupply
          ? parseFloat(((Number(h.amount) / totalSupply) * 100).toFixed(4))
          : null;

        let pnl: Record<string, unknown> | null = null;
        try {
          const pnlRes = await fetch(
            `${DATAPI_BASE}/pnl-positions?address=${h.addr}&assetId=${mint}`,
          );
          if (pnlRes.ok) {
            const pnlData = await pnlRes.json();
            const pos = pnlData?.[h.addr!]?.tokenPositions?.[0];
            if (pos)
              pnl = {
                balance: pos.balance,
                balance_usd: pos.balanceValue,
                avg_cost: pos.averageCost,
                realized_pnl: pos.realizedPnl,
                unrealized_pnl: pos.unrealizedPnl,
                total_pnl: pos.totalPnl,
                total_pnl_pct: pos.totalPnlPercentage,
                buys: pos.totalBuys,
                sells: pos.totalSells,
                wins: pos.totalWins,
                bought_value: pos.boughtValue,
                sold_value: pos.soldValue,
                first_active: pos.firstActiveTime,
                last_active: pos.lastActiveTime,
                holding_days: pos.holdingPeriodInSeconds
                  ? Math.round(pos.holdingPeriodInSeconds / 86400)
                  : null,
              };
          }
        } catch {
          /* ignore */
        }

        smartWalletsHolding.push({
          name: wallet.name,
          category: wallet.category,
          address: h.addr!,
          pct,
          sol_balance: h.solBalanceDisplay ?? h.solBalance,
          pnl,
        });
      }),
    );
  }

  return {
    mint,
    global_fees_sol: await resolveGlobalFeesSol(mint, tokenInfo?.fees),
    total_fetched: holders.length,
    showing: mapped.length,
    top_10_real_holders_pct: top10Pct.toFixed(2),
    risk_level: (advancedData?.risk_level as number | null) ?? null,
    bundle_pct: (advancedData?.bundle_pct as number | null) ?? null,
    sniper_pct: (advancedData?.sniper_pct as number | null) ?? null,
    suspicious_pct: (advancedData?.suspicious_pct as number | null) ?? null,
    new_wallet_pct: (advancedData?.new_wallet_pct as number | null) ?? null,
    smart_wallets_holding: smartWalletsHolding,
    holders: mapped,
  };
}
