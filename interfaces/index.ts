/**
 * interfaces/index.ts — Outbound Gate
 *
 * The ONLY file imported from outside interfaces/ for sending messages.
 * All outbound notifications go through here — ensures consistent format
 * and routes to the correct active platform(s).
 */

import * as telegram from "./telegram/index.js";

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

// --- Notification functions (delegate to telegram) ---

export async function notifyDeploy(...args: Parameters<typeof telegram.notifyDeploy>): Promise<void> {
  return telegram.notifyDeploy(...args);
}

export async function notifyClose(...args: Parameters<typeof telegram.notifyClose>): Promise<void> {
  return telegram.notifyClose(...args);
}

export async function notifySwap(...args: Parameters<typeof telegram.notifySwap>): Promise<void> {
  return telegram.notifySwap(...args);
}

export async function notifyOutOfRange(...args: Parameters<typeof telegram.notifyOutOfRange>): Promise<void> {
  return telegram.notifyOutOfRange(...args);
}

// --- Messaging primitives (delegate to telegram) ---

export async function sendMessage(...args: Parameters<typeof telegram.sendMessage>): Promise<void> {
  return telegram.sendMessage(...args);
}

export async function sendHTML(...args: Parameters<typeof telegram.sendHTML>): Promise<void> {
  return telegram.sendHTML(...args);
}

export async function sendLongMessage(...args: Parameters<typeof telegram.sendLongMessage>): Promise<void> {
  return telegram.sendLongMessage(...args);
}

export function isEnabled(): boolean {
  return telegram.isEnabled();
}

// --- Re-export additional telegram functions used by consumers ---

export {
  sendMessageWithButtons,
  sendDocument,
  editMessage,
  editMessageWithButtons,
  answerCallbackQuery,
  hasActiveLiveMessage,
  createLiveMessage,
  startPolling,
  stopPolling,
} from "./telegram/index.js";
