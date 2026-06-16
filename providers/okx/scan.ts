// providers/okx/scan.ts
//
// OKX provider wrapper for `onchainos security token-scan`.
// Calls the onchainos binary as a child process, parses the JSON response,
// and returns a structured SafetyVerdict per mint.
//
// Note: the binary and skill directory are named "onchainos" (OKX's CLI
// product name), but this wrapper lives under `providers/okx/` to follow
// the vendor-aligned naming convention used by other providers
// (jupiter, gmgn, helius, meteora, hivemind, lpagent, solana).
//
// Schema (verified via live API):
//   {
//     "ok": true,
//     "data": [
//       {
//         "chainId": "501",
//         "tokenAddress": "...",          // base58, no "solana:" prefix
//         "isChainSupported": true,
//         "riskLevel": "CRITICAL"|"HIGH"|"MEDIUM"|"LOW",
//         "buyTaxes": "0.0"|null,         // string|null
//         "sellTaxes": "0.0"|null,
//         "isHoneypot": bool, "isAirdropScam": bool, "isRubbishAirdrop": bool,
//         "isHasAssetEditAuth": bool, "isLowLiquidity": bool, "isDumping": bool,
//         "isLiquidityRemoval": bool, "isPump": bool, "isWash": bool,
//         "isFakeLiquidity": bool, "isWash2": bool, "isFundLinkage": bool,
//         "isVeryLowLpBurn": bool, "isVeryHighLpHolderProp": bool,
//         "isHasBlockingHis": bool, "isOverIssued": bool, "isCounterfeit": bool,
//         "isNotOpenSource": bool, "isMintable": bool, "isHasFrozenAuth": bool,
//         "isNotRenounced": bool
//       }
//     ]
//   }
//
// Failure modes:
//   - Process error (binary missing, network, timeout) → SCAN_FAILED for all mints
//   - ok:false (API error) → SCAN_FAILED for all mints, reason = error string
//   - Missing mint in response (e.g. native token skipped) → SCAN_FAILED for that mint

import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";
import { log } from "../../utils/logger.js";

const execFileAsync = promisify(execFile);

// ─── Types ──────────────────────────────────────────────────────

export type RiskLevel = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "SCAN_FAILED";

export interface SafetyVerdict {
  mint: string;
  riskLevel: RiskLevel;
  /** Compact human-readable reason — short enough to inject into the LLM prompt. */
  summary: string;
  /** Buy tax as percent (null = unknown). */
  buyTaxes: number | null;
  /** Sell tax as percent (null = unknown). */
  sellTaxes: number | null;
  /** Critical-level flags that triggered the verdict. Empty if LOW. */
  triggeredLabels: string[];
  /** Full raw response, for debugging. Omitted in serialized form. */
  raw?: unknown;
}

interface OnchainosTokenResult {
  chainId?: string;
  tokenAddress?: string;
  isChainSupported?: boolean;
  riskLevel?: string;
  buyTaxes?: string | null;
  sellTaxes?: string | null;
  isHoneypot?: boolean;
  isAirdropScam?: boolean;
  isRubbishAirdrop?: boolean;
  isHasAssetEditAuth?: boolean;
  isLowLiquidity?: boolean;
  isDumping?: boolean;
  isLiquidityRemoval?: boolean;
  isPump?: boolean;
  isWash?: boolean;
  isFakeLiquidity?: boolean;
  isWash2?: boolean;
  isFundLinkage?: boolean;
  isVeryLowLpBurn?: boolean;
  isVeryHighLpHolderProp?: boolean;
  isHasBlockingHis?: boolean;
  isOverIssued?: boolean;
  isCounterfeit?: boolean;
  isNotOpenSource?: boolean;
  isMintable?: boolean;
  isHasFrozenAuth?: boolean;
  isNotRenounced?: boolean;
}

interface OnchainosResponse {
  ok: boolean;
  data?: OnchainosTokenResult[];
  error?: string;
}

// ─── Constants ──────────────────────────────────────────────────

const MAX_MINTS_PER_BATCH = 50;  // CLI limit per docs
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 10 * 1024 * 1024;

// Env vars passed to the subprocess (subset of executor.ts SKILL_ENV_ALLOWLIST
// plus OKX creds).
const SAFE_BASE_VARS = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL",
  "TMPDIR", "TEMP", "TMP",
  "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "NODE_ENV", "DRY_RUN", "LANG", "LC_ALL",
]);
const REQUIRED_CREDS = ["OKX_API_KEY", "OKX_SECRET_KEY", "OKX_PASSPHRASE"];

// Critical labels — these alone make the token undeployable.
// Source: OKX risk-token-detection.md, Level 4
const CRITICAL_LABELS: ReadonlyArray<{ key: keyof OnchainosTokenResult; name: string }> = [
  { key: "isHoneypot",      name: "honeypot" },
  { key: "isRubbishAirdrop", name: "garbage_airdrop" },
  { key: "isAirdropScam",   name: "gas_mint_scam" },
];

