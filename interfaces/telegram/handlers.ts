import type { TelegramMessage } from "../../cli/state.js";
import { busy, setBusy, refreshPrompt, _telegramQueue, sessionHistory, appendHistory } from "../../cli/state.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "../../utils/logger.js";
import { getMyPositions, closePosition } from "../../providers/meteora/index.js";
import { getWalletBalances } from "../../providers/solana/index.js";
import { config, computeDeployAmount } from "../../config/index.js";
import { isHiveMindEnabled, ensureAgentId, getHiveMindPullMode, pullHiveMindLessons, pullHiveMindPresets, registerHiveMindAgent } from "../../providers/hivemind/index.js";
import { executeTool, agentLoop } from "../../llm/index.js";
import { toError } from "../../utils/errors.js";
import { stripThink } from "../../utils/text.js";
import {
  managementBusy,
  screeningBusy,
  generateBriefing,
  parseVirtualPositionAddress,
  closeVpPosition as closeVpManual,
  generateVpReport as generateDryRunReport,
  readArchive,
  compileVpStats,
  tryStartScreening,
  setPositionInstruction,
} from "../../core/index.js";
import { pauseCron, resumeCron, cronStarted as _cronStarted } from "../../scheduler/index.js";
import {
  sendMessage,
  sendMessageWithButtons,
  sendLongMessage,
  sendDocument,
  editMessage,
  editMessageWithButtons,
  answerCallbackQuery,
  createLiveMessage,
  dryRunTag,
  formatHelpText,
  formatWalletStatus,
  formatConfigSnapshot,
  formatPositions,
  formatPositionDetail,
  formatVirtualPositions,
  formatCloseResult,
  formatCloseAllResult,
  formatSetNote,
  formatSetConfig,
  formatDeployResult,
  formatPause,
  formatResume,
  formatQueued,
  formatQueueFull,
  buildConfigSnapshotInput,
  escapeMarkdown,
} from "../../interfaces/index.js";
import { renderSettingsMenu, settingButton, settingValue } from "../../interfaces/telegram/menu.js";
import type { LivePosition } from "../../types/index.js";
import { parseConfigValue, setLatestCandidates, getLatestCandidatesMeta, describeLatestCandidates } from "../../cli/repl.js";
import { runDeterministicScreen, deployLatestCandidate } from "../../cli/orchestrate.js";

// ═══════════════════════════════════════════
//  TELEGRAM SETTINGS MENU
// ═══════════════════════════════════════════

async function showSettingsMenu({ messageId = null, page = "main" }: { messageId?: number | null; page?: string } = {}): Promise<void> {
  const menu = renderSettingsMenu(page);
  if (messageId) {
    await editMessageWithButtons(menu.text, messageId, menu.keyboard);
  } else {
    await sendMessageWithButtons(menu.text, menu.keyboard);
  }
}

function normalizeMenuValue(key: string, raw: any): any {
  if (key === "indicatorIntervals") {
    if (raw === "both") return ["5_MINUTE", "15_MINUTE"];
    return [raw];
  }
  return parseConfigValue(raw);
}

