/**
 * Interactive setup wizard.
 * Guides user through .env + user-config.json creation.
 * Run: npm run setup
 */

import "./utils/secure-env.js";
import readline from "readline";
import fs from "fs";
import path from "path";

const CONFIG_PATH = path.join(process.cwd(), "user-config.json");
const ENV_PATH    = path.join(process.cwd(), ".env");

const DEFAULT_MODEL = "openai/gpt-oss-20b:free";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question: string, defaultVal: any): Promise<string> {
  return new Promise((resolve) => {
    const hint = defaultVal !== undefined && defaultVal !== "" ? ` (default: ${defaultVal})` : "";
    rl.question(`${question}${hint}: `, (ans: string) => {
      const trimmed = ans.trim();
      resolve(trimmed === "" ? defaultVal : trimmed);
    });
  });
}

function askNum(
  question: string,
  defaultVal: any,
  { min, max }: { min?: number; max?: number } = {}
): Promise<number> {
  return new Promise(async (resolve) => {
    while (true) {
      const raw = await ask(question, defaultVal);
      const n = parseFloat(raw);
      if (isNaN(n))                        { console.log(`  ⚠ Please enter a number.`); continue; }
      if (min !== undefined && n < min)    { console.log(`  ⚠ Minimum is ${min}.`);     continue; }
      if (max !== undefined && n > max)    { console.log(`  ⚠ Maximum is ${max}.`);     continue; }
      resolve(n);
      break;
    }
  });
}

function askBool(question: string, defaultVal: boolean): Promise<boolean> {
  return new Promise(async (resolve) => {
    while (true) {
      const hint = defaultVal ? "Y/n" : "y/N";
      const raw = await ask(`${question} [${hint}]`, "");
      if (raw === "") { resolve(defaultVal); break; }
      if (/^y(es)?$/i.test(raw)) { resolve(true);  break; }
      if (/^n(o)?$/i.test(raw))  { resolve(false); break; }
      console.log("  ⚠ Enter y or n.");
    }
  });
}

interface Choice {
  label: string;
  key?: string;
}

function askChoice<T extends Choice>(question: string, choices: T[], defaultKey?: string): Promise<T> {
  return new Promise(async (resolve) => {
    const labels = choices.map((c, i) => `  ${i + 1}. ${c.label}`).join("\n");
    while (true) {
      console.log(`\n${question}`);
      console.log(labels);
      const raw = await ask("Enter number", "");
      if (raw === "" && defaultKey !== undefined) {
        const found = choices.find((c) => c.key === defaultKey);
        if (found) { resolve(found); break; }
      }
      const idx = parseInt(raw) - 1;
      if (idx >= 0 && idx < choices.length) { resolve(choices[idx]); break; }
      console.log("  ⚠ Invalid choice.");
    }
  });
}

function parseEnv(content: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) map[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return map;
}

function buildEnv(map: Record<string, string>): string {
  return Object.entries(map).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
}

// ─── Presets ──────────────────────────────────────────────────────────────────
interface Preset {
  label: string;
  timeframe: string;
  strategy: string;
  minOrganic: number;
  minQuoteOrganic: number;
  minHolders: number;
  minMcap: number;
  maxMcap: number;
  minVolume: number;
  minBinStep: number;
  maxBinStep: number;
  minFeeActiveTvlRatio: number;
  minTokenFeesSol: number;
  takeProfitPct: number;
  stopLossPct: number;
  outOfRangeWaitMinutes: number;
  positionSizePct: number;
  maxDeployAmount: number;
  gasReserve: number;
  minAgeBeforeYieldCheck: number;
  managementIntervalMin: number;
  screeningIntervalMin: number;
  description: string;
}

