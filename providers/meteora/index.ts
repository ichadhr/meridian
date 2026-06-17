// Bin helpers (active-bin lookup, in-range bins, VP distribution) live in
// bins.ts — re-export them from there directly to keep the public API
// of providers/meteora unchanged.
export {
  getActiveBin,
  _resetBinsInRangeCacheForTesting,
  _setBinsInRangeCacheForTesting,
  _getBinsInRangeCacheSizeForTesting,
  getBinsInRange,
} from "./bins.js";

export { decimalPriceToQ64 } from "./dlmm.js";
// deployPosition, _positionsCacheTtlForTesting, invalidatePositionsCache,
// closePosition, getMyPositions remain in core.ts (the heavy lifter).
export {
  deployPosition,
  _positionsCacheTtlForTesting,
  invalidatePositionsCache,
  getMyPositions,
  closePosition,
} from "./core.js";
// The following functions were extracted to their own files for clarity.
// Re-export from the new files directly so the public API is unchanged.
export { getPositionPnl, getWalletPositions } from "./position.js";
export { searchPools } from "./pool-discovery.js";
export { claimFees } from "./claim.js";
export { discoverPools, getTopCandidates, getPoolDetail } from "./pool-discovery.js";
