/**
 * Neutral token fee resolution — no provider owns this file.
 *
 * Resolves global fees SOL for a token mint, preferring GMGN's fee
 * data when available and falling back to Jupiter's fee figure.
 * This avoids a cross-provider dependency (Jupiter importing from GMGN).
 */

import { config } from "../config/index.js";
import { getGmgnTokenFees, hasGmgnApiKey } from "./gmgn/index.js";

/**
 * Resolve global fees (in SOL) for a token mint.
 *
 * Strategy:
 *   1. If GMGN fee source is configured and available, fetch from GMGN.
 *   2. Fall back to the Jupiter-provided fee figure.
 *
 * @param mint - Token mint address
 * @param jupiterFees - Fallback fee figure from Jupiter API
 * @returns Fee in SOL, or null if unavailable
 */
export async function resolveGlobalFeesSol(
  mint: string,
  jupiterFees: number | null | undefined,
): Promise<number | null> {
  const jup = jupiterFees != null ? parseFloat(jupiterFees.toFixed(2)) : null;
  if (!mint || config.gmgn?.feeSource !== "gmgn" || !hasGmgnApiKey()) return jup;
  const fees = await getGmgnTokenFees(mint);
  if (fees?.total_fee != null) return parseFloat(fees.total_fee.toFixed(2));
  return jup;
}