const PRESETS: Record<string, Preset> = {
  degen: {
    label:                 "Degen",
    timeframe:             "30m",
    strategy:              "bid_ask",
    minOrganic:            60,
    minQuoteOrganic:       60,
    minHolders:            200,
    minMcap:               100_000,
    maxMcap:               5_000_000,
    minVolume:             300,
    minBinStep:            80,
    maxBinStep:            125,
    minFeeActiveTvlRatio:  0.02,
    minTokenFeesSol:       10,
    takeProfitPct:         10,
    stopLossPct:           -25,
    outOfRangeWaitMinutes: 15,
    positionSizePct:       0.25,
    maxDeployAmount:       25,
    gasReserve:            0.3,
    minAgeBeforeYieldCheck: 30,
    managementIntervalMin: 5,
    screeningIntervalMin:  15,
    description: "30m timeframe, pumping tokens allowed, fast cycles. High risk/reward.",
  },
  moderate: {
    label:                 "Moderate",
    timeframe:             "4h",
    strategy:              "bid_ask",
    minOrganic:            65,
    minQuoteOrganic:       65,
    minHolders:            500,
    minMcap:               150_000,
    maxMcap:               10_000_000,
    minVolume:             500,
    minBinStep:            80,
    maxBinStep:            125,
    minFeeActiveTvlRatio:  0.05,
    minTokenFeesSol:       30,
    takeProfitPct:         5,
    stopLossPct:           -15,
    outOfRangeWaitMinutes: 30,
    positionSizePct:       0.35,
    maxDeployAmount:       50,
    gasReserve:            0.2,
    minAgeBeforeYieldCheck: 60,
    managementIntervalMin: 10,
    screeningIntervalMin:  30,
    description: "4h timeframe, balanced risk/reward. Recommended for most users.",
  },
  safe: {
    label:                 "Safe",
    timeframe:             "24h",
    strategy:              "spot",
    minOrganic:            75,
    minQuoteOrganic:       75,
    minHolders:            1000,
    minMcap:               200_000,
    maxMcap:               10_000_000,
    minVolume:             1000,
    minBinStep:            80,
    maxBinStep:            125,
    minFeeActiveTvlRatio:  0.1,
    minTokenFeesSol:       50,
    takeProfitPct:         3,
    stopLossPct:           -10,
    outOfRangeWaitMinutes: 60,
    positionSizePct:       0.50,
    maxDeployAmount:       100,
    gasReserve:            0.15,
    minAgeBeforeYieldCheck: 120,
    managementIntervalMin: 15,
    screeningIntervalMin:  60,
    description: "24h timeframe, stable pools only, avoids pumps. Lower yield, lower risk.",
  },
};

// ─── Load existing state ───────────────────────────────────────────────────────
const existingConfig: Record<string, any> = fs.existsSync(CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))
  : {};
const existingEnv: Record<string, string> = fs.existsSync(ENV_PATH)
  ? parseEnv(fs.readFileSync(ENV_PATH, "utf8"))
  : {};

const e  = (key: string, fallback: any): any => existingConfig[key] ?? fallback;
const ev = (key: string, fallback: string): string => existingEnv[key] ?? fallback;

// ─── Banner ────────────────────────────────────────────────────────────────────
console.log(`
╔═══════════════════════════════════════════════╗
║        Meridian — Setup Wizard                ║
║        Autonomous Meteora DLMM LP Agent       ║
╚═══════════════════════════════════════════════╝

This wizard creates your .env and user-config.json.
Press Enter to keep the current/default value.
`);

// ─── Section 1: API Keys & Wallet ─────────────────────────────────────────────
console.log("── API Keys & Wallet ─────────────────────────────────────────");

const alreadySet = (val: any): string => val ? "*** (already set — Enter to keep)" : "";

const openrouterKey = await ask(
  "OpenRouter API key (sk-or-...)",
  alreadySet(ev("OPENROUTER_API_KEY", ""))
);

const walletKey = await ask(
  "Wallet private key (base58)",
  alreadySet(ev("WALLET_PRIVATE_KEY", existingConfig.walletKey || ""))
);

const rpcUrl = await ask(
  "RPC URL",
  ev("RPC_URL", e("rpcUrl", "https://api.mainnet-beta.solana.com"))
);

const heliusKey = await ask(
  "Helius API key (for balance lookups, optional)",
  alreadySet(ev("HELIUS_API_KEY", ""))
);

// ─── Section 2: Telegram ──────────────────────────────────────────────────────
console.log("\n── Telegram (optional — skip to disable) ─────────────────────");

const telegramToken = await ask(
  "Telegram bot token",
  alreadySet(ev("TELEGRAM_BOT_TOKEN", ""))
);

