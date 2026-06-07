# TypeScript Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the Meridian JS codebase to strict TypeScript incrementally, leaf-first, small files → big files.

**Architecture:** Incremental migration with mixed .js/.ts allowed. Each file migrates independently. Strict mode from day 1. The tsconfig `allowJs: true` lets unmigrated .js files import from migrated .ts files. Files migrate in dependency order: leaf nodes first, integration points last.

**Tech Stack:** TypeScript 5.x, Node.js 18+, ESM (`"type": "module"`), tsconfig with `module: "NodeNext"`.

**Spec:** `docs/superpowers/specs/2026-06-08-typescript-migration-design.md`

---

## File Structure

### New files to create

| File | Purpose |
|------|---------|
| `tsconfig.json` | TypeScript configuration |
| `types/index.ts` | Shared type definitions (Config, Position, PoolCandidate, etc.) |
| `utils/logger.ts` | Migrated from `logger.js` |
| `utils/envrypt.ts` | Migrated from `envcrypt.js` |
| `core/token-blacklist.ts` | Migrated from `token-blacklist.js` + `dev-blocklist.js` |
| `core/decision-log.ts` | Migrated from `decision-log.js` |
| `core/briefing.ts` | Migrated from `briefing.js` |
| `core/signal-tracker.ts` | Migrated from `signal-tracker.js` |

### Files to modify

| File | Change |
|------|--------|
| `package.json` | Add `typescript`, `@types/node`, `@types/dotenv`, build scripts |

---

## Task 1: Bootstrap TypeScript

**Files:**
- Modify: `package.json`
- Create: `tsconfig.json`

- [ ] **Step 1: Install TypeScript dependencies**

```bash
cd /Users/ichadhr/Develop/node/meridian
npm install --save-dev typescript @types/node @types/dotenv
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": ".",
    "allowJs": true,
    "checkJs": false
  },
  "include": ["**/*.ts", "**/*.js"],
  "exclude": ["node_modules", "dist", "test"]
}
```

- [ ] **Step 3: Add build scripts to package.json**

Add to the `"scripts"` section:

```json
{
  "build": "tsc",
  "typecheck": "tsc --noEmit",
  "typecheck:watch": "tsc --noEmit --watch"
}
```

- [ ] **Step 4: Verify bootstrap compiles**

```bash
npx tsc --noEmit
```

Expected: No errors. The `allowJs: true` lets all existing .js files pass.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json
git commit -m "chore: bootstrap TypeScript with strict mode"
```

---

## Task 2: Create Shared Types

**Files:**
- Create: `types/index.ts`

- [ ] **Step 1: Create types directory and shared interfaces**

```bash
mkdir -p types
```

```ts
// types/index.ts — Shared type definitions for Meridian

// ─── Config ────────────────────────────────────────────────────

export interface RiskConfig {
  maxPositions: number;
  maxDeployAmount: number;
}

export interface ScreeningConfig {
  excludeHighSupplyConcentration: boolean;
  minFeeActiveTvlRatio: number;
  minTvl: number;
  maxTvl: number;
  minVolume: number;
  minOrganic: number;
  minQuoteOrganic: number;
  minHolders: number;
  minMcap: number;
  maxMcap: number;
  minBinStep: number;
  maxBinStep: number;
  timeframe: string;
  category: string;
  minTokenFeesSol: number;
  useDiscordSignals: boolean;
  discordSignalMode: "merge" | "only";
  avoidPvpSymbols: boolean;
  blockPvpSymbols: boolean;
  maxBundlePct: number;
  maxBotHoldersPct: number;
  maxTop10Pct: number;
  allowedLaunchpads: string[];
  blockedLaunchpads: string[];
  minTokenAgeHours: number | null;
  maxTokenAgeHours: number | null;
  athFilterPct: number | null;
  maxDevRugCount: number;
  okxFailClosed: boolean;
}

export interface ManagementConfig {
  minClaimAmount: number;
  autoSwapAfterClaim: boolean;
  outOfRangeBinsToClose: number;
  outOfRangeWaitMinutes: number;
  oorCooldownTriggerCount: number;
  oorCooldownHours: number;
  repeatDeployCooldownEnabled: boolean;
  repeatDeployCooldownTriggerCount: number;
  repeatDeployCooldownHours: number;
  repeatDeployCooldownScope: "pool" | "token" | "both";
  repeatDeployCooldownMinFeeEarnedPct: number;
  minVolumeToRebalance: number;
  stopLossPct: number;
  takeProfitPct: number;
  minFeePerTvl24h: number;
  minAgeBeforeYieldCheck: number;
  minSolToOpen: number;
  deployAmountSol: number;
  gasReserve: number;
  rentBuffer: number;
  positionSizePct: number;
  trailingTakeProfit: boolean;
  trailingTriggerPct: number;
  trailingDropPct: number;
  pnlSanityMaxDiffPct: number;
  solMode: boolean;
  vpGasCostSol: number;
  vpSlippagePct: number;
  vpSlippagePctUnreliable: number;
  vpTrendExitCycles: number;
}

export interface StrategyConfig {
  strategy: string;
  minBinsBelow: number;
  maxBinsBelow: number;
  defaultBinsBelow: number;
}

