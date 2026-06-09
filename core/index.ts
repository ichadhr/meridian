/**
 * core/index.ts — Core Gate
 *
 * All outside code imports from here. Never import core sub-files directly.
 * This is a pure barrel re-export — no logic lives here.
 */

// Position lifecycle
export {
  getStateSummary,
  getTrackedPosition,
  getTrackedPositions,
  setPositionInstruction,
  updatePnlAndCheckExits,
  queuePeakConfirmation,
  resolvePendingPeak,
  queueTrailingDropConfirmation,
  resolvePendingTrailingDrop,
  getLastBriefingDate,
  setLastBriefingDate,
} from "./state.js";

// Learning & evolution
export {
  recordPerformance,
  getLessonsForPrompt,
  evolveThresholds,
  getPerformanceSummary,
  addLesson,
  clearAllLessons,
  clearPerformance,
  removeLessonsByKeyword,
  getPerformanceHistory,
  pinLesson,
  unpinLesson,
  listLessons,
} from "./lessons.js";

// Signal weights
export {
  recalculateWeights,
  getWeightsSummary,
} from "./signal-weights.js";

// Pool & deploy memory
export {
  recordPositionSnapshot,
  recallForPool,
  addPoolNote,
  recordPoolDeploy,
  getPoolMemory,
} from "./pool-memory.js";

// Archive
export {
  readArchive,
  compileVpStats,
} from "./archive.js";

// Strategies
export {
  getActiveStrategy,
  addStrategy,
  listStrategies,
  getStrategy,
  setActiveStrategy,
  removeStrategy,
} from "./strategy-library.js";

// Smart wallets
export {
  addSmartWallet,
  removeSmartWallet,
  listSmartWallets,
  checkSmartWalletsOnPool,
} from "./smart-wallets.js";

// Blacklist
export { addToBlacklist, removeFromBlacklist, isBlacklisted, listBlacklist, blockDev, unblockDev, listBlockedDevs } from "./token-blacklist.js";

// Briefing & decisions
export { generateBriefing } from "./briefing.js";
export { appendDecision, getRecentDecisions } from "./decision-log.js";
export { stageSignals, getAndClearStagedSignals, getStagedPools } from "./signal-tracker.js";

// Close rules
export { getCloseRule, getVirtualCloseRule } from "./close-rules.js";

// PnL computation
export { computePositionPnl, estimateSlippageLamports } from "./pnl.js";
export type { PositionPnlResult, BinData } from "./pnl.js";

// VP management
export { runVirtualManagementCycle, closeVpManual } from "./vp/manage.js";
export { parseVirtualPositionAddress, listVirtualPositions, trackVirtualPosition } from "./vp/state.js";
export { mergeVirtualPositions } from "./vp/merge.js";
export { generateVirtualDigest } from "./vp/digest.js";
export { generateDryRunReport } from "./vp/report.js";
