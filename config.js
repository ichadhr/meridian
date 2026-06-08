// config.js — Re-export shim for backward compatibility
// Allows `import("./config.js")` to resolve to the TypeScript version
export { config, computeDeployAmount, reloadScreeningThresholds, MIN_SAFE_BINS_BELOW, loadJsonRecord, saveJsonRecord } from "./config/index.js";