export interface ScheduleConfig {
  managementIntervalMin: number;
  screeningIntervalMin: number;
  healthCheckIntervalMin: number;
}

export interface LlmConfig {
  temperature: number;
  maxTokens: number;
  maxSteps: number;
  managementModel: string;
  screeningModel: string;
  generalModel: string;
  thinkingManagement: boolean;
  thinkingScreening: boolean;
  thinkingGeneral: boolean;
}

export interface DarwinConfig {
  enabled: boolean;
  windowDays: number;
  recalcEvery: number;
  boostFactor: number;
  decayFactor: number;
  weightFloor: number;
  weightCeiling: number;
  minSamples: number;
}

export interface TokenMints {
  SOL: string;
  USDC: string;
  USDT: string;
}

export interface HiveMindConfig {
  url: string;
  apiKey: string;
  agentId: string | null;
  pullMode: string;
}

export interface ApiConfig {
  url: string;
  publicApiKey: string;
  lpAgentRelayEnabled: boolean;
}

export interface JupiterConfig {
  apiKey: string;
  referralAccount: string;
  referralFeeBps: number;
}

export interface IndicatorsConfig {
  enabled: boolean;
  entryPreset: string;
  exitPreset: string;
  rsiLength: number;
  intervals: string[];
  candles: number;
  rsiOversold: number;
  rsiOverbought: number;
  requireAllIntervals: boolean;
}

export interface Config {
  risk: RiskConfig;
  screening: ScreeningConfig;
  management: ManagementConfig;
  strategy: StrategyConfig;
  schedule: ScheduleConfig;
  llm: LlmConfig;
  darwin: DarwinConfig;
  tokens: TokenMints;
  hiveMind: HiveMindConfig;
  api: ApiConfig;
  jupiter: JupiterConfig;
  indicators: IndicatorsConfig;
}

// ─── Position ──────────────────────────────────────────────────

export interface Position {
  pool: string;
  baseMint: string;
  quoteMint: string;
  lowerBin: number;
  upperBin: number;
  amount: number;
  deployed_at?: string;
  closed?: boolean;
  closed_at?: string;
  vp_id?: string;
  [key: string]: unknown;
}

// ─── Pool / Screening ──────────────────────────────────────────

export interface PoolCandidate {
  pool: string;
  name: string;
  baseMint: string;
  quoteMint: string;
  fee_active_tvl_ratio: number;
  fee_tvl_ratio?: number;
  volatility: number;
  organic_score: number;
  volume_window?: number;
  active_tvl?: number;
  active_pct?: number;
  [key: string]: unknown;
}

// ─── Logger ────────────────────────────────────────────────────

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface ToolAction {
  tool: string;
  success: boolean;
  duration_ms?: number;
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
  [key: string]: unknown;
}

// ─── Decision Log ──────────────────────────────────────────────

export interface DecisionEntry {
  type?: string;
  actor?: string;
  pool?: string;
  pool_name?: string;
  position?: string;
  summary?: string;
  reason?: string;
  risks?: string[];
  metrics?: Record<string, unknown>;
  rejected?: string[];
}

export interface Decision {
  id: string;
  ts: string;
  type: string;
  actor: string;
  pool: string | null;
  pool_name: string | null;
  position: string | null;
  summary: string | null;
  reason: string | null;
  risks: string[];
  metrics: Record<string, unknown>;
  rejected: string[];
}

// ─── Blacklist ─────────────────────────────────────────────────

export interface BlacklistEntry {
  symbol: string;
  reason: string;
  added_at: string;
  added_by: string;
}

export interface BlocklistEntry {
  label: string;
  reason: string;
  added_at: string;
}

// ─── Envcrypt ──────────────────────────────────────────────────

export interface EnvcryptOptions {
  envPath?: string;
  keyPath?: string;
  override?: boolean;
}

export interface EncryptEnvOptions {
  rawPath?: string;
  outPath?: string;
  keyPath?: string;
}
```

- [ ] **Step 2: Verify types compile**

```bash
npx tsc --noEmit types/index.ts
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add types/
git commit -m "feat: add shared TypeScript type definitions"
```

---

## Task 3: Migrate logger.js → utils/logger.ts

**Files:**
- Create: `utils/logger.ts`
- Delete: `logger.js` (after migration verified)

- [ ] **Step 1: Create utils/logger.ts**

```ts
// utils/logger.ts — Shared logger with daily file rotation
import fs from "fs";
import path from "path";
import type { LogLevel, ToolAction } from "../types/index.js";

const LOG_DIR = "./logs";
const LOG_LEVEL: string = process.env.LOG_LEVEL || "info";

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel: number = LEVELS[LOG_LEVEL as LogLevel] ?? 1;

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * General log function.
 */
