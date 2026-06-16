// cli/menu.ts
import { config } from "../../config/index.js";

type AnyObj = Record<string, any>;

function settingValue(key: string): any {
  const values: AnyObj = {
    solMode: config.management.solMode,
    lpAgentRelayEnabled: config.api.lpAgentRelayEnabled,
    chartIndicatorsEnabled: config.indicators.enabled,
    trailingTakeProfit: config.management.trailingTakeProfit,
    useDiscordSignals: config.screening.useDiscordSignals,
    blockPvpSymbols: config.screening.blockPvpSymbols,
    strategy: config.strategy.strategy,
    minBinsBelow: config.strategy.minBinsBelow,
    maxBinsBelow: config.strategy.maxBinsBelow,
    defaultBinsBelow: config.strategy.defaultBinsBelow,
    deployAmountSol: config.management.deployAmountSol,
    gasReserve: config.management.gasReserve,
    maxPositions: config.risk.maxPositions,
    maxDeployAmount: config.risk.maxDeployAmount,
    takeProfitPct: config.management.takeProfitPct,
    stopLossPct: config.management.stopLossPct,
    trailingTriggerPct: config.management.trailingTriggerPct,
    trailingDropPct: config.management.trailingDropPct,
    repeatDeployCooldownEnabled: config.management.repeatDeployCooldownEnabled,
    repeatDeployCooldownTriggerCount: config.management.repeatDeployCooldownTriggerCount,
    repeatDeployCooldownHours: config.management.repeatDeployCooldownHours,
    repeatDeployCooldownMinFeeEarnedPct: config.management.repeatDeployCooldownMinFeeEarnedPct,
    managementIntervalMin: config.schedule.managementIntervalMin,
    screeningIntervalMin: config.schedule.screeningIntervalMin,
    indicatorEntryPreset: config.indicators.entryPreset,
    indicatorExitPreset: config.indicators.exitPreset,
    rsiLength: config.indicators.rsiLength,
    indicatorIntervals: config.indicators.intervals,
    requireAllIntervals: config.indicators.requireAllIntervals,
  };
  return values[key];
}

function fmtSettingValue(value: any): string {
  if (Array.isArray(value)) return value.join(",");
  if (typeof value === "boolean") return value ? "on" : "off";
  return String(value);
}

function settingButton(label: string, data: string): AnyObj {
  return { text: label, callback_data: data };
}

function toggleButton(key: string, label: string): AnyObj {
  const value: any = settingValue(key);
  return settingButton(`${fmtSettingValue(value)} ${label}`, `cfg:toggle:${key}`);
}

function stepButtons(key: string, label: string, step: number, { digits = 2 }: { digits?: number } = {}): AnyObj[] {
  const value: number = Number(settingValue(key));
  const shown: string = Number.isFinite(value) ? value.toFixed(digits).replace(/\.?0+$/, "") : "?";
  return [
    settingButton(`- ${label}`, `cfg:step:${key}:${-step}`),
    settingButton(`${label}: ${shown}`, `cfg:noop`),
    settingButton(`+ ${label}`, `cfg:step:${key}:${step}`),
  ];
}