// High labels — strong negatives, can be combined with other signals.
// Source: OKX risk-token-detection.md, Level 3
const HIGH_LABELS: ReadonlyArray<{ key: keyof OnchainosTokenResult; name: string }> = [
  { key: "isHasAssetEditAuth",    name: "privileged_address" },
  { key: "isLowLiquidity",        name: "low_liquidity" },
  { key: "isDumping",             name: "dumping" },
  { key: "isLiquidityRemoval",    name: "liquidity_removal" },
  { key: "isPump",                name: "pump" },
  { key: "isWash",                name: "wash_trading" },
  { key: "isFakeLiquidity",       name: "fake_liquidity" },
  { key: "isWash2",               name: "wash_trading_v2" },
  { key: "isFundLinkage",         name: "rugpull_linkage" },
  { key: "isVeryLowLpBurn",       name: "very_low_lp_burn" },
  { key: "isVeryHighLpHolderProp", name: "high_lp_concentration" },
  { key: "isHasBlockingHis",      name: "blocking_history" },
  { key: "isOverIssued",          name: "over_issued" },
  { key: "isCounterfeit",         name: "counterfeit" },
  { key: "isNotOpenSource",       name: "not_open_source" },
];

// Medium labels — informational.
// Source: OKX risk-token-detection.md, Level 2
const MEDIUM_LABELS: ReadonlyArray<{ key: keyof OnchainosTokenResult; name: string }> = [
  { key: "isMintable",        name: "mintable" },
  { key: "isHasFrozenAuth",   name: "freeze_authority" },
  { key: "isNotRenounced",    name: "ownership_not_renounced" },
];

// ─── Public API ──────────────────────────────────────────────────

// Allow tests to override the binary path.
let _binaryOverride: string | null = null;

/**
 * Override the onchainos binary path (for tests).
 * Pass null to clear.
 */
export function setBinaryPath(p: string | null): void {
  _binaryOverride = p;
}

/**
 * Resolve the absolute path to the onchainos binary.
 * Checks the standard install path at `~/.local/bin/onchainos`.
 * Tests can override via `setBinaryPath()`.
 */
export function resolveBinaryPath(): string {
  if (_binaryOverride) return _binaryOverride;
  const globalPath = path.join(process.env.HOME || "~", ".local", "bin", "onchainos");
  try {
    const stat = fs.statSync(globalPath);
    if (stat.isFile() && (stat.mode & 0o111) !== 0) return globalPath;
  } catch {
    // not found
  }
  return globalPath; // best guess — caller will get ENOENT
}

/**
 * Check whether the onchainos binary is installed and executable.
 */