export function log(category: string, message: string): void {
  const level: LogLevel = category.includes("error") ? "error"
    : category.includes("warn") ? "warn"
    : "info";

  if (LEVELS[level] < currentLevel) return;

  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${category.toUpperCase()}] ${message}`;

  // Console output
  console.log(line);

  // File output (daily rotation)
  const dateStr = timestamp.split("T")[0];
  const logFile = path.join(LOG_DIR, `agent-${dateStr}.log`);
  fs.appendFileSync(logFile, line + "\n");
}

/**
 * Log a tool action with full details (for audit trail).
 */
function actionHint(action: ToolAction): string {
  const a = action.args ?? {};
  const r = action.result ?? {};
  switch (action.tool) {
    case "deploy_position":   return ` ${(a as Record<string, unknown>).pool_name ?? (a as Record<string, unknown>).pool_address?.toString().slice(0,8)} ${(a as Record<string, unknown>).amount_y ?? (a as Record<string, unknown>).amount_sol} SOL`;
    case "close_position":    return ` ${(a as Record<string, unknown>).position_address?.toString().slice(0,8)}${(r as Record<string, unknown>).pnl_usd != null ? ` | PnL $${(r as Record<string, unknown>).pnl_usd >= 0 ? "+" : ""}${(r as Record<string, unknown>).pnl_usd} (${(r as Record<string, unknown>).pnl_pct}%)` : ""}`;
    case "claim_fees":        return ` ${(a as Record<string, unknown>).position_address?.toString().slice(0,8)}`;
    case "get_active_bin":    return ` bin ${(r as Record<string, unknown>).binId ?? ""}`;
    case "get_pool_detail":   return ` ${(r as Record<string, unknown>).name || (a as Record<string, unknown>).pool_address?.toString().slice(0,8) || ""}`;
    case "get_my_positions":  return ` ${(r as Record<string, unknown>).total_positions ?? ""} positions`;
    case "get_wallet_balance":return ` ${(r as Record<string, unknown>).sol ?? ""} SOL`;
    case "get_top_candidates":return ` ${(r as Record<string, unknown>)?.candidates?.length ?? ""} pools`;
    case "swap_token":        return ` ${(a as Record<string, unknown>).amount} ${(a as Record<string, unknown>).input_mint?.toString().slice(0,6)}→SOL`;
    case "update_config":     return ` ${Object.keys((r as Record<string, unknown>).applied ?? {}).join(", ")}`;
    case "add_lesson":        return ` saved`;
    case "clear_lessons":     return ` cleared ${(r as Record<string, unknown>).cleared ?? ""}`;
    default:                  return "";
  }
}

export function logAction(action: ToolAction): void {
  const timestamp = new Date().toISOString();

  const entry = { timestamp, ...action };

  // Console: single clean line, no raw JSON
  const status = action.success ? "✓" : "✗";
  const dur = action.duration_ms != null ? ` (${action.duration_ms}ms)` : "";
  const hint = actionHint(action);
  console.log(`[${action.tool}] ${status}${hint}${dur}`);

  // File: full JSON for audit trail
  const dateStr = timestamp.split("T")[0];
  const actionsFile = path.join(LOG_DIR, `actions-${dateStr}.jsonl`);
  fs.appendFileSync(actionsFile, JSON.stringify(entry) + "\n");
}
```

- [ ] **Step 2: Verify logger.ts compiles**

```bash
npx tsc --noEmit utils/logger.ts
```

Expected: No errors.

- [ ] **Step 3: Delete logger.js**

```bash
rm logger.js
```

- [ ] **Step 4: Update all imports that reference logger.js**

Search for imports of `./logger.js` or `../logger.js` and update to `./utils/logger.js` or the correct relative path. Since `allowJs: true` is set, .js files can still import from .ts files — but the import paths need updating.

Run: `rg "from.*logger\.js" --files-with-matches` to find all files importing logger.

Update each import path. For root files importing `./logger.js`, change to `./utils/logger.js`. For tools files importing `../logger.js`, change to `../utils/logger.js`.

- [ ] **Step 5: Verify full project compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 6: Run existing tests**

```bash
npm test
```

Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: migrate logger.js to TypeScript"
```

---

## Task 4: Migrate envcrypt.js → utils/envrypt.ts

**Files:**
- Create: `utils/envrypt.ts`
- Delete: `envcrypt.js`

- [ ] **Step 1: Create utils/envrypt.ts**

```ts
// utils/envrypt.ts — Encryption utility for .env files
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import type { EnvcryptOptions, EncryptEnvOptions } from "../types/index.js";

const DEFAULT_ENV_PATH = path.join(process.cwd(), ".env");
const DEFAULT_KEY_PATH = path.join(process.cwd(), ".envrypt");

function isEncryptedMarker(line: string): boolean {
  return line.trim().toLowerCase() === "# encrypted";
}

function parseEncryptedKeys(filePath: string): Set<string> {
  if (!fs.existsSync(filePath)) return new Set();

  const encrypted = new Set<string>();
  let encryptedNext = false;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      encryptedNext = false;
      continue;
    }
    if (isEncryptedMarker(trimmed)) {
      encryptedNext = true;
      continue;
    }
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (match && encryptedNext) encrypted.add(match[1]);
    encryptedNext = false;
  }
  return encrypted;
}

function getEnvcryptKey(keyPath: string = DEFAULT_KEY_PATH): string | null {
  const key =
    process.env.ENVRYPT_KEY ||
    process.env.ENVCRYPT_KEY ||
    (fs.existsSync(keyPath) ? fs.readFileSync(keyPath, "utf8").trim() : "");

  if (!key) return null;
  if (key.length < 8) {
    throw new Error("Envrypt encryption key must be at least 8 characters long.");
  }
  return key;
}