function renderSettingsMenu(page: string = "main"): { text: string; keyboard: AnyObj[][] } {
  const title: string = page === "main" ? "Settings menu" : `Settings: ${page}`;
  const summary: string = [
    title,
    "",
    `Mode: ${config.management.solMode ? "SOL" : "USD"} | Relay: ${config.api.lpAgentRelayEnabled ? "on" : "off"}`,
    `Strategy: ${config.strategy.strategy} | bins ${config.strategy.minBinsBelow}-${config.strategy.maxBinsBelow} | deploy ${config.management.deployAmountSol} SOL`,
    `TP/SL: ${config.management.takeProfitPct}% / ${config.management.stopLossPct}% | trailing ${config.management.trailingTakeProfit ? "on" : "off"}`,
    `Indicators: ${config.indicators.enabled ? "on" : "off"} | entry ${config.indicators.entryPreset} | ${fmtSettingValue(config.indicators.intervals)}`,
  ].join("\n");

  const nav: AnyObj[][] = [
    [
      settingButton("Main", "cfg:page:main"),
      settingButton("Risk", "cfg:page:risk"),
      settingButton("Screen", "cfg:page:screen"),
      settingButton("Indicators", "cfg:page:indicators"),
    ],
  ];

  const footer: AnyObj[][] = [
    [
      settingButton("Refresh", `cfg:page:${page}`),
      settingButton("Close", "cfg:close"),
    ],
  ];

  let rows: AnyObj[][];
  if (page === "risk") {
    rows = [
      stepButtons("deployAmountSol", "Deploy", 0.1),
      stepButtons("gasReserve", "Gas", 0.05),
      stepButtons("maxPositions", "Max pos", 1, { digits: 0 }),
      stepButtons("maxDeployAmount", "Max SOL", 1, { digits: 0 }),
      stepButtons("takeProfitPct", "TP %", 1, { digits: 0 }),
      stepButtons("stopLossPct", "SL %", 5, { digits: 0 }),
      [toggleButton("trailingTakeProfit", "Trailing TP")],
      stepButtons("trailingTriggerPct", "Trail trigger", 0.5, { digits: 1 }),
      stepButtons("trailingDropPct", "Trail drop", 0.5, { digits: 1 }),
      [toggleButton("repeatDeployCooldownEnabled", "Repeat cooldown")],
      stepButtons("repeatDeployCooldownTriggerCount", "Repeat count", 1, { digits: 0 }),
      stepButtons("repeatDeployCooldownHours", "Repeat hrs", 1, { digits: 0 }),
      stepButtons("repeatDeployCooldownMinFeeEarnedPct", "Fee earned %", 0.1, { digits: 1 }),
    ];
  } else if (page === "screen") {
    rows = [
      [toggleButton("useDiscordSignals", "Discord signals"), toggleButton("blockPvpSymbols", "PVP hard block")],
      [
        settingButton("Strategy: spot", "cfg:set:strategy:spot"),
        settingButton("Strategy: bid_ask", "cfg:set:strategy:bid_ask"),
      ],
      stepButtons("minBinsBelow", "Min bins", 1, { digits: 0 }),
      stepButtons("maxBinsBelow", "Max bins", 1, { digits: 0 }),
      stepButtons("defaultBinsBelow", "Default bins", 1, { digits: 0 }),
      stepButtons("managementIntervalMin", "Manage min", 1, { digits: 0 }),
      stepButtons("screeningIntervalMin", "Screen min", 5, { digits: 0 }),
    ];
  } else if (page === "indicators") {
    rows = [
      [toggleButton("chartIndicatorsEnabled", "Chart indicators"), toggleButton("requireAllIntervals", "Require all TF")],
      [
        settingButton("TF: 5m", "cfg:set:indicatorIntervals:5_MINUTE"),
        settingButton("TF: 15m", "cfg:set:indicatorIntervals:15_MINUTE"),
        settingButton("TF: both", "cfg:set:indicatorIntervals:both"),
      ],
      [
        settingButton("Entry: ST", "cfg:set:indicatorEntryPreset:supertrend_break"),
        settingButton("Entry: RSI", "cfg:set:indicatorEntryPreset:rsi_reversal"),
        settingButton("Entry: ST/RSI", "cfg:set:indicatorEntryPreset:supertrend_or_rsi"),
      ],
      [
        settingButton("Exit: ST", "cfg:set:indicatorExitPreset:supertrend_break"),
        settingButton("Exit: RSI", "cfg:set:indicatorExitPreset:rsi_reversal"),
        settingButton("Exit: BB+RSI", "cfg:set:indicatorExitPreset:bb_plus_rsi"),
      ],
      stepButtons("rsiLength", "RSI len", 1, { digits: 0 }),
    ];
  } else {
    rows = [
      [toggleButton("trailingTakeProfit", "Trailing TP")],
      [toggleButton("chartIndicatorsEnabled", "Indicators")],
      [settingButton("Show config", "cfg:show")],
    ];
  }

  return {
    text: summary,
    keyboard: [...nav, ...rows, ...footer],
  };
}

export { settingValue, settingButton, stepButtons, toggleButton, renderSettingsMenu, fmtSettingValue };
export type { AnyObj };
