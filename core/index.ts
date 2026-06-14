/**
 * core/index.ts — Core Gate
 *
 * All outside code imports from here. Never import core sub-files directly.
 * This is a pure barrel re-export — no logic lives here.
 */

// Dispatcher (core/state.ts)
export {
  getMyPositions,
  trackPosition,
  closePosition,
  setPositionInstruction,
  getStateSummary,
  getLiveStateSummary,
  getVpStateSummary,
  getLastBriefingDate,
  setLastBriefingDate,
  getTrackedPosition,
  getTrackedPositions,
} from "./state.js";

// Live state management (core/live/state.ts)
export {
  trackLivePosition,
  markLiveOutOfRange,
  markLiveInRange,
  minutesLiveOutOfRange,
  recordLiveClaim,
  recordLiveClose,
  setLivePositionInstruction,
  queueLivePeakConfirmation,
  resolveLivePendingPeak,
  queueLiveTrailingDropConfirmation,
  resolveLivePendingTrailingDrop,
  getLivePositions,
  getLivePosition,
  updateLivePnlAndCheckExits,
  syncLiveOpenPositions,
} from "./live/state.js";

// VP state & management (core/vp/state.ts & core/vp/manage.ts & core/vp/merge.ts & core/vp/digest.ts & core/vp/report.ts)
export {
  trackVpPosition,
  listVpPositions,
  getVpPosition,
  updateVpPosition,
  recordVpClaim,
  recordVpClose,
  archiveVpPositions,
  parseVirtualPositionAddress,
  isVpOutOfRange,
  markVpOutOfRange,
  markVpInRange,
  minutesVpOutOfRange,
  queueVpPeakConfirmation,
  queueVpTrailingDropConfirmation,
  updateVpPnlAndCheckExits,
} from "./vp/state.js";

export {
  closeVpPosition,
  runVpManagementCycle,
} from "./vp/manage.js";

export {
  mergeVpPositions,
} from "./vp/merge.js";

export {
  generateVpDigest,
} from "./vp/digest.js";

export {
  generateVpReport,
} from "./vp/report.js";

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
  isBaseMintOnCooldown,
  isPoolOnCooldown,
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
export {
  addToBlacklist,
  removeFromBlacklist,
  isBlacklisted,
  listBlacklist,
  blockDev,
  unblockDev,
  listBlockedDevs,
  isDevBlocked,
  getBlockedDevs,
} from "./token-blacklist.js";

// Briefing & decisions
export { generateBriefing } from "./briefing.js";
export { appendDecision, getRecentDecisions, getDecisionSummary } from "./decision-log.js";
export { stageSignals, getAndClearStagedSignals, getStagedPools } from "./signal-tracker.js";

// Close rules
export { getCloseRule } from "./close-rules.js";
export type { CloseRulePosition, CloseRuleConfig } from "./close-rules.js";

// PnL computation
export { computePositionPnl, estimateSlippageLamports } from "./pnl.js";
export type { PositionPnlResult, BinData } from "./pnl.js";

// Live cycle management
export { runLiveManagementCycle, type ManageDeps } from "./live/manage.js";
export { runScreeningCycle, tryStartScreening, getLoneCandidateSkipReason } from "./screen.js";

// Screening cycle state
export {
  managementBusy,
  setManagementBusy,
  screeningBusy,
  setScreeningBusy,
  timers,
  screeningLastTriggered,
  setScreeningLastTriggered,
  SCREENING_COOLDOWN_MS,
} from "./coordination-state.js";

// Live trailing TP timers
export {
  peakConfirmTimers,
  trailingDropConfirmTimers,
  TRAILING_PEAK_CONFIRM_DELAY_MS,
  TRAILING_PEAK_CONFIRM_TOLERANCE,
  TRAILING_DROP_CONFIRM_DELAY_MS,
  TRAILING_DROP_CONFIRM_TOLERANCE_PCT,
  pollTriggeredAt,
  setPollTriggeredAt,
} from "./live/trailing-timers.js";