const telegramChatId = await ask(
  "Telegram chat ID",
  ev("TELEGRAM_CHAT_ID", e("telegramChatId", ""))
);

// ─── Section 3: Preset ────────────────────────────────────────────────────────
// Detect existing preset from config for default-key support on re-runs
const existingPreset = Object.keys(PRESETS).find((k) => {
  const p = PRESETS[k];
  return e("timeframe", "") === p.timeframe && e("minOrganic", 0) === p.minOrganic;
});
const presetChoice = await askChoice("Select a risk preset:", [
  { label: `🔥 Degen    — ${PRESETS.degen.description}`,    key: "degen"    },
  { label: `⚖️  Moderate — ${PRESETS.moderate.description}`, key: "moderate" },
  { label: `🛡️  Safe     — ${PRESETS.safe.description}`,     key: "safe"     },
  { label: "⚙️  Custom   — Configure every setting manually",  key: "custom"  },
], existingPreset);

const preset = presetChoice.key === "custom" ? null : PRESETS[presetChoice.key!];
const p = (key: string, fallback: any): any => preset?.[key as keyof Preset] ?? e(key, fallback);

console.log(preset
  ? `\n✓ ${preset.label} preset selected. Override individual values below (Enter to keep).\n`
  : `\nCustom mode — configure all settings.\n`
);

// ─── Section 4: Deployment & Reserves ─────────────────────────────────────────
console.log("── Deployment & Reserves ─────────────────────────────────────");

const deployAmountSol = await askNum(
  "SOL to deploy per position",
  e("deployAmountSol", 0.3),
  { min: 0.01, max: 50 }
);

const maxPositions = await askNum(
  "Max concurrent positions",
  e("maxPositions", 3),
  { min: 1, max: 10 }
);

const positionSizePct = await askNum(
  "Position size % of wallet (0.1–1.0)",
  p("positionSizePct", 0.35),
  { min: 0.05, max: 1.0 }
);

const maxDeployAmount = await askNum(
  "Max SOL per deploy",
  p("maxDeployAmount", 50),
  { min: 1, max: 500 }
);

const minSolToOpen = await askNum(
  "Min SOL balance to open a new position",
  e("minSolToOpen", parseFloat((deployAmountSol + 0.05).toFixed(3))),
  { min: 0.05 }
);

const gasReserve = await askNum(
  "Gas reserve in SOL (held back for transaction fees)",
  e("gasReserve", 0.2),
  { min: 0.01, max: 10 }
);

const strategyChoices = [
  { label: "bid_ask — Balanced buy/sell walls (default, most liquid pools)", key: "bid_ask" },
  { label: "spot    — Tight range around current price", key: "spot" },
  { label: "curve   — Multi-bin convex distribution", key: "curve" },
];
const strategyChoice = await askChoice("Strategy:", strategyChoices, e("strategy", "bid_ask"));
const strategy = strategyChoice.key!;

const dryRun = await askBool(
  "Dry run mode? (no real transactions)",
  e("dryRun", true)
);

const minBinsBelow = await askNum(
  "Minimum bins below active bin",
  e("minBinsBelow", 35),
  { min: 35, max: 1400 }
);

const maxBinsBelow = await askNum(
  "Maximum bins below active bin",
  e("maxBinsBelow", e("binsBelow", 69)),
  { min: minBinsBelow, max: 1400 }
);

const defaultBinsBelow = await askNum(
  "Default bins below active bin",
  e("defaultBinsBelow", e("binsBelow", maxBinsBelow)),
  { min: minBinsBelow, max: maxBinsBelow }
);

// ─── Section 5: Risk, TVL & Filters ───────────────────────────────────────────
console.log("\n── Risk, TVL & Filters ───────────────────────────────────────");

const timeframe = await ask(
  "Pool discovery timeframe (30m / 1h / 4h / 12h / 24h)",
  p("timeframe", "4h")
);

const minTvl = await askNum(
  "Min pool TVL USD",
  e("minTvl", 10_000),
  { min: 0 }
);

const maxTvl = await askNum(
  "Max pool TVL USD",
  e("maxTvl", 150_000),
  { min: minTvl }
);

const minOrganic = await askNum(
  "Min organic score (0–100)",
  p("minOrganic", 65),
  { min: 0, max: 100 }
);

