// providers/lpagent/open-positions.ts
// Fetches a wallet's open DLMM positions from the LPAgent Premium API.
// Used as the source-of-truth for open positions when the LPAgent relay
// is enabled. Gated by both env (LPAGENT_API_KEY) and config flag.

import { log } from "../../utils/logger.js";
import { config } from "../../config/index.js";

const LPAGENT_API = "https://api.lpagent.io/open-api/v1";

/**
 * Fetch all open DLMM positions for `walletAddress` from the LPAgent API,
 * keyed by position address. Returns {} when LPAgent is not configured,
 * when the HTTP request fails, or when the response shape is unexpected.
 */
export async function fetchLpAgentOpenPositions(walletAddress: string): Promise<Record<string, any>> {
  // Gated by BOTH env var AND config flag. Users without paid LPAgent
  // Premium plan set lpAgentRelayEnabled=false in config to skip.
  if (!process.env.LPAGENT_API_KEY || !config.api.lpAgentRelayEnabled) return {};

  const url = `${LPAGENT_API}/lp-positions/opening?owner=${walletAddress}`;
  try {
    const res = await fetch(url, {
      headers: {
        "x-api-key": process.env.LPAGENT_API_KEY,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log("lpagent_api", `HTTP ${res.status} for owner ${walletAddress.slice(0, 8)}: ${body.slice(0, 160)}`);
      return {};
    }
    const data = await res.json();
    const positions = data?.data || [];
    const byAddress: Record<string, any> = {};
    for (const p of positions) {
      const addr = p.position || p.id || p.tokenId;
      if (addr) byAddress[addr] = p;
    }
    return byAddress;
  } catch (e: any) {
    log("lpagent_api", `Fetch error for owner ${walletAddress.slice(0, 8)}: ${e.message}`);
    return {};
  }
}
