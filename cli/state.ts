// cli/state.ts — Shared runtime state for CLI, Telegram, and index.ts
// This module exists to break the circular dependency between
// index.ts ↔ handlers.ts. Both import state from here.

import readline from "readline";

// ── Telegram message type ───────────────────────────────────────
export interface TelegramMessage {
  text?: string;
  isCallback?: boolean;
  callbackQueryId?: string;
  callbackData?: string;
  messageId?: number;
  message_id?: number;
  from?: { id?: number };
  chat?: { id?: number };
}

// ── Concurrency guard ──────────────────────────────────────────
export let busy: boolean = false;
export function setBusy(v: boolean): void { busy = v; }

// ── Telegram message queue (with timestamp for TTL) ────────────
export interface QueuedMessage {
  msg: TelegramMessage;
  queuedAt: number;
}
export const _telegramQueue: QueuedMessage[] = [];
const QUEUE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ── Session history (shared between CLI and Telegram) ───────────
export const sessionHistory: any[] = [];
const MAX_HISTORY = 100;

export function appendHistory(userMsg: string, assistantMsg: string): void {
  sessionHistory.push({ role: "user", content: userMsg });
  sessionHistory.push({ role: "assistant", content: assistantMsg });
  if (sessionHistory.length > MAX_HISTORY) {
    sessionHistory.splice(0, sessionHistory.length - MAX_HISTORY);
  }
}

// ── CLI prompt refresh (set by index.ts) ────────────────────────
let _ttyInterface: readline.Interface | null = null;
let _buildPrompt: (() => string) | null = null;

export function setTtyInterface(rl: readline.Interface | null, buildPrompt?: () => string): void {
  _ttyInterface = rl;
  _buildPrompt = buildPrompt ?? null;
}

export function refreshPrompt(): void {
  if (!_ttyInterface || !_buildPrompt) return;
  _ttyInterface.setPrompt(_buildPrompt());
  _ttyInterface.prompt(true);
}