const minHolders = await askNum(
  "Min token holders",
  p("minHolders", 500),
  { min: 1 }
);

const maxMcap = await askNum(
  "Max token market cap USD",
  p("maxMcap", 10_000_000),
  { min: 100_000 }
);

const minMcap = await askNum(
  "Min token market cap USD",
  p("minMcap", 150_000),
  { min: 0 }
);

const minVolume = await askNum(
  "Min 24h volume USD",
  p("minVolume", 500),
  { min: 0 }
);

const minQuoteOrganic = await askNum(
  "Min quote token organic score (0–100)",
  p("minQuoteOrganic", 65),
  { min: 0, max: 100 }
);

const minBinStep = await askNum(
  "Min bin step (80 = tight, 125 = wide)",
  p("minBinStep", 80),
  { min: 1, max: 400 }
);

const maxBinStep = await askNum(
  "Max bin step",
  p("maxBinStep", 125),
  { min: minBinStep, max: 400 }
);

const minFeeActiveTvlRatio = await askNum(
  "Min fee/active TVL ratio (0.02 = 2% for 5m window)",
  p("minFeeActiveTvlRatio", 0.05),
  { min: 0 }
);

const minTokenFeesSol = await askNum(
  "Min all-time token fees in SOL (anti-scam)",
  p("minTokenFeesSol", 30),
  { min: 0 }
);

// ─── Section 6: Exit Rules & Trailing TP ──────────────────────────────────────
console.log("\n── Exit Rules & Trailing TP ──────────────────────────────────");

const takeProfitPct = await askNum(
  "Take profit when fees earned >= X% of deployed capital",
  p("takeProfitPct", 5),
  { min: 0.1, max: 100 }
);

const trailingTakeProfit = await askBool(
  "Enable trailing take profit?",
  e("trailingTakeProfit", true)
);

let trailingTriggerPct = 3;
let trailingDropPct = 1.5;
if (trailingTakeProfit) {
  trailingTriggerPct = await askNum(
    "  Trailing trigger % (rise above target before trailing starts)",
    e("trailingTriggerPct", 3),
    { min: 0.1, max: 100 }
  );
  trailingDropPct = await askNum(
    "  Trailing drop % (drop from peak to trigger exit)",
    e("trailingDropPct", 1.5),
    { min: 0.1, max: 100 }
  );
}

const stopLossPct = await askNum(
  "Stop loss at X% price drop (e.g. -15)",
  p("stopLossPct", -15),
  { min: -99, max: -1 }
);

const outOfRangeWaitMinutes = await askNum(
  "Minutes out-of-range before closing",
  p("outOfRangeWaitMinutes", 30),
  { min: 1 }
);

const repeatDeployCooldownEnabled = await askBool(
  "Cooldown token/pool after repeated fee-generating deploys?",
  p("repeatDeployCooldownEnabled", true)
);

const repeatDeployCooldownTriggerCount = await askNum(
  "Repeat deploy cooldown trigger count",
  p("repeatDeployCooldownTriggerCount", 3),
  { min: 1 }
);

const repeatDeployCooldownHours = await askNum(
  "Repeat deploy cooldown hours",
  p("repeatDeployCooldownHours", 12),
  { min: 0 }
);

const repeatDeployCooldownScope = await ask(
  "Repeat deploy cooldown scope (pool/token/both)",
  p("repeatDeployCooldownScope", "token")
);

const repeatDeployCooldownMinFeeEarnedPct = await askNum(
  "Repeat deploy min fee earned %",
  p("repeatDeployCooldownMinFeeEarnedPct", 0),
  { min: 0 }
);

const minAgeBeforeYieldCheck = await askNum(
  "Min age (minutes) before yield check on new positions",
  p("minAgeBeforeYieldCheck", 60),
  { min: 0 }
);

// ─── Section 7: Display Mode & Scheduling ────────────────────────────────────
console.log("\n── Display Mode & Scheduling ─────────────────────────────────");

const solMode = await askBool(
  "SOL display mode? (displays balances/PnL in SOL instead of USD)",
  e("solMode", false)
);