function shouldEncryptEnvKey(envKey: string): boolean {
  return envKey.endsWith("_KEY") ||
    envKey.startsWith("ENVRIPT_") ||
    /(?:PRIVATE|SECRET|TOKEN|PASSPHRASE|PASSWORD|MNEMONIC)/i.test(envKey);
}

export function envryptEncrypt(value: string | number, key: string): string {
  return Buffer.from(
    Array.from(String(value), (char, index) =>
      String.fromCharCode(char.charCodeAt(0) ^ key.charCodeAt(index % key.length))
    ).join(""),
    "ascii",
  ).toString("base64");
}

export function envryptDecrypt(value: string, key: string): string {
  const encrypted = Buffer.from(String(value), "base64").toString("utf8");
  return Array.from(encrypted, (char, index) =>
    String.fromCharCode(char.charCodeAt(0) ^ key.charCodeAt(index % key.length))
  ).join("");
}

export function loadEnv({ envPath = DEFAULT_ENV_PATH, keyPath = DEFAULT_KEY_PATH, override = false }: EnvcryptOptions = {}): { encryptedKeys: string[] } {
  dotenv.config({ path: envPath, override, quiet: true });

  const encryptedKeys = parseEncryptedKeys(envPath);
  if (encryptedKeys.size === 0) return { encryptedKeys: [] };

  const key = getEnvcryptKey(keyPath);
  if (!key) {
    throw new Error(
      `Encrypted env values found in ${envPath}, but no envrypt key was provided. ` +
      "Create .envrypt or set ENVRYPT_KEY / ENVCRYPT_KEY.",
    );
  }

  for (const envKey of encryptedKeys) {
    const value = process.env[envKey];
    if (value == null || value === "") continue;
    process.env[envKey] = envryptDecrypt(value, key);
  }

  return { encryptedKeys: [...encryptedKeys] };
}

export function encryptEnvRaw({
  rawPath = path.join(process.cwd(), ".env.raw"),
  outPath = DEFAULT_ENV_PATH,
  keyPath = DEFAULT_KEY_PATH,
}: EncryptEnvOptions = {}): { rawPath: string; outPath: string } {
  if (!fs.existsSync(rawPath)) {
    throw new Error(`No ${rawPath} file found.`);
  }

  const key = getEnvcryptKey(keyPath);
  if (!key) {
    throw new Error("Create .envrypt or set ENVRYPT_KEY / ENVCRYPT_KEY before encrypting.");
  }

  const parsed = dotenv.parse(fs.readFileSync(rawPath, "utf8"));
  const lines = ["# Envrypt managed environment file.", ""];
  for (const [envKey, value] of Object.entries(parsed)) {
    if (shouldEncryptEnvKey(envKey)) {
      lines.push("# encrypted");
      lines.push(`${envKey}=${envryptEncrypt(value, key)}`, "");
    } else {
      lines.push(`${envKey}=${value}`);
    }
  }

  fs.writeFileSync(outPath, `${lines.join("\n").replace(/\n+$/, "")}\n`);
  return { rawPath, outPath };
}

loadEnv();
```

- [ ] **Step 2: Verify envrypt.ts compiles**

```bash
npx tsc --noEmit utils/envrypt.ts
```

Expected: No errors.

- [ ] **Step 3: Delete envcrypt.js**

```bash
rm envcrypt.js
```

- [ ] **Step 4: Update imports**

Find and update all imports referencing `./envcrypt.js` or `../envcrypt.js`.

- [ ] **Step 5: Verify full project compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: migrate envcrypt.js to TypeScript"
```

---

## Task 5: Migrate token-blacklist.js + dev-blocklist.js → core/token-blacklist.ts

**Files:**
- Create: `core/token-blacklist.ts`
- Delete: `token-blacklist.js`, `dev-blocklist.js`

- [ ] **Step 1: Create core/token-blacklist.ts**