async function applySettingsMenuCallback(msg: TelegramMessage): Promise<void> {
  const data: string = msg.callbackData || msg.text || "";
  const parts: string[] = data.split(":");
  const action: string = parts[1];
  let page: string = "main";

  if (action === "noop") {
    await answerCallbackQuery(msg.callbackQueryId!);
    return;
  }
  if (action === "close") {
    await answerCallbackQuery(msg.callbackQueryId!, "Closed");
    await editMessage("Settings menu closed.", msg.messageId!);
    return;
  }
  if (action === "show") {
    await answerCallbackQuery(msg.callbackQueryId!);
    await editMessageWithButtons(formatConfigSnapshot(buildConfigSnapshotInput(config, isHiveMindEnabled())), msg.messageId!, [[settingButton("Back", "cfg:page:main")]]);
    return;
  }
  if (action === "page") {
    page = parts[2] || "main";
    await answerCallbackQuery(msg.callbackQueryId!);
    await showSettingsMenu({ messageId: msg.messageId!, page });
    return;
  }

  const key: string = parts[2];
  let value: any;
  if (action === "toggle") {
    value = !Boolean(settingValue(key));
  } else if (action === "step") {
    const current: number = Number(settingValue(key));
    const delta: number = Number(parts[3]);
    if (!Number.isFinite(current) || !Number.isFinite(delta)) {
      await answerCallbackQuery(msg.callbackQueryId!, "Invalid setting");
      return;
    }
    value = Number((current + delta).toFixed(4));
    if (key === "maxPositions") value = Math.max(1, Math.round(value));
    if (key === "rsiLength") value = Math.max(2, Math.round(value));
    if (key === "repeatDeployCooldownTriggerCount") value = Math.max(1, Math.round(value));
    if (key === "repeatDeployCooldownHours") value = Math.max(0, Math.round(value));
    if (key === "repeatDeployCooldownMinFeeEarnedPct") value = Math.max(0, value);
    if (["minBinsBelow", "maxBinsBelow", "defaultBinsBelow"].includes(key)) value = Math.max(35, Math.round(value));
    if (["deployAmountSol", "gasReserve", "maxDeployAmount"].includes(key)) value = Math.max(0, value);
  } else if (action === "set") {
    value = normalizeMenuValue(key, parts.slice(3).join(":"));
  } else {
    await answerCallbackQuery(msg.callbackQueryId!, "Unknown action");
    return;
  }

  const result: any = await executeTool("update_config", {
    changes: { [key]: value },
    reason: "Telegram settings menu",
  });
  if (!result?.success) {
    await answerCallbackQuery(msg.callbackQueryId!, "Config update failed");
    return;
  }
  page = key.startsWith("indicator") || key === "chartIndicatorsEnabled" || key === "rsiLength" || key === "requireAllIntervals"
    ? "indicators"
    : ["useDiscordSignals", "blockPvpSymbols", "strategy", "minBinsBelow", "maxBinsBelow", "defaultBinsBelow", "managementIntervalMin", "screeningIntervalMin"].includes(key)
      ? "screen"
      : "risk";
  await answerCallbackQuery(msg.callbackQueryId!, `Updated ${key}`);
  await showSettingsMenu({ messageId: msg.messageId!, page });
}

async function drainTelegramQueue(): Promise<void> {
  while (_telegramQueue.length > 0 && !managementBusy && !screeningBusy && !busy) {
    const queued: TelegramMessage | undefined = _telegramQueue.shift();
    if (queued) {
      await telegramHandler(queued);
    }
  }
}

