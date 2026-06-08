import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./utils/logger.js";

const USER_CONFIG_PATH = path.join(process.cwd(), "user-config.json");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const BASE = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;
const ALLOWED_USER_IDS = new Set(
  String(process.env.TELEGRAM_ALLOWED_USER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
);

let chatId: string | null = process.env.TELEGRAM_CHAT_ID || null;
let _offset = 0;
let _polling = false;
let _liveMessageDepth = 0;
let _warnedMissingChatId = false;
let _warnedMissingAllowedUsers = false;

function loadChatId(): void {
  try {
    if (fs.existsSync(USER_CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      if (cfg.telegramChatId) chatId = cfg.telegramChatId;
    }
  } catch (error: any) {
    log("telegram_warn", `Invalid user-config.json; chatId not loaded: ${error.message}`);
  }
}

function saveChatId(id: string): void {
  try {
    let cfg = fs.existsSync(USER_CONFIG_PATH)
      ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
      : {};
    cfg.telegramChatId = id;
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch (e: any) {
    log("telegram_error", `Failed to persist chatId: ${e.message}`);
  }
}

loadChatId();

interface TelegramMessage {
  chat?: { id?: number; type?: string };
  from?: { id?: number };
  text?: string;
  message_id?: number;
}

function isAuthorizedIncomingMessage(msg: TelegramMessage): boolean {
  const incomingChatId = String(msg.chat?.id || "");
  const senderUserId = msg.from?.id != null ? String(msg.from.id) : null;
  const chatType = msg.chat?.type || "unknown";

  if (!chatId) {
    if (!_warnedMissingChatId) {
      log("telegram_warn", "Ignoring inbound Telegram messages because TELEGRAM_CHAT_ID / user-config.telegramChatId is not configured. Auto-registration is disabled for safety.");
      _warnedMissingChatId = true;
    }
    return false;
  }

  if (incomingChatId !== chatId) return false;

  if (chatType !== "private" && ALLOWED_USER_IDS.size === 0) {
    if (!_warnedMissingAllowedUsers) {
      log("telegram_warn", "Ignoring group Telegram messages because TELEGRAM_ALLOWED_USER_IDS is not configured. Set explicit allowed user IDs for command/control.");
      _warnedMissingAllowedUsers = true;
    }
    return false;
  }

  if (ALLOWED_USER_IDS.size > 0) {
    if (!senderUserId || !ALLOWED_USER_IDS.has(senderUserId)) return false;
  }

  return true;
}

// ─── Core send ───────────────────────────────────────────────────
export function isEnabled(): boolean {
  return !!TOKEN;
}

async function postTelegram(method: string, body: Record<string, unknown>): Promise<any> {
  if (!TOKEN || !chatId) return null;
  try {
    const res = await fetch(`${BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, ...body }),
    });
    if (!res.ok) {
      const err = await res.text();
      log("telegram_error", `${method} ${res.status}: ${err.slice(0, 200)}`);
      return null;
    }
    return await res.json();
  } catch (e: any) {
    log("telegram_error", `${method} failed: ${e.message}`);
    return null;
  }
}

async function postTelegramRaw(method: string, body: Record<string, unknown>): Promise<any> {
  if (!TOKEN) return null;
  try {
    const res = await fetch(`${BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      log("telegram_error", `${method} ${res.status}: ${err.slice(0, 200)}`);
      return null;
    }
    return await res.json();
  } catch (e: any) {
    log("telegram_error", `${method} failed: ${e.message}`);
    return null;
  }
}

export async function sendMessage(text: string): Promise<any> {
  if (!TOKEN || !chatId) return;
  return postTelegram("sendMessage", { text: String(text).slice(0, 4096) });
}

export async function sendMessageWithButtons(text: string, inlineKeyboard: unknown[][]): Promise<any> {
  if (!TOKEN || !chatId) return;
  return postTelegram("sendMessage", {
    text: String(text).slice(0, 4096),
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
}

export async function sendHTML(html: string): Promise<any> {
  if (!TOKEN || !chatId) return;
  return postTelegram("sendMessage", { text: html.slice(0, 4096), parse_mode: "HTML" });
}

export async function sendDocument(filePath: string, { caption }: { caption?: string } = {}): Promise<any> {
  if (!TOKEN || !chatId) return null;
  try {
    const formData = new FormData();
    formData.append("chat_id", chatId);
    formData.append("document", new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
    if (caption) formData.append("caption", String(caption).slice(0, 1024));
    const res = await fetch(`${BASE}/sendDocument`, { method: "POST", body: formData });
    if (!res.ok) {
      const err = await res.text();
      log("telegram_error", `sendDocument ${res.status}: ${err.slice(0, 200)}`);
      return null;
    }
    return await res.json();
  } catch (e: any) {
    log("telegram_error", `sendDocument failed: ${e.message}`);
    return null;
  }
}

function formatMarkdownToTelegramHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/\*([^*\n]+?)\*/g, "<i>$1</i>")
    .replace(/`([^`\n]+?)`/g, "<code>$1</code>");
}

export async function sendLongMessage(text: string, { parse_mode }: { parse_mode?: string } = {}): Promise<void> {
  if (!TOKEN || !chatId) return;
  let content = String(text);
  const hasMarkdown = /\*\*.*\*\*|\*[^*\n]+\*|`[^`\n]+`/.test(content);
  const useHtml = (!parse_mode && hasMarkdown) || (parse_mode === "HTML" && hasMarkdown);
  if (useHtml) {
    content = formatMarkdownToTelegramHtml(content);
  }
  const effectiveMode = parse_mode === "HTML" ? "HTML" : (useHtml ? "HTML" : undefined);
  const maxLen = 4096;
  let remaining = content;
  let isFirst = true;

  while (remaining.length > 0) {
    const chunk = remaining.length <= maxLen
      ? remaining
      : splitAtBoundary(remaining, maxLen);

    const payload: Record<string, unknown> = { text: isFirst ? chunk : "🔍 Continued...\n\n" + chunk };
    if (effectiveMode) payload.parse_mode = effectiveMode;
    await postTelegram("sendMessage", payload);

    if (remaining.length <= maxLen) return;
    remaining = remaining.slice(chunk.length).trimStart();
    isFirst = false;
  }
}

function splitAtBoundary(text: string, maxLen: number): string {
  let at = text.lastIndexOf("\n\n", maxLen);
  if (at < maxLen / 2) at = text.lastIndexOf("\n", maxLen);
  if (at < maxLen / 2) at = maxLen;
  if (at > 0 && at < text.length) {
    const code = text.charCodeAt(at - 1);
    if (code >= 0xD800 && code <= 0xDBFF) at--;
  }
  return text.slice(0, at);
}

export async function editMessage(text: string, messageId: number): Promise<any> {
  if (!TOKEN || !chatId || !messageId) return null;
  return postTelegram("editMessageText", {
    message_id: messageId,
    text: String(text).slice(0, 4096),
  });
}

export async function editMessageWithButtons(text: string, messageId: number, inlineKeyboard: unknown[][]): Promise<any> {
  if (!TOKEN || !chatId || !messageId) return null;
  return postTelegram("editMessageText", {
    message_id: messageId,
    text: String(text).slice(0, 4096),
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
}

export async function answerCallbackQuery(callbackQueryId: string, text = ""): Promise<any> {
  if (!TOKEN || !callbackQueryId) return null;
  return postTelegramRaw("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text: String(text).slice(0, 200) } : {}),
  });
}

export function hasActiveLiveMessage(): boolean {
  return _liveMessageDepth > 0;
}

function createTypingIndicator(): { stop: () => void } {
  if (!TOKEN || !chatId) {
    return { stop() {} };
  }

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function tick(): Promise<void> {
    if (stopped) return;
    await postTelegram("sendChatAction", { action: "typing" });
    timer = setTimeout(() => {
      tick().catch(() => null);
    }, 4000);
  }

  tick().catch(() => null);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

function toolLabel(name: string): string {
  const labels: Record<string, string> = {
    get_token_info: "get token info",
    get_token_narrative: "get token narrative",
    get_token_holders: "get token holders",
    get_top_candidates: "get top candidates",
    get_pool_detail: "get pool detail",
    get_active_bin: "get active bin",
    deploy_position: "deploy position",
    close_position: "close position",
    claim_fees: "claim fees",
    swap_token: "swap token",
    update_config: "update config",
    get_my_positions: "get positions",
    get_wallet_balance: "get wallet balance",
    check_smart_wallets_on_pool: "check smart wallets",
    study_top_lpers: "study top LPers",
    get_top_lpers: "get top LPers",
    search_pools: "search pools",
    discover_pools: "discover pools",
  };
  return labels[name] || name.replace(/_/g, " ");
}

function summarizeToolResult(name: string, result: Record<string, unknown>): string {
  if (!result) return "";
  if (result.error) return String(result.error);
  if (result.reason && result.blocked) return String(result.reason);
  switch (name) {
    case "deploy_position":
      return result.position ? `position ${String(result.position).slice(0, 8)}...` : "submitted";
    case "close_position":
      return result.success ? "closed" : (String(result.reason) || "failed");
    case "claim_fees":
      return result.claimed_amount != null ? `claimed ${result.claimed_amount}` : "done";
    case "update_config":
      return Object.keys((result.applied as Record<string, unknown>) || {}).join(", ") || "updated";
    case "get_top_candidates":
      return `${(result.candidates as unknown[])?.length ?? 0} candidates`;
    case "get_my_positions":
      return `${result.total_positions ?? (result.positions as unknown[])?.length ?? 0} positions`;
    case "get_wallet_balance":
      return `${result.sol ?? "?"} SOL`;
    case "study_top_lpers":
    case "get_top_lpers":
      return `${(result.lpers as unknown[])?.length ?? 0} LPers`;
    default:
      return result.success === false ? "failed" : "done";
  }
}

interface LiveMessage {
  toolStart: (name: string) => Promise<void>;
  toolFinish: (name: string, result: Record<string, unknown>, success: boolean) => Promise<void>;
  note: (text: string) => Promise<void>;
  finalize: (finalText: string) => Promise<void>;
  fail: (errorText: string) => Promise<void>;
}

export async function createLiveMessage(title: string, intro = "Starting..."): Promise<LiveMessage | null> {
  if (!TOKEN || !chatId) return null;
  const typing = createTypingIndicator();

  let _lastParseMode: string | null = null;

  const state: {
    title: string;
    intro: string;
    toolLines: string[];
    footer: string;
    messageId: number | null;
    flushTimer: ReturnType<typeof setTimeout> | null;
    flushPromise: Promise<void> | null;
    flushRequested: boolean;
  } = {
    title,
    intro,
    toolLines: [],
    footer: "",
    messageId: null,
    flushTimer: null,
    flushPromise: null,
    flushRequested: false,
  };

  function render(): string {
    const sections = [state.title];
    if (state.intro) sections.push(state.intro);
    if (state.toolLines.length > 0) sections.push(state.toolLines.join("\n"));
    if (state.footer) sections.push(state.footer);
    const text = sections.join("\n\n").slice(0, 4096);
    const hasHtml = /<\/?[a-z][^>]*>|\*\*|\*[^*\n]+\*|`[^`\n]+`/.test(text);
    _lastParseMode = hasHtml ? "HTML" : null;
    return hasHtml ? formatMarkdownToTelegramHtml(text) : text;
  }

  async function flushNow(): Promise<void> {
    state.flushTimer = null;
    state.flushRequested = false;
    const text = render();
    const params: Record<string, unknown> = { text };
    if (_lastParseMode) params.parse_mode = _lastParseMode;
    if (!state.messageId) {
      const sent = await postTelegram("sendMessage", params);
      state.messageId = sent?.result?.message_id ?? null;
      return;
    }
    await postTelegram("editMessageText", { message_id: state.messageId, ...params });
  }

  function scheduleFlush(delay = 300): void {
    if (state.flushTimer) {
      state.flushRequested = true;
      return;
    }
    state.flushTimer = setTimeout(() => {
      state.flushPromise = flushNow().catch(() => {});
    }, delay);
  }

  async function upsertToolLine(name: string, icon: string, suffix = ""): Promise<void> {
    const label = toolLabel(name);
    const line = `${icon} ${label}${suffix ? ` ${suffix}` : ""}`;
    const idx = state.toolLines.findIndex((entry) => entry.includes(` ${label}`));
    if (idx >= 0) state.toolLines[idx] = line;
    else state.toolLines.push(line);
    scheduleFlush();
  }

  _liveMessageDepth += 1;
  await flushNow();

  return {
    async toolStart(name: string) {
      await upsertToolLine(name, "ℹ️", "...");
    },
    async toolFinish(name: string, result: Record<string, unknown>, success: boolean) {
      const icon = success ? "✅" : "❌";
      const summary = summarizeToolResult(name, result);
      await upsertToolLine(name, icon, summary ? `— ${summary}` : "");
    },
    async note(text: string) {
      state.intro = text;
      scheduleFlush();
    },
    async finalize(finalText: string) {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
      if (state.flushPromise) await state.flushPromise;
      state.footer = finalText;
      await flushNow();
      _liveMessageDepth = Math.max(0, _liveMessageDepth - 1);
      typing.stop();
    },
    async fail(errorText: string) {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
      if (state.flushPromise) await state.flushPromise;
      state.footer = `❌ ${errorText}`;
      await flushNow();
      _liveMessageDepth = Math.max(0, _liveMessageDepth - 1);
      typing.stop();
    },
  };
}

// ─── Long polling ────────────────────────────────────────────────
async function poll(onMessage: (msg: any) => Promise<void>): Promise<void> {
  while (_polling) {
    try {
      const res = await fetch(
        `${BASE}/getUpdates?offset=${_offset}&timeout=30`,
        { signal: AbortSignal.timeout(35_000) },
      );
      if (!res.ok) { await sleep(5000); continue; }
      const data = await res.json();
      for (const update of data.result || []) {
        _offset = update.update_id + 1;
        const callback = update.callback_query;
        if (callback?.data && callback?.message) {
          const callbackMsg = {
            chat: callback.message.chat,
            from: callback.from,
            text: callback.data,
          };
          if (!isAuthorizedIncomingMessage(callbackMsg)) continue;
          await onMessage({
            ...callbackMsg,
            isCallback: true,
            callbackQueryId: callback.id,
            callbackData: callback.data,
            messageId: callback.message.message_id,
          });
          continue;
        }
        const msg = update.message;
        if (!msg?.text) continue;
        if (!isAuthorizedIncomingMessage(msg)) continue;
        await onMessage(msg);
      }
    } catch (e: any) {
      if (!e.message?.includes("aborted")) {
        log("telegram_error", `Poll error: ${e.message}`);
      }
      await sleep(5000);
    }
  }
}

const BOT_COMMANDS = [
  { command: "help",       description: "Show commands" },
  { command: "status",     description: "Wallet + positions snapshot" },
  { command: "wallet",     description: "Wallet, deploy amount, HiveMind status" },
  { command: "positions",  description: "List open positions" },
  { command: "pool",       description: "Detailed info for one open position" },
  { command: "close",      description: "Close one position by index" },
  { command: "closeall",   description: "Close all open positions" },
  { command: "set",        description: "Set note/instruction on position" },
  { command: "config",     description: "Show important runtime config" },
  { command: "settings",   description: "Button menu for common config" },
  { command: "setcfg",     description: "Update persisted config key" },
  { command: "vp",         description: "List virtual (dry-run) positions" },
  { command: "screen",     description: "Refresh deterministic candidate list" },
  { command: "candidates", description: "Show latest cached candidates" },
  { command: "deploy",     description: "Deploy candidate by cached index" },
  { command: "briefing",   description: "Morning briefing" },
  { command: "hive",       description: "HiveMind sync status" },
  { command: "pause",      description: "Stop cron cycles" },
  { command: "resume",     description: "Start cron cycles again" },
  { command: "stop",       description: "Shut down agent" },
];

async function registerCommands(): Promise<void> {
  if (!BASE) return;
  try {
    await fetch(`${BASE}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commands: BOT_COMMANDS }),
    });
    log("telegram", "Bot commands registered");
  } catch (e: any) {
    log("telegram_warn", `Failed to register bot commands: ${e.message}`);
  }
}

export function startPolling(onMessage: (msg: any) => Promise<void>): void {
  if (!TOKEN) return;
  _polling = true;
  poll(onMessage);
  registerCommands();
  log("telegram", "Bot polling started");
}

export function stopPolling(): void {
  _polling = false;
}

// ─── Notification helpers ────────────────────────────────────────
export async function notifyDeploy({
  pair,
  amountSol,
  position,
  tx,
  priceRange,
  rangeCoverage,
  binStep,
  baseFee,
}: {
  pair: string;
  amountSol: number;
  position?: string;
  tx?: string;
  priceRange?: { min: number; max: number };
  rangeCoverage?: { downside_pct: number; upside_pct: number; width_pct: number };
  binStep?: number;
  baseFee?: number;
}): Promise<void> {
  if (hasActiveLiveMessage()) return;
  const priceStr = priceRange
    ? `Price range: ${priceRange.min < 0.0001 ? priceRange.min.toExponential(3) : priceRange.min.toFixed(6)} – ${priceRange.max < 0.0001 ? priceRange.max.toExponential(3) : priceRange.max.toFixed(6)}\n`
    : "";
  const coverageStr = rangeCoverage
    ? `Range cover: ${fmtPct(rangeCoverage.downside_pct)} downside | ${fmtPct(rangeCoverage.upside_pct)} upside | ${fmtPct(rangeCoverage.width_pct)} total\n`
    : "";
  const poolStr = (binStep || baseFee)
    ? `Bin step: ${binStep ?? "?"}  |  Base fee: ${baseFee != null ? baseFee + "%" : "?"}\n`
    : "";
  await sendHTML(
    `✅ <b>Deployed</b> ${pair}\n` +
    `Amount: ${amountSol} SOL\n` +
    priceStr +
    coverageStr +
    poolStr +
    `Position: <code>${position?.slice(0, 8)}...</code>\n` +
    `Tx: <code>${tx?.slice(0, 16)}...</code>`,
  );
}

export async function notifyClose({
  pair,
  pnlUsd,
  pnlPct,
}: {
  pair: string;
  pnlUsd: number;
  pnlPct: number;
}): Promise<void> {
  if (hasActiveLiveMessage()) return;
  const sign = pnlUsd >= 0 ? "+" : "";
  await sendHTML(
    `🔒 <b>Closed</b> ${pair}\n` +
    `PnL: ${sign}$${(pnlUsd ?? 0).toFixed(2)} (${sign}${(pnlPct ?? 0).toFixed(2)}%)`,
  );
}

export async function notifySwap({
  inputSymbol,
  outputSymbol,
  amountIn,
  amountOut,
  tx,
}: {
  inputSymbol: string;
  outputSymbol: string;
  amountIn: unknown;
  amountOut: unknown;
  tx?: string;
}): Promise<void> {
  if (hasActiveLiveMessage()) return;
  await sendHTML(
    `🔄 <b>Swapped</b> ${inputSymbol} → ${outputSymbol}\n` +
    `In: ${amountIn ?? "?"} | Out: ${amountOut ?? "?"}\n` +
    `Tx: <code>${tx?.slice(0, 16)}...</code>`,
  );
}

export async function notifyOutOfRange({
  pair,
  minutesOOR,
}: {
  pair: string;
  minutesOOR: number;
}): Promise<void> {
  if (hasActiveLiveMessage()) return;
  await sendHTML(
    `⚠️ <b>Out of Range</b> ${pair}\n` +
    `Been OOR for ${minutesOOR} minutes`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function fmtPct(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : "?";
}