```ts
// core/token-blacklist.ts — Token blacklist + dev deployer blocklist
import fs from "fs";
import { log } from "../utils/logger.js";
import type { BlacklistEntry, BlocklistEntry } from "../types/index.js";

const BLACKLIST_FILE = "./token-blacklist.json";
const BLOCKLIST_FILE = "./dev-blocklist.json";

// ─── Token Blacklist ───────────────────────────────────────────

function loadBlacklist(): Record<string, BlacklistEntry> {
  if (!fs.existsSync(BLACKLIST_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(BLACKLIST_FILE, "utf8"));
  } catch (error) {
    log("blacklist_error", `Invalid ${BLACKLIST_FILE}: ${(error as Error).message}`);
    throw new Error(`Safety blacklist is unreadable: ${BLACKLIST_FILE}`);
  }
}

function saveBlacklist(data: Record<string, BlacklistEntry>): void {
  fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(data, null, 2));
}

export function isBlacklisted(mint: string): boolean {
  if (!mint) return false;
  const db = loadBlacklist();
  return !!db[mint];
}

export function addToBlacklist({ mint, symbol, reason }: { mint: string; symbol?: string; reason?: string }): Record<string, unknown> {
  if (!mint) return { error: "mint required" };

  const db = loadBlacklist();

  if (db[mint]) {
    return {
      already_blacklisted: true,
      mint,
      symbol: db[mint].symbol,
      reason: db[mint].reason,
    };
  }

  db[mint] = {
    symbol: symbol || "UNKNOWN",
    reason: reason || "no reason provided",
    added_at: new Date().toISOString(),
    added_by: "agent",
  };

  saveBlacklist(db);
  log("blacklist", `Blacklisted ${symbol || mint}: ${reason}`);
  return { blacklisted: true, mint, symbol, reason };
}

export function removeFromBlacklist({ mint }: { mint: string }): Record<string, unknown> {
  if (!mint) return { error: "mint required" };

  const db = loadBlacklist();

  if (!db[mint]) {
    return { error: `Mint ${mint} not found on blacklist` };
  }

  const entry = db[mint];
  delete db[mint];
  saveBlacklist(db);
  log("blacklist", `Removed ${entry.symbol || mint} from blacklist`);
  return { removed: true, mint, was: entry };
}

export function listBlacklist(): { count: number; blacklist: Array<{ mint: string } & BlacklistEntry> } {
  const db = loadBlacklist();
  const entries = Object.entries(db).map(([mint, info]) => ({
    mint,
    ...info,
  }));

  return {
    count: entries.length,
    blacklist: entries,
  };
}

// ─── Dev Blocklist ─────────────────────────────────────────────

function loadBlocklist(): Record<string, BlocklistEntry> {
  if (!fs.existsSync(BLOCKLIST_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(BLOCKLIST_FILE, "utf8"));
  } catch (error) {
    log("dev_blocklist_error", `Invalid ${BLOCKLIST_FILE}: ${(error as Error).message}`);
    throw new Error(`Safety blocklist is unreadable: ${BLOCKLIST_FILE}`);
  }
}

function saveBlocklist(data: Record<string, BlocklistEntry>): void {
  fs.writeFileSync(BLOCKLIST_FILE, JSON.stringify(data, null, 2));
}

export function isDevBlocked(devWallet: string): boolean {
  if (!devWallet) return false;
  return !!loadBlocklist()[devWallet];
}

export function getBlockedDevs(): Record<string, BlocklistEntry> {
  return loadBlocklist();
}

export function blockDev({ wallet, reason, label }: { wallet: string; reason?: string; label?: string }): Record<string, unknown> {
  if (!wallet) return { error: "wallet required" };
  const db = loadBlocklist();
  if (db[wallet]) return { already_blocked: true, wallet, label: db[wallet].label, reason: db[wallet].reason };
  db[wallet] = {
    label: label || "unknown",
    reason: reason || "no reason provided",
    added_at: new Date().toISOString(),
  };
  saveBlocklist(db);
  log("dev_blocklist", `Blocked deployer ${label || wallet}: ${reason}`);
  return { blocked: true, wallet, label, reason };
}

export function unblockDev({ wallet }: { wallet: string }): Record<string, unknown> {
  if (!wallet) return { error: "wallet required" };
  const db = loadBlocklist();
  if (!db[wallet]) return { error: `Wallet ${wallet} not on dev blocklist` };
  const entry = db[wallet];
  delete db[wallet];
  saveBlocklist(db);
  log("dev_blocklist", `Removed deployer ${entry.label || wallet} from blocklist`);
  return { unblocked: true, wallet, was: entry };
}

export function listBlockedDevs(): { count: number; blocked_devs: Array<{ wallet: string } & BlocklistEntry> } {
  const db = loadBlocklist();
  const entries = Object.entries(db).map(([wallet, info]) => ({ wallet, ...info }));
  return { count: entries.length, blocked_devs: entries };
}
```

- [ ] **Step 2: Verify compiles**

```bash
npx tsc --noEmit core/token-blacklist.ts
```

- [ ] **Step 3: Delete old files**

```bash
rm token-blacklist.js dev-blocklist.js
```

- [ ] **Step 4: Update all imports**

Search for `from.*token-blacklist.js` and `from.*dev-blocklist.js` and update to `../core/token-blacklist.js`.

- [ ] **Step 5: Verify full project compiles + tests pass**

```bash
npx tsc --noEmit && npm test
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: migrate token-blacklist + dev-blocklist to TypeScript"
```

---

## Task 6: Migrate decision-log.js → core/decision-log.ts

**Files:**
- Create: `core/decision-log.ts`
- Delete: `decision-log.js`

- [ ] **Step 1: Create core/decision-log.ts**