async function telegramHandler(msg: TelegramMessage): Promise<void> {
  const text: string | undefined = msg?.text?.trim().split("@")[0];
  if (!text) return;
  if (msg?.isCallback && text.startsWith("cfg:")) {
    try {
      await applySettingsMenuCallback(msg);
    } catch (e) {
      await answerCallbackQuery(msg.callbackQueryId!, toError(e).message).catch(() => {});
    }
    return;
  }
  if (text === "/settings" || text === "/menu" || text === "/configmenu") {
    await showSettingsMenu().catch((e: Error) => sendMessage(`Settings error: ${e.message}`).catch(() => {}));
    return;
  }
  if (managementBusy || screeningBusy || busy) {
    if (_telegramQueue.length < 5) {
      _telegramQueue.push(msg);
      sendMessage(formatQueued(_telegramQueue.length, text)).catch(() => {});
    } else {
      sendMessage(formatQueueFull()).catch(() => {});
    }
    return;
  }

  if (text === "/briefing") {
    try {
      const briefing: string = await generateBriefing();
      await sendLongMessage(briefing);
    } catch (e) {
      await sendMessage(`Error: ${toError(e).message}`).catch(() => {});
    }
    return;
  }

  if (text === "/help") {
    await sendMessage(formatHelpText()).catch(() => {});
    return;
  }

  if (text === "/wallet" || text === "/status") {
    try {
      const [wallet, positions] = await Promise.all([getWalletBalances(), getMyPositions({ force: true })]);
      const suffix: string = text === "/status" && positions.total_positions
        ? `\n\nUse /positions for the numbered list.`
        : "";
      await sendMessage(`${formatWalletStatus(wallet, positions, {
        solMode: config.management.solMode,
        maxPositions: config.risk.maxPositions,
        deployAmount: computeDeployAmount(wallet.sol),
        dryRun: process.env.DRY_RUN === "true",
        hiveEnabled: isHiveMindEnabled(),
      })}${suffix}`).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${toError(e).message}`).catch(() => {});
    }
    return;
  }

  if (text === "/config") {
    await sendMessage(formatConfigSnapshot(buildConfigSnapshotInput(config, isHiveMindEnabled()))).catch(() => {});
    return;
  }

  if (text === "/positions") {
    try {
      const { positions, total_positions }: { positions: LivePosition[]; total_positions: number } = await getMyPositions({ force: true });
      await sendMessage(dryRunTag(formatPositions(positions, total_positions, config.management.solMode)));
    } catch (e) { await sendMessage(`Error: ${toError(e).message}`).catch(() => {}); }
    return;
  }

  if (text === "/vp" || text === "/vp report") {
    try {
      if (text === "/vp report") {
        const records: any = await readArchive({ source: "paper", hours: 720, limit: 5000 });
        const statsMsg: string = compileVpStats(records);
        await sendLongMessage(statsMsg);

        const html: string = await generateDryRunReport();
        const filePath: string = path.join(path.dirname(fileURLToPath(import.meta.url)), "dry-run-report.html");
        fs.writeFileSync(filePath, html, "utf8");
        const sent: boolean = await sendDocument(filePath, { caption: "📄 Dry-run VP report" });
        if (!sent) await sendMessage("❌ Failed to upload HTML report — check logs.");
      } else {
        const { positions }: { positions: LivePosition[] } = await getMyPositions({ force: true });
        const vps: LivePosition[] = positions.filter((p: LivePosition) => p.position?.startsWith("vp:"));
        await sendMessage(formatVirtualPositions(vps, config.management.solMode));
      }
    } catch (e) { await sendMessage(`Error: ${toError(e).message}`).catch(() => {}); }
    return;
  }

  const poolMatch: RegExpMatchArray | null = text.match(/^\/pool\s+(\d+)$/i);
  if (poolMatch) {
    try {
      const idx: number = parseInt(poolMatch[1]) - 1;
      const { positions }: { positions: LivePosition[] } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
      const pos: LivePosition = positions[idx];
      await sendMessage(formatPositionDetail(pos, idx, config.management.solMode));
    } catch (e) {
      await sendMessage(`Error: ${toError(e).message}`).catch(() => {});
    }
    return;
  }

  async function closeTelegramPosition(pos: LivePosition): Promise<any> {
    const vpId: string | null = parseVirtualPositionAddress(pos.position);
    if (vpId) {
      return await closeVpManual(vpId, "manual close via telegram /close");
    }
    return await closePosition({ position_address: pos.position });
  }

  const closeMatch: RegExpMatchArray | null = text.match(/^\/close\s+(\d+)$/i);
  if (closeMatch) {
    try {
      const idx: number = parseInt(closeMatch[1]) - 1;
      const { positions }: { positions: LivePosition[] } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
      const pos: LivePosition = positions[idx];
      await sendMessage(`Closing ${escapeMarkdown(pos.pair)}...`);
      const result: any = await closeTelegramPosition(pos);
      await sendMessage(dryRunTag(formatCloseResult(pos, result, config.management.solMode)));
      if (result.success) {
        tryStartScreening("telegram-close", true);
      }
    } catch (e) { await sendMessage(`Error: ${toError(e).message}`).catch(() => {}); }
    return;
  }

  if (text === "/closeall") {
    try {
      const { positions }: { positions: LivePosition[] } = await getMyPositions({ force: true });
      if (!positions.length) { await sendMessage("No open positions."); return; }
      await sendMessage(`Closing ${positions.length} position(s)...`);
      const results: Array<{ pair: string; success: boolean; pnl_pct?: number; error?: string; is_virtual?: boolean }> = [];
      for (const pos of positions) {
        try {
          const result: any = await closeTelegramPosition(pos);
          results.push({ pair: pos.pair, success: result.success, pnl_pct: result.pnl_pct, error: result.error, is_virtual: result.is_virtual });
        } catch (error) {
          results.push({ pair: pos.pair, success: false, error: toError(error).message });
        }
      }
      await sendMessage(dryRunTag(formatCloseAllResult(results))).catch(() => {});
      tryStartScreening("telegram-closeall", true);
    } catch (e) {
      await sendMessage(`Error: ${toError(e).message}`).catch(() => {});
    }
    return;
  }

  const setMatch: RegExpMatchArray | null = text.match(/^\/set\s+(\d+)\s+(.+)$/i);
  if (setMatch) {
    try {
      const idx: number = parseInt(setMatch[1]) - 1;
      const note: string = setMatch[2].trim();
      const { positions }: { positions: LivePosition[] } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
      const pos: LivePosition = positions[idx];
      setPositionInstruction(pos.position, note);
      await sendMessage(formatSetNote(pos.pair, note));
    } catch (e) { await sendMessage(`Error: ${toError(e).message}`).catch(() => {}); }
    return;
  }

  const setCfgMatch: RegExpMatchArray | null = text.match(/^\/setcfg\s+([A-Za-z0-9_]+)\s+(.+)$/i);
  if (setCfgMatch) {
    try {
      const key: string = setCfgMatch[1];
      const value: any = parseConfigValue(setCfgMatch[2]);
      const result: any = await executeTool("update_config", {
        changes: { [key]: value },
        reason: "Telegram slash command /setcfg",
      });
      if (!result?.success) {
        await sendMessage(formatSetConfig(key, value, result?.unknown)).catch(() => {});
        return;
      }
      await sendMessage(formatSetConfig(key, value)).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${toError(e).message}`).catch(() => {});
    }
    return;
  }

  if (text === "/screen") {
    try {
      await sendMessage(await runDeterministicScreen(5)).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${toError(e).message}`).catch(() => {});
    }
    return;
  }

  if (text === "/candidates") {
    await sendMessage(describeLatestCandidates(5)).catch(() => {});
    return;
  }

  const deployMatch: RegExpMatchArray | null = text.match(/^\/deploy\s+(\d+)$/i);
  if (deployMatch) {
    try {
      const idx: number = parseInt(deployMatch[1]) - 1;
      const { candidate, result, deployAmount, binsBelow } = await deployLatestCandidate(idx);
      await sendMessage(dryRunTag(formatDeployResult(candidate, result, deployAmount, binsBelow, config.strategy.strategy))).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${toError(e).message}`).catch(() => {});
    }
    return;
  }

  if (text === "/pause") {
    pauseCron();
    await sendMessage(formatPause()).catch(() => {});
    return;
  }

  if (text === "/resume") {
    if (!_cronStarted) {
      resumeCron();
      await sendMessage(formatResume(false)).catch(() => {});
    } else {
      await sendMessage(formatResume(true)).catch(() => {});
    }
    return;
  }

  if (text === "/hive" || text === "/hive pull") {
    try {
      const enabled: boolean = isHiveMindEnabled();
      const agentId: string = ensureAgentId();
      if (!enabled) {
        await sendMessage(`HiveMind: disabled\nAgent ID: ${agentId}\nSet hiveMindApiKey to connect.`).catch(() => {});
        return;
      }
      const isManualPull: boolean = text === "/hive pull";
      const pullMode: string = getHiveMindPullMode();
      const [registerResult, lessons, presets]: [any, any, any] = await Promise.all([
        registerHiveMindAgent({ reason: isManualPull ? "telegram_pull" : "telegram_status" }),
        (pullMode === "auto" || isManualPull) ? pullHiveMindLessons(12) : Promise.resolve(null),
        (pullMode === "auto" || isManualPull) ? pullHiveMindPresets() : Promise.resolve(null),
      ]);
      await sendMessage([
        "HiveMind: enabled",
        `Agent ID: ${agentId}`,
        `URL: ${config.hiveMind.url}`,
        `Pull mode: ${pullMode}`,
        `Register: ${registerResult ? "ok" : "warn"}`,
        `Shared lessons: ${Array.isArray(lessons) ? lessons.length : (pullMode === "manual" ? "manual" : 0)}`,
        `Presets: ${Array.isArray(presets) ? presets.length : (pullMode === "manual" ? "manual" : 0)}`,
        isManualPull ? "Manual pull: completed" : null,
      ].join("\n")).catch(() => {});
    } catch (e) {
      await sendMessage(`HiveMind error: ${toError(e).message}`).catch(() => {});
    }
    return;
  }

  setBusy(true);
  let liveMessage: any = null;
  try {
    log("telegram", `Incoming: ${text}`);
    const hasCloseIntent: boolean = /\bclose\b|\bsell\b|\bexit\b|\bwithdraw\b/i.test(text);
    const isDeployRequest: boolean = !hasCloseIntent && /\bdeploy\b|\bopen position\b|\blp into\b|\badd liquidity\b/i.test(text);
    const agentRole: string = isDeployRequest ? "SCREENER" : "GENERAL";
    const agentModel = agentRole === "SCREENER" ? config.llm.screeningModel : config.llm.generalModel;
    liveMessage = await createLiveMessage("🤖 Live Update", `Request: ${text.slice(0, 240)}`);
    const { content }: { content: string } = await agentLoop(text, config.llm.maxSteps, sessionHistory, agentRole as any, agentModel, null, {
      interactive: true,
      onToolStart: async ({ name }: { name: string }) => { await liveMessage?.toolStart(name); },
      onToolFinish: async ({ name, result, success }: { name: string; result: any; success: boolean }) => { await liveMessage?.toolFinish(name, result, success); },
    });
    appendHistory(text, content);
    if (liveMessage) await liveMessage.finalize(stripThink(content));
    else await sendLongMessage(stripThink(content));
  } catch (e) {
    if (liveMessage) await liveMessage.fail(toError(e).message).catch(() => {});
    else await sendMessage(`Error: ${toError(e).message}`).catch(() => {});
  } finally {
    setBusy(false);
    refreshPrompt();
    drainTelegramQueue().catch(() => {});
  }
}

export { telegramHandler, showSettingsMenu, applySettingsMenuCallback };