export function isBinaryAvailable(): boolean {
  const p = resolveBinaryPath();
  try {
    const stat = fs.statSync(p);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Check whether OKX credentials are configured.
 */
export function hasCredentials(): boolean {
  return REQUIRED_CREDS.every((k) => {
    const v = process.env[k];
    return v != null && v.trim() !== "";
  });
}

/**
 * Scan a list of mints for security risk.
 * Returns one SafetyVerdict per requested mint. Batches in groups of 50.
 *
 * @param mints Array of base58 mint addresses (no "solana:" prefix).
 * @param opts.timeoutMs Per-call timeout (default 30000).
 * @param opts.useMock If true, return fake response without calling binary.
 */
export async function scanTokens(
  mints: string[],
  opts: { timeoutMs?: number; useMock?: boolean } = {},
): Promise<SafetyVerdict[]> {
  if (mints.length === 0) return [];

  // Mock mode: for tests only. Activates via MOCK_ONCHAINOS=1 or opts.useMock.
  // Missing credentials is NOT a reason to mock — the binary call will fail
  // and return SCAN_FAILED, which is the correct fail-closed behavior.
  const useMock = opts.useMock ?? process.env.MOCK_ONCHAINOS === "1";
  if (useMock) {
    log("safety_mock", `onchainos mock mode (mints=${mints.length})`);
    return mints.map((m, i) => mockVerdictFor(m, i));
  }

  // Batch in groups of MAX_MINTS_PER_BATCH
  const results: SafetyVerdict[] = [];
  for (let i = 0; i < mints.length; i += MAX_MINTS_PER_BATCH) {
    const batch = mints.slice(i, i + MAX_MINTS_PER_BATCH);
    const batchResults = await scanOneBatch(batch, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    results.push(...batchResults);
  }
  return results;
}

// ─── Internals ──────────────────────────────────────────────────

async function scanOneBatch(mints: string[], timeoutMs: number): Promise<SafetyVerdict[]> {
  const binary = resolveBinaryPath();
  const args = [
    "security", "token-scan",
    "--chain", "solana",
    "--tokens", mints.map((m) => `solana:${m}`).join(","),
  ];

  let stdout = "";
  let stderr = "";
  try {
    const result = await execFileAsync(binary, args, {
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER,
      env: buildOnchainosEnv(),
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (err: any) {
    // Subprocess failed — return SCAN_FAILED for every mint.
    const reason = err.code === "ENOENT"
      ? `onchainos binary not found at ${binary}`
      : err.killed
        ? `onchainos timeout after ${timeoutMs}ms`
        : err.message || "onchainos subprocess error";
    log("safety_error", `onchainos exec failed: ${reason} (stderr: ${err.stderr || ""})`);
    return mints.map((m) => failureVerdict(m, reason));
  }

  let parsed: OnchainosResponse;
  try {
    parsed = JSON.parse(stdout);
  } catch (err: any) {
    log("safety_error", `onchainos returned invalid JSON: ${err.message} (stdout: ${stdout.slice(0, 500)})`);
    return mints.map((m) => failureVerdict(m, `invalid JSON response: ${stderr || err.message}`));
  }

  if (!parsed.ok) {
    const reason = parsed.error || "onchainos API returned ok:false";
    log("safety_error", `onchainos API error: ${reason}`);
    return mints.map((m) => failureVerdict(m, reason));
  }

  const data = Array.isArray(parsed.data) ? parsed.data : [];
  // Index by tokenAddress (base58, no prefix)
  const byAddress = new Map<string, OnchainosTokenResult>();
  for (const r of data) {
    if (r.tokenAddress) byAddress.set(r.tokenAddress, r);
  }

  return mints.map((mint) => {
    const r = byAddress.get(mint);
    if (!r) {
      return failureVerdict(mint, "mint missing from response (likely skipped: native or unsupported)");
    }
    return verdictFromResponse(mint, r);
  });
}

function buildOnchainosEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of SAFE_BASE_VARS) {
    if (process.env[k] != null) env[k] = process.env[k];
  }
  for (const k of REQUIRED_CREDS) {
    const v = process.env[k];
    if (v != null && v.trim() !== "") env[k] = v;
  }
  return env;
}

function verdictFromResponse(mint: string, r: OnchainosTokenResult): SafetyVerdict {
  const riskLevel = normalizeRiskLevel(r.riskLevel);
  const labels = collectTriggeredLabels(r);
  return {
    mint,
    riskLevel,
    summary: buildSummary(r, riskLevel, labels),
    buyTaxes: parseTax(r.buyTaxes),
    sellTaxes: parseTax(r.sellTaxes),
    triggeredLabels: labels,
    raw: r,
  };
}

function normalizeRiskLevel(raw: string | undefined): RiskLevel {
  switch (raw) {
    case "CRITICAL":
    case "HIGH":
    case "MEDIUM":
    case "LOW":
      return raw;
    default:
      // Per upstream docs: missing/null/unrecognized → treat as HIGH.
      return "HIGH";
  }
}

function collectTriggeredLabels(r: OnchainosTokenResult): string[] {
  const out: string[] = [];
  for (const { key, name } of CRITICAL_LABELS) if (r[key] === true) out.push(name);
  for (const { key, name } of HIGH_LABELS) if (r[key] === true) out.push(name);
  for (const { key, name } of MEDIUM_LABELS) if (r[key] === true) out.push(name);
  return out;
}

function buildSummary(r: OnchainosTokenResult, level: RiskLevel, labels: string[]): string {
  if (level === "LOW") return "no risk labels triggered";
  if (labels.length === 0) return `${level}: flagged by composite analysis, no specific label`;
  // Compact: first 3 labels + count
  const shown = labels.slice(0, 3).join(", ");
  const more = labels.length > 3 ? `, +${labels.length - 3} more` : "";
  return `${level}: ${shown}${more}`;
}

function parseTax(v: string | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function failureVerdict(mint: string, reason: string): SafetyVerdict {
  return {
    mint,
    riskLevel: "SCAN_FAILED",
    summary: `scan failed: ${reason}`,
    buyTaxes: null,
    sellTaxes: null,
    triggeredLabels: [],
  };
}

// Deterministic mock verdict for tests (MOCK_ONCHAINOS=1 or opts.useMock).
// Cycles through risk levels so a batch of test mints gets variety.
function mockVerdictFor(mint: string, index: number): SafetyVerdict {
  const levels: RiskLevel[] = ["LOW", "LOW", "LOW", "MEDIUM", "HIGH", "CRITICAL"];
  const level = levels[index % levels.length];
  return {
    mint,
    riskLevel: level,
    summary: level === "LOW" ? "no risk labels triggered (mock)" : `${level} (mock)`,
    buyTaxes: null,
    sellTaxes: null,
    triggeredLabels: level === "LOW" ? [] : [level.toLowerCase() + "_mock"],
  };
}