const managementIntervalMin = await askNum(
  "Management cycle interval (minutes)",
  p("managementIntervalMin", 10),
  { min: 1 }
);

const screeningIntervalMin = await askNum(
  "Screening cycle interval (minutes)",
  p("screeningIntervalMin", 30),
  { min: 5 }
);

// ─── Section 8: LLM Provider & Per-Role Models ────────────────────────────────
console.log("\n── LLM Provider & Per-Role Models ────────────────────────────");

interface LLMProvider {
  label: string;
  key: string;
  baseUrl: string;
  keyHint: string;
  modelDefault: string;
}

const LLM_PROVIDERS: LLMProvider[] = [
  {
    label:   "OpenRouter   (openrouter.ai — many models)",
    key:     "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyHint: "sk-or-...",
    modelDefault: "nousresearch/hermes-3-llama-3.1-405b",
  },
  {
    label:   "MiniMax      (api.minimax.io)",
    key:     "minimax",
    baseUrl: "https://api.minimax.io/v1",
    keyHint: "your MiniMax API key",
    modelDefault: "MiniMax-Text-01",
  },
  {
    label:   "OpenAI       (api.openai.com)",
    key:     "openai",
    baseUrl: "https://api.openai.com/v1",
    keyHint: "sk-...",
    modelDefault: "gpt-4o",
  },
  {
    label:   "Local / LM Studio / Ollama (OpenAI-compatible)",
    key:     "local",
    baseUrl: "http://localhost:1234/v1",
    keyHint: "(leave blank or type any value)",
    modelDefault: "local-model",
  },
  {
    label:   "Custom       (any OpenAI-compatible endpoint)",
    key:     "custom",
    baseUrl: "",
    keyHint: "your API key",
    modelDefault: "",
  },
];

const providerChoice = await askChoice("Select LLM provider:", LLM_PROVIDERS.map((p) => ({ label: p.label, key: p.key })));
const provider = LLM_PROVIDERS.find((p) => p.key === providerChoice.key)!;

let llmBaseUrl: string = provider.baseUrl;
if (provider.key === "local" || provider.key === "custom") {
  llmBaseUrl = await ask("Base URL", e("llmBaseUrl", provider.baseUrl || "http://localhost:1234/v1"));
}

const llmApiKeyExisting = e("llmApiKey", existingEnv.LLM_API_KEY || existingEnv.OPENROUTER_API_KEY || "");
const llmApiKeyRaw = await ask("API Key", llmApiKeyExisting ? "*** (already set)" : (provider.keyHint || ""));
const llmApiKey   = llmApiKeyRaw.startsWith("***") ? llmApiKeyExisting : llmApiKeyRaw;

const llmModel = await ask(
  "Default fallback model name",
  e("llmModel", process.env.LLM_MODEL || provider.modelDefault)
);

const getExistingModelStr = (key: string): string => {
  const val = e(key, "");
  if (typeof val === "string") return val;
  if (val && typeof val === "object") {
    if (val.provider && val.model) return `${val.provider}/${val.model}`;
    if (val.model) return val.model;
  }
  return "";
};

const managementModel = await ask(
  "Management cycle model",
  getExistingModelStr("managementModel") || `${provider.key}/${llmModel}`
);

const screeningModel = await ask(
  "Screening cycle model",
  getExistingModelStr("screeningModel") || `${provider.key}/${llmModel}`
);

const generalModel = await ask(
  "General / utility model",
  getExistingModelStr("generalModel") || `${provider.key}/${llmModel}`
);

rl.close();

// ─── Write .env ───────────────────────────────────────────────────────────────
const isKept = (val: string): boolean => !val || val.startsWith("***");

const envMap: Record<string, string> = {
  ...existingEnv,
  ...(isKept(openrouterKey) ? {} : { OPENROUTER_API_KEY: openrouterKey }),
  ...(isKept(walletKey)     ? {} : { WALLET_PRIVATE_KEY: walletKey }),
  ...(rpcUrl                ? { RPC_URL: rpcUrl } : {}),
  ...(isKept(heliusKey)     ? {} : { HELIUS_API_KEY: heliusKey }),
  ...(isKept(telegramToken) ? {} : { TELEGRAM_BOT_TOKEN: telegramToken }),
  ...(telegramChatId        ? { TELEGRAM_CHAT_ID: telegramChatId } : {}),
  DRY_RUN: dryRun ? "true" : "false",
};
fs.writeFileSync(ENV_PATH, buildEnv(envMap));