```ts
// core/decision-log.ts — Decision audit trail
import fs from "fs";
import { log } from "../utils/logger.js";
import type { Decision, DecisionEntry } from "../types/index.js";

const DECISION_LOG_FILE = "./decision-log.json";
const MAX_DECISIONS = 100;

function load(): { decisions: Decision[] } {
  if (!fs.existsSync(DECISION_LOG_FILE)) {
    return { decisions: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(DECISION_LOG_FILE, "utf8"));
  } catch (error) {
    log("decision_log_warn", `Invalid ${DECISION_LOG_FILE}: ${(error as Error).message}`);
    return { decisions: [] };
  }
}

function save(data: { decisions: Decision[] }): void {
  fs.writeFileSync(DECISION_LOG_FILE, JSON.stringify(data, null, 2));
}

function sanitize(value: unknown, maxLen = 280): string | null {
  if (value == null) return null;
  return String(value).replace(/\s+/g, " ").trim().slice(0, maxLen) || null;
}

export function appendDecision(entry: DecisionEntry): Decision {
  const data = load();
  const decision: Decision = {
    id: `dec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ts: new Date().toISOString(),
    type: entry.type || "note",
    actor: entry.actor || "GENERAL",
    pool: entry.pool || null,
    pool_name: sanitize(entry.pool_name ?? entry.pool, 120),
    position: entry.position || null,
    summary: sanitize(entry.summary),
    reason: sanitize(entry.reason, 500),
    risks: Array.isArray(entry.risks) ? entry.risks.map((r) => sanitize(r, 140)).filter((r): r is string => r !== null).slice(0, 6) : [],
    metrics: entry.metrics || {},
    rejected: Array.isArray(entry.rejected) ? entry.rejected.map((r) => sanitize(r, 180)).filter((r): r is string => r !== null).slice(0, 8) : [],
  };
  data.decisions.unshift(decision);
  data.decisions = data.decisions.slice(0, MAX_DECISIONS);
  save(data);
  return decision;
}

export function getRecentDecisions(limit = 10): Decision[] {
  const data = load();
  return (data.decisions || []).slice(0, limit);
}

export function getDecisionSummary(limit = 6): string {
  const decisions = getRecentDecisions(limit);
  if (!decisions.length) return "No recent structured decisions yet.";
  return decisions.map((d, i) => {
    const bits = [
      `${i + 1}. [${d.actor}] ${d.type.toUpperCase()} ${d.pool_name || d.pool || "unknown pool"}`,
      d.summary ? `summary: ${d.summary}` : null,
      d.reason ? `reason: ${d.reason}` : null,
      d.risks?.length ? `risks: ${d.risks.join(", ")}` : null,
      d.rejected?.length ? `rejected: ${d.rejected.join(" | ")}` : null,
    ].filter(Boolean);
    return bits.join(" | ");
  }).join("\n");
}
```

- [ ] **Step 2: Verify compiles**

```bash
npx tsc --noEmit core/decision-log.ts
```

- [ ] **Step 3: Delete old file + update imports**

```bash
rm decision-log.js
```

Update all `from.*decision-log.js` imports.

- [ ] **Step 4: Verify + commit**

```bash
npx tsc --noEmit && npm test
git add -A
git commit -m "feat: migrate decision-log.js to TypeScript"
```

---

## Task 7: Migrate briefing.js → core/briefing.ts

**Files:**
- Create: `core/briefing.ts`
- Delete: `briefing.js`

- [ ] **Step 1: Create core/briefing.ts**

```ts
// core/briefing.ts — Daily briefing generator
import fs from "fs";
import { log } from "../utils/logger.js";
import { getPerformanceSummary } from "./lessons.js";

const STATE_FILE = "./state.json";
const LESSONS_FILE = "./lessons.json";

interface StateData {
  positions?: Record<string, Record<string, unknown>>;
  recentEvents?: unknown[];
}

interface LessonsData {
  lessons?: Array<{ rule: string; created_at: string }>;
  performance?: Array<{ pnl_usd: number; fees_earned_usd: number; recorded_at: string }>;
}

function loadJson<T>(file: string): T | null {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (err) {
    log("briefing_error", `Failed to read ${file}: ${(err as Error).message}`);
    return null;
  }
}

export async function generateBriefing(): Promise<string> {
  const state = loadJson<StateData>(STATE_FILE) ?? { positions: {}, recentEvents: [] };
  const lessonsData = loadJson<LessonsData>(LESSONS_FILE) ?? { lessons: [], performance: [] };

  const now = new Date();
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // 1. Positions Activity
  const allPositions = Object.values(state.positions ?? {});
  const openedLast24h = allPositions.filter(p => new Date(p.deployed_at as string) > last24h);
  const closedLast24h = allPositions.filter(p => p.closed && new Date(p.closed_at as string) > last24h);

  // 2. Performance Activity (from performance log)
  const perfLast24h = (lessonsData.performance ?? []).filter(p => new Date(p.recorded_at) > last24h);
  const totalPnLUsd = perfLast24h.reduce((sum, p) => sum + (p.pnl_usd ?? 0), 0);
  const totalFeesUsd = perfLast24h.reduce((sum, p) => sum + (p.fees_earned_usd ?? 0), 0);

  // 3. Lessons Learned
  const lessonsLast24h = (lessonsData.lessons ?? []).filter(l => new Date(l.created_at) > last24h);

  // 4. Current State
  const openPositions = allPositions.filter(p => !p.closed);
  const perfSummary = getPerformanceSummary();

  // 5. Format Message
  const lines = [
    "☀️ <b>Morning Briefing</b> (Last 24h)",
    "────────────────",
    `<b>Activity:</b>`,
    `📥 Positions Opened: ${openedLast24h.length}`,
    `📤 Positions Closed: ${closedLast24h.length}`,
    "",
    `<b>Performance:</b>`,
    `💰 Net PnL: ${totalPnLUsd >= 0 ? "+" : ""}$${totalPnLUsd.toFixed(2)}`,
    `💎 Fees Earned: $${totalFeesUsd.toFixed(2)}`,
    perfLast24h.length > 0
      ? `📈 Win Rate (24h): ${Math.round((perfLast24h.filter(p => p.pnl_usd > 0).length / perfLast24h.length) * 100)}%`
      : "📈 Win Rate (24h): N/A",
    "",
    `<b>Lessons Learned:</b>`,
    lessonsLast24h.length > 0
      ? lessonsLast24h.map(l => `• ${l.rule}`).join("\n")
      : "• No new lessons recorded overnight.",
    "",
    `<b>Current Portfolio:</b>`,
    `📂 Open Positions: ${openPositions.length}`,
    perfSummary
      ? `📊 All-time PnL: $${perfSummary.total_pnl_usd.toFixed(2)} (${perfSummary.win_rate_pct}% win)`
      : "",
    "────────────────"
  ];

  return lines.join("\n");
}
```

- [ ] **Step 2: Verify compiles + delete old + update imports**

```bash
npx tsc --noEmit core/briefing.ts
rm briefing.js
# Update imports referencing briefing.js
npx tsc --noEmit && npm test
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: migrate briefing.js to TypeScript"
```

---

## Task 8: Migrate signal-tracker.js → core/signal-tracker.ts

**Files:**
- Create: `core/signal-tracker.ts`
- Delete: `signal-tracker.js`

- [ ] **Step 1: Create core/signal-tracker.ts**

```ts
// core/signal-tracker.ts — Stages screening signals for later attribution
import { log } from "../utils/logger.js";

