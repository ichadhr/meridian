// providers/meteora/claim.ts
// Claim accrued fees from a single open DLMM position.
// Loads the position via SDK, builds claim reward txs via
// pool.claimAllRewardsByPosition, sends the batch, and invalidates caches
// so subsequent /positions calls reflect the post-claim balances.

import { PublicKey } from "@solana/web3.js";
import { log } from "../../utils/logger.js";
import { normalizeMint, getWallet, getConnection } from "../solana/wallet.js";
import { getTrackedPosition, recordLiveClaim } from "../../core/index.js";
import { sendTxBatch } from "./tx.js";
import { getPool, invalidatePoolCache } from "./pool-cache.js";
import {
  invalidatePositionsCache,
  lookupPoolForPosition,
} from "./core.js";

/**
 * Claim fees for a single open position. No-op (returns dry_run flag) in
 * DRY_RUN. Refuses to claim a tracked-closed position since those fees
 * were already swept during close.
 */
export async function claimFees({ position_address }: { position_address: string }): Promise<any> {
  position_address = normalizeMint(position_address);
  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_claim: position_address, message: "DRY RUN — no transaction sent" };
  }

  const tracked = getTrackedPosition(position_address);
  if (tracked?.closed) {
    return { success: false, error: "Position already closed — fees were claimed during close" };
  }

  try {
    log("claim", `Claiming fees for position: ${position_address}`);
    const wallet = getWallet();
    const poolAddress = await lookupPoolForPosition(position_address, wallet.publicKey.toString());
    // Clear cached pool so SDK loads fresh position fee state
    invalidatePoolCache(poolAddress.toString());
    const pool = await getPool(poolAddress);

    const positionData = await pool.getPosition(new PublicKey(position_address));
    const txs = await pool.claimAllRewardsByPosition({
      owner: wallet.publicKey,
      position: positionData,
    });

    if (!txs || txs.length === 0) {
      return { success: false, error: "No fees or rewards to claim — transaction is empty" };
    }

    const txHashes = await sendTxBatch(getConnection(), txs, [wallet], "claim");
    log("claim", `SUCCESS txs: ${txHashes.join(", ")}`);
    invalidatePositionsCache(); // invalidate positions cache after claim
    recordLiveClaim(position_address, 0);

    return { success: true, position: position_address, txs: txHashes, base_mint: pool.lbPair.tokenXMint.toString() };
  } catch (error: any) {
    log("claim_error", error.message);
    return { success: false, error: error.message };
  }
}
