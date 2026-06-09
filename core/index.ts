/**
 * core/index.ts — Core Gate
 *
 * All outside code imports from here. Never import core sub-files directly.
 * This is a pure barrel re-export — no logic lives here.
 *
 * During migration, export paths will be wired incrementally as files move into core/.
 * Initially, re-export from the current locations (root, tools/) to keep imports working.
 */

// Position lifecycle
// TODO: wire when core/state.ts exists
// export { openPosition, closePosition, listPositions, getPositionState } from "./state.js";

// Learning & evolution
// TODO: wire when core/lessons.ts exists
// export { recordPerformance, getPromptLessons, evolveThresholds } from "./lessons.js";
// TODO: wire when core/signal-weights.ts exists
// export { recalculateWeights } from "./signal-weights.js";

// Pool & deploy memory
// TODO: wire when core/pool-memory.ts exists
// export { recordPoolDeploy, getPoolMemory, addPoolNote } from "./pool-memory.js";

// Archive
// TODO: wire when core/archive.ts exists
// export { appendArchiveRecord, getPerformanceHistory } from "./archive.js";

// Strategies
// TODO: wire when core/strategy-library.ts exists
// export { getActiveStrategy, addStrategy, listStrategies } from "./strategy-library.js";

// Smart wallets
// TODO: wire when core/smart-wallets.ts exists
// export { addSmartWallet, removeSmartWallet, listSmartWallets } from "./smart-wallets.js";

// Blacklist (already migrated)
export { addToBlacklist, isBlacklisted, listBlacklist } from "./token-blacklist.js";

// Briefing & decisions (already migrated)
export { generateBriefing } from "./briefing.js";
export { appendDecision, getRecentDecisions } from "./decision-log.js";
export { stageSignals, getAndClearStagedSignals, getStagedPools } from "./signal-tracker.js";