export interface StagedSignals {
  organic_score?: number;
  fee_tvl_ratio?: number;
  volume?: number;
  mcap?: number;
  holder_count?: number;
  smart_wallets_present?: boolean;
  narrative_quality?: string;
  study_win_rate?: number;
  hive_consensus?: number;
  volatility?: number;
  base_mint?: string;
  baseMint?: string;
  [key: string]: unknown;
}

// In-memory staging area — cleared after retrieval or after 10 minutes
const _staged = new Map<string, StagedSignals & { staged_at: number }>();
const _stagedByBaseMint = new Map<string, string>();
const STAGE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function normalizeKey(value: unknown): string | null {
  return value ? String(value).trim() : null;
}

function cleanupStale(): void {
  const now = Date.now();
  for (const [addr, data] of _staged) {
    if (now - data.staged_at > STAGE_TTL_MS) {
      _staged.delete(addr);
      if (data.base_mint && _stagedByBaseMint.get(data.base_mint) === addr) {
        _stagedByBaseMint.delete(data.base_mint);
      }
    }
  }
}

/**
 * Stage signals for a pool during screening.
 */
export function stageSignals(poolAddress: string, signals: StagedSignals): void {
  cleanupStale();
  const poolKey = normalizeKey(poolAddress);
  if (!poolKey) return;

  const baseMint = normalizeKey(signals.base_mint ?? signals.baseMint);
  _staged.set(poolKey, {
    ...signals,
    base_mint: baseMint ?? signals.base_mint ?? null,
    staged_at: Date.now(),
  });
  if (baseMint) {
    _stagedByBaseMint.set(baseMint, poolKey);
  }
}

/**
 * Retrieve and clear staged signals for a pool.
 */
export function getAndClearStagedSignals(poolAddress: string, baseMint: string | null = null): StagedSignals | null {
  cleanupStale();

  let poolKey = normalizeKey(poolAddress);
  let data = poolKey ? _staged.get(poolKey) : undefined;

  if (!data && baseMint) {
    const baseKey = normalizeKey(baseMint);
    poolKey = baseKey ? _stagedByBaseMint.get(baseKey) : undefined;
    data = poolKey ? _staged.get(poolKey) : undefined;
  }

  if (!data) return null;
  if (poolKey) {
    _staged.delete(poolKey);
  }
  if (data.base_mint && _stagedByBaseMint.get(data.base_mint) === poolKey) {
    _stagedByBaseMint.delete(data.base_mint);
  }
  const { staged_at: _staged_at, ...signals } = data;
  log("signals", `Retrieved staged signals for ${poolKey?.slice(0, 8)}: ${Object.keys(signals).filter(k => signals[k] != null).length} signals`);
  return signals;
}

/**
 * Get all currently staged pool addresses (for debugging).
 */
export function getStagedPools(): string[] {
  cleanupStale();
  return [..._staged.keys()];
}
```

- [ ] **Step 2: Verify + delete + update imports + commit**

```bash
npx tsc --noEmit core/signal-tracker.ts
rm signal-tracker.js
# Update imports
npx tsc --noEmit && npm test
git add -A
git commit -m "feat: migrate signal-tracker.js to TypeScript"
```

---

## Task 9: Migrate config.js → config/index.ts

**Files:**
- Create: `config/index.ts`
- Delete: `config.js`

This is a larger file (314 lines). The migration follows the same pattern: add types to all exports, define the Config interface usage, type all internal helpers.

- [ ] **Step 1: Create config/index.ts**

Copy `config.js` to `config/index.ts`. Apply these changes:
1. Import `Config` type from `../types/index.js`
2. Type the `config` object as `Config`
3. Type `numericConfig(value: unknown): number | null`
4. Type `nonEmptyString(...values: unknown[]): string | null`
5. Type `computeDeployAmount(walletSol: number): number`
6. Type `reloadScreeningThresholds(): void`
7. Type `MIN_SAFE_BINS_BELOW` as `const MIN_SAFE_BINS_BELOW: number = 35`

The full file is 314 lines — refer to the source at `config.js` for the complete implementation. Key type annotations:

```ts
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { Config } from "../types/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

