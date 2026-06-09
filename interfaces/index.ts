/**
 * interfaces/index.ts — Outbound Gate
 *
 * The ONLY file imported from outside interfaces/ for sending messages.
 * All outbound notifications go through here — ensures consistent format
 * and routes to the correct active platform(s).
 *
 * During migration, platform imports will be wired incrementally as files move into interfaces/.
 */

// --- Platform imports (wire as platforms migrate) ---
// import * as telegram from "./telegram/index.js";

// --- Types ---

export interface DeployNotification {
  pair: string;
  amountSol: number;
  position: string;
  tx: string;
  priceRange: string;
  rangeCoverage: string;
  binStep: number;
  baseFee: number | null;
}

export interface CloseNotification {
  pair: string;
  pnlUsd: number;
  pnlPct: number;
}

export interface SwapNotification {
  inputSymbol: string;
  outputSymbol: string;
  amountIn: number;
  amountOut: number;
  tx: string;
}

export interface OutOfRangeNotification {
  pair: string;
  minutesOOR: number;
}

// --- Notification functions ---

export async function notifyDeploy(data: DeployNotification): Promise<void> {
  // TODO: wire when telegram migrates
  // if (telegram.isEnabled()) await telegram.notifyDeployTelegram(data);
  console.log(`[interfaces] Deploy: ${data.pair}`);
}

export async function notifyClose(data: CloseNotification): Promise<void> {
  // TODO: wire when telegram migrates
  console.log(`[interfaces] Close: ${data.pair}`);
}

export async function notifySwap(data: SwapNotification): Promise<void> {
  // TODO: wire when telegram migrates
  console.log(`[interfaces] Swap: ${data.inputSymbol} → ${data.outputSymbol}`);
}

export async function notifyOutOfRange(data: OutOfRangeNotification): Promise<void> {
  // TODO: wire when telegram migrates
  console.log(`[interfaces] OOR: ${data.pair}`);
}

// --- Messaging primitives ---

export async function sendMessage(text: string): Promise<void> {
  // TODO: wire when telegram migrates
  console.log(`[interfaces] ${text}`);
}

export async function sendHTML(html: string): Promise<void> {
  // TODO: wire when telegram migrates
  console.log(`[interfaces] ${html}`);
}

export async function sendLongMessage(text: string): Promise<void> {
  // TODO: wire when telegram migrates
  console.log(`[interfaces] ${text}`);
}

export async function isEnabled(): Promise<boolean> {
  // TODO: wire when telegram migrates
  return false;
}