// ─── Write user-config.json ────────────────────────────────────────────────────
const userConfig: Record<string, any> = {
  ...existingConfig,
  preset: presetChoice.key,
  rpcUrl,
  deployAmountSol,
  maxPositions,
  positionSizePct,
  maxDeployAmount,
  strategy,
  minSolToOpen,
  gasReserve,
  minBinsBelow,
  maxBinsBelow,
  defaultBinsBelow,
  timeframe,
  minTvl,
  maxTvl,
  minMcap,
  minVolume,
  minOrganic,
  minQuoteOrganic,
  minHolders,
  maxMcap,
  minBinStep,
  maxBinStep,
  minFeeActiveTvlRatio,
  minTokenFeesSol,
  takeProfitPct,
  trailingTakeProfit,
  trailingTriggerPct,
  trailingDropPct,
  stopLossPct,
  outOfRangeWaitMinutes,
  repeatDeployCooldownEnabled,
  repeatDeployCooldownTriggerCount,
  repeatDeployCooldownHours,
  repeatDeployCooldownScope,
  repeatDeployCooldownMinFeeEarnedPct,
  minAgeBeforeYieldCheck,
  solMode,
  managementIntervalMin,
  screeningIntervalMin,
  llmProvider: provider.key,
  llmBaseUrl,
  llmModel,
  managementModel,
  screeningModel,
  generalModel,
  ...(llmApiKey ? { llmApiKey } : {}),
  telegramChatId: telegramChatId || "",
  dryRun,
};

// Remove deprecated keys
delete userConfig.takeProfitFeePct;
delete userConfig.maxBundlePct;
delete userConfig.athFilterPct;
delete userConfig.emergencyPriceDropPct;

fs.writeFileSync(CONFIG_PATH, JSON.stringify(userConfig, null, 2));

// ─── Summary ──────────────────────────────────────────────────────────────────
const presetName = preset ? `${preset.label}` : "Custom";

console.log(`
╔═══════════════════════════════════════════════╗
║           Setup Complete                      ║
╚═══════════════════════════════════════════════╝

  Preset:       ${presetName}
  Dry run:      ${dryRun ? "YES — no real transactions" : "NO — live trading"}

  Deploy:       ${deployAmountSol} SOL/position  ·  max ${maxPositions} positions
  Gas reserve:  ${gasReserve} SOL
  Min balance:  ${minSolToOpen} SOL to open new position
  Timeframe:    ${timeframe}  ·  organic ≥ ${minOrganic}  ·  holders ≥ ${minHolders}
  TVL range:    $${minTvl.toLocaleString()} - $${maxTvl.toLocaleString()}
  Take profit:  fees ≥ ${takeProfitPct}% ${trailingTakeProfit ? `(trailing trigger: ${trailingTriggerPct}%, drop: ${trailingDropPct}%)` : "(flat)"}
  Stop loss:    ${stopLossPct}% price drop
  OOR close:    after ${outOfRangeWaitMinutes} min
  Repeat CD:    ${repeatDeployCooldownEnabled ? `${repeatDeployCooldownTriggerCount}x / ${repeatDeployCooldownHours}h / ${repeatDeployCooldownScope}` : "disabled"}
  SOL mode:     ${solMode ? "enabled" : "disabled"}

  Cycles:       management every ${managementIntervalMin}m  ·  screening every ${screeningIntervalMin}m
  Provider:     ${provider.label.split("(")[0].trim()}
  Default Model:${llmModel}
  Mgmt Model:   ${managementModel}
  Screen Model: ${screeningModel}
  Gen Model:    ${generalModel}
  Base URL:     ${llmBaseUrl}

  Telegram:     ${telegramToken ? "enabled" : "disabled"}
  .env:         ${ENV_PATH}
  Config:       ${CONFIG_PATH}

Run "npm start" to launch the agent.
${dryRun ? '\n  ⚠ DRY RUN is ON — set dryRun: false in user-config.json when ready for live trading.\n' : ""}
`);