// ... (rest of file with types added to all functions and the config object)
```

- [ ] **Step 2: Verify compiles**

```bash
npx tsc --noEmit config/index.ts
```

- [ ] **Step 3: Delete config.js + update imports**

```bash
rm config.js
# Update all imports: from "./config.js" → from "./config/index.js"
# For root files: from "./config.js" → from "./config/index.js"
```

- [ ] **Step 4: Verify full project + tests**

```bash
npx tsc --noEmit && npm test
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: migrate config.js to TypeScript"
```

---

## Task 10: Remaining Migrations (Pattern Repeat)

After Tasks 1-9, the pattern is established. Each subsequent file follows the same steps:

1. Create the `.ts` file in the target directory
2. Add type annotations to all exports, parameters, and return types
3. Import shared types from `types/index.ts` or local interfaces
4. Delete the old `.js` file
5. Update all import paths referencing the old file
6. Verify `npx tsc --noEmit` passes
7. Run `npm test`
8. Commit

### Remaining files to migrate (in dependency order):

**Tier 2 — Medium JSON modules:**
- `strategy-library.js` → `core/strategy-library.ts` (227 lines)
- `signal-weights.js` → `core/signal-weights.ts` (330 lines)
- `smart-wallets.js` → `core/smart-wallets.ts` (103 lines)
- `pool-memory.js` → `core/pool-memory.ts` (405 lines)
- `lessons.js` → `core/lessons.ts` (781 lines)

**Tier 3 — Pure logic:**
- `tools/compute-position-pnl.js` → `core/pnl.ts` (397 lines)
- `tools/virtual-close-rule.js` → `core/vp/close-rule.ts` (130 lines)
- `tools/virtual-digest.js` → `core/vp/digest.ts` (140 lines)
- `tools/merge-virtual-positions.js` → `core/vp/merge.ts` (102 lines)

**Tier 4 — External adapters:**
- `tools/agent-meridian.js` → `external/lpagent/index.ts` (110 lines)
- `tools/study.js` → `external/lpagent/study.ts` (152 lines)
- `tools/token.js` → `external/jupiter/token.ts` (209 lines)
- `tools/okx.js` → `external/okx/index.ts` (282 lines)
- `tools/chart-indicators.js` → `external/meteora/indicators.ts` (299 lines)
- `tools/gas-estimator.js` → `external/meteora/gas.ts` (179 lines)

**Tier 5 — Complex externals:**
- `tools/wallet.js` → `external/helius/index.ts` + `external/jupiter/index.ts` (314 lines, split)
- `tools/screening.js` → `external/meteora/pool-discovery.ts` (865 lines)
- `tools/dlmm.js` → `external/meteora/index.ts` (2653 lines — consider splitting)

**Tier 6 — Stateful core:**
- `state.js` → `core/state.ts` (513 lines)
- `tools/position-archive.js` → `core/archive.ts` (487 lines)
- `tools/dry-run-state.js` → `core/vp/state.ts` (319 lines)
- `tools/manage-virtual.js` → `core/vp/manage.ts` (462 lines)

**Tier 7 — Integration:**
- `prompt.js` → `llm/prompt.ts` (178 lines)
- `agent.js` → `llm/agent.ts` (444 lines)
- `telegram.js` → `bots/telegram/index.ts` (588 lines)
- `tools/definitions.js` → `bots/tools/definitions.ts` (1145 lines)
- `tools/executor.js` → `bots/tools/executor.ts` (949 lines)

**Tier 8 — Entry points:**
- `cli.js` → `cli.ts` (676 lines)
- `setup.js` → `setup.ts` (481 lines)
- `index.js` → `index.ts` (2250 lines)
- `hivemind.js` → `external/hivemind/index.ts` (346 lines)
- `discord-listener/index.js` → `bots/discord/index.ts`
- `discord-listener/pre-checks.js` → `bots/discord/pre-checks.ts`

**Tier 9 — Scripts:**
- `scripts/envrypt.js` → `utils/envrypt-cli.ts`
- `scripts/measure-gas.js` → `external/meteora/measure-gas.ts`
- `scripts/patch-anchor.js` → `utils/patch-anchor.ts`
- `scripts/validate-slippage.js` → `core/pnl/validate-slippage.ts`

### Directory creation

Before Tier 4+, create the target directories:

```bash
mkdir -p external/{meteora,helius,jupiter,okx,lpagent,hivemind}
mkdir -p core/vp
mkdir -p llm
mkdir -p bots/{tools,discord}
```

---

## Verification Checklist

After all migrations complete:

- [ ] `npx tsc --noEmit` — zero errors
- [ ] `npm test` — all tests pass
- [ ] `DRY_RUN=true npm start -- --cycle` — agent runs correctly
- [ ] `state.json` matches pre-migration baseline
- [ ] No `.js` source files remain (except `node_modules`)
- [ ] Remove `allowJs: true` from tsconfig.json
- [ ] Final `git log --oneline` shows clean incremental migration history
