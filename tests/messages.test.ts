import { describe, it, expect } from "vitest";
import {
  cur,
  fmtPct,
  escapeMarkdown,
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
  formatError,
  formatDeployNotification,
  formatCloseNotification,
  formatSwapNotification,
  formatOutOfRange,
  formatManagementReport,
} from "../interfaces/messages.js";
import type {
  ConfigSnapshotInput,
  ManagementReportPosition,
  ManagementReportAction,
} from "../interfaces/messages.js";
import type { LivePosition } from "../types/index.js";

// ── Helpers / Factories ──────────────────────────────────────────

/** Factory for a minimal LivePosition with sensible defaults. */
function makePosition(overrides: Partial<LivePosition> = {}): LivePosition {
  return {
    position: "pos-abc-123",
    pool: "pool-xyz",
    pair: "SOL/USDC",
    pnl_pct: 5.5,
    unclaimed_fees_usd: 1.2,
    total_value_usd: 100,
    fee_per_tvl_24h: 8,
    lower_bin: 90,
    upper_bin: 110,
    active_bin: 100,
    minutes_out_of_range: 0,
    in_range: true,
    age_minutes: 30,
    pnl_usd: 5.5,
    ...overrides,
  };
}

/** Factory for a minimal ManagementReportPosition with sensible defaults. */
function makeReportPos(
  overrides: Partial<ManagementReportPosition> = {},
): ManagementReportPosition {
  return {
    position: "pos-abc-123",
    pair: "SOL/USDC",
    age_minutes: 30,
    total_value_usd: 100,
    unclaimed_fees_usd: 1.2,
    pnl_pct: 5.5,
    fee_per_tvl_24h: 8,
    in_range: true,
    minutes_out_of_range: 0,
    instruction: null,
    ...overrides,
  };
}

/** Factory for a minimal ConfigSnapshotInput with sensible defaults. */
function makeConfigSnapshot(
  overrides: Partial<ConfigSnapshotInput> = {},
): ConfigSnapshotInput {
  return {
    strategy: "spot",
    minBinsBelow: 35,
    maxBinsBelow: 69,
    defaultBinsBelow: 50,
    deployAmountSol: 0.5,
    gasReserve: 0.2,
    maxPositions: 3,
    stopLossPct: -20,
    takeProfitPct: 50,
    trailingTakeProfit: false,
    trailingTriggerPct: 30,
    trailingDropPct: 10,
    outOfRangeWaitMinutes: 30,
    oorCooldownTriggerCount: 3,
    oorCooldownHours: 24,
    repeatDeployCooldownEnabled: false,
    repeatDeployCooldownTriggerCount: 3,
    repeatDeployCooldownHours: 24,
    repeatDeployCooldownMinFeeEarnedPct: 5,
    repeatDeployCooldownScope: "pool",
    minFeePerTvl24h: 7,
    minAgeBeforeYieldCheck: 60,
    screeningCategory: "trending",
    screeningTimeframe: "5m",
    minTvl: 10000,
    maxTvl: 150000,
    managementIntervalMin: 10,
    screeningIntervalMin: 30,
    hiveEnabled: false,
    agentId: null,
    ...overrides,
  };
}

// ── Helpers ──────────────────────────────────────────────────────

describe("helpers", () => {
  describe("cur", () => {
    it("returns ◎ for sol mode", () => {
      expect(cur(true)).toBe("◎");
    });
    it("returns $ for usd mode", () => {
      expect(cur(false)).toBe("$");
    });
  });

  describe("fmtPct", () => {
    it("formats a finite number to 2 decimal places", () => {
      expect(fmtPct(42.5)).toBe("42.50%");
    });
    it("formats zero", () => {
      expect(fmtPct(0)).toBe("0.00%");
    });
    it("returns ? for NaN", () => {
      expect(fmtPct(NaN)).toBe("?");
    });
    it("returns ? for undefined", () => {
      expect(fmtPct(undefined)).toBe("?");
    });
    it("returns ? for Infinity", () => {
      expect(fmtPct(Infinity)).toBe("?");
    });
    it("accepts numeric strings", () => {
      expect(fmtPct("3.14")).toBe("3.14%");
    });
  });

  describe("escapeMarkdown", () => {
    it("escapes * with a backslash", () => {
      expect(escapeMarkdown("*hello*")).toBe("\\*hello\\*");
    });
    it("escapes _ with a backslash", () => {
      expect(escapeMarkdown("_world_")).toBe("\\_world\\_");
    });
    it("escapes ` with a backslash", () => {
      expect(escapeMarkdown("`foo`")).toBe("\\`foo\\`");
    });
    it("escapes a mix of special characters", () => {
      expect(escapeMarkdown("*hello* _world_ `foo`")).toBe(
        "\\*hello\\* \\_world\\_ \\`foo\\`",
      );
    });
    it("leaves plain text alone", () => {
      expect(escapeMarkdown("plain text 123")).toBe("plain text 123");
    });
  });
});

// ── Command Responses ────────────────────────────────────────────

describe("formatHelpText", () => {
  it("returns a string", () => {
    const text = formatHelpText();
    expect(typeof text).toBe("string");
  });
  it("contains /help", () => {
    expect(formatHelpText()).toContain("/help");
  });
  it("contains /positions", () => {
    expect(formatHelpText()).toContain("/positions");
  });
  it("contains /close", () => {
    expect(formatHelpText()).toContain("/close");
  });
});

describe("formatWalletStatus", () => {
  const wallet = { sol: 5.5, sol_usd: 1100, sol_price: 200 };
  const positions = { total_positions: 1 };
  const opts = { solMode: true, maxPositions: 3, deployAmount: 0.5, dryRun: false, hiveEnabled: true };

  it("contains the wallet sol balance", () => {
    expect(formatWalletStatus(wallet, positions, opts)).toContain("5.5");
  });
  it("contains the wallet usd value", () => {
    expect(formatWalletStatus(wallet, positions, opts)).toContain("1100");
  });
  it("contains the sol price", () => {
    expect(formatWalletStatus(wallet, positions, opts)).toContain("200");
  });
  it("contains maxPositions", () => {
    expect(formatWalletStatus(wallet, positions, opts)).toContain("3");
  });
  it("contains deployAmount", () => {
    expect(formatWalletStatus(wallet, positions, opts)).toContain("0.5");
  });
  it("contains SOL marker in sol mode", () => {
    expect(formatWalletStatus(wallet, positions, opts)).toContain("SOL");
  });
});

describe("formatConfigSnapshot", () => {
  it("contains 'strategy'", () => {
    const out = formatConfigSnapshot(makeConfigSnapshot());
    expect(out).toContain("Strategy");
  });
  it("contains 'Deploy amount' label", () => {
    const out = formatConfigSnapshot(makeConfigSnapshot());
    expect(out).toContain("Deploy:");
  });
  it("contains 'Max positions' label", () => {
    const out = formatConfigSnapshot(makeConfigSnapshot());
    expect(out).toContain("maxPositions");
  });
  it("renders known values from the input", () => {
    const out = formatConfigSnapshot(
      makeConfigSnapshot({ strategy: "momentum", deployAmountSol: 1.25, maxPositions: 7 }),
    );
    expect(out).toContain("momentum");
    expect(out).toContain("1.25");
    expect(out).toContain("7");
  });
  it("includes the strategy string with bins below range", () => {
    const out = formatConfigSnapshot(
      makeConfigSnapshot({ minBinsBelow: 40, maxBinsBelow: 80, defaultBinsBelow: 60 }),
    );
    expect(out).toContain("40");
    expect(out).toContain("80");
    expect(out).toContain("60");
  });
  it("appends agentId when present", () => {
    const out = formatConfigSnapshot(makeConfigSnapshot({ agentId: "agent-007" }));
    expect(out).toContain("agent-007");
  });
});

describe("formatPositions", () => {
  it("returns 'No open positions.' for an empty list", () => {
    expect(formatPositions([], 0, true)).toBe("No open positions.");
  });
  it("renders a single position with pair, PnL, age", () => {
    const pos = makePosition({ pair: "SOL/USDC", pnl_usd: 12.5, age_minutes: 45 });
    const out = formatPositions([pos], 1, true);
    expect(out).toContain("SOL/USDC");
    expect(out).toContain("12.5");
    expect(out).toContain("45");
  });
  it("renders OOR marker when in_range is false", () => {
    const pos = makePosition({ in_range: false, minutes_out_of_range: 22 });
    const out = formatPositions([pos], 1, true);
    expect(out).toContain("OOR");
  });
  it("escapes markdown in pair names", () => {
    const pos = makePosition({ pair: "SOL_*_USDC" });
    const out = formatPositions([pos], 1, true);
    expect(out).toContain("SOL\\_\\*\\_USDC");
  });
});

describe("formatPositionDetail", () => {
  it("returns a string containing pair, age, PnL, unclaimed fees", () => {
    const pos = makePosition({
      pair: "SOL/USDC",
      age_minutes: 60,
      pnl_pct: 5.5,
      unclaimed_fees_usd: 3.3,
    });
    const out = formatPositionDetail(pos, 0, true);
    expect(out).toContain("SOL/USDC");
    expect(out).toContain("60");
    expect(out).toContain("5.5");
    expect(out).toContain("3.3");
  });
  it("includes the pool and position", () => {
    const pos = makePosition({ pool: "pool-xyz", position: "pos-abc" });
    const out = formatPositionDetail(pos, 0, true);
    expect(out).toContain("pool-xyz");
    expect(out).toContain("pos-abc");
  });
  it("renders '??' when in_range is null", () => {
    const pos = makePosition({ in_range: null });
    const out = formatPositionDetail(pos, 0, true);
    expect(out).toContain("??");
  });
  it("includes the instruction note when set", () => {
    const pos = makePosition({ instruction: "hold until 2x" });
    const out = formatPositionDetail(pos, 0, true);
    expect(out).toContain("hold until 2x");
  });
});

describe("formatVirtualPositions", () => {
  it("returns 'No open virtual positions.' for empty list", () => {
    expect(formatVirtualPositions([], true)).toBe("No open virtual positions.");
  });
  it("renders a single VP with pair and PnL", () => {
    const pos = makePosition({
      position: "vp:abc-123",
      pair: "SOL/USDC",
      pnl_pct: 7.2,
    });
    const out = formatVirtualPositions([pos], true);
    expect(out).toContain("SOL/USDC");
    expect(out).toContain("7.20");
  });
  it("strips the 'vp:' prefix from position id", () => {
    const pos = makePosition({ position: "vp:abc-123", pair: "X/Y" });
    const out = formatVirtualPositions([pos], true);
    // "abc-123" (without "vp:") should appear in the output
    expect(out).toContain("abc-123");
  });
});

describe("formatCloseResult", () => {
  it("contains 'Close failed' on success=false", () => {
    const pos = makePosition();
    const out = formatCloseResult(pos, { success: false }, true);
    expect(out).toContain("Close failed");
  });
  it("contains 'Closed VP' for a successful virtual close", () => {
    const pos = makePosition();
    const out = formatCloseResult(
      pos,
      { success: true, is_virtual: true, pnl_pct: 12.5, pnl_usd: 0.0123 },
      true,
    );
    expect(out).toContain("Closed VP");
    expect(out).toContain("12.50");
  });
  it("contains 'Closed' and close txs for a successful live close", () => {
    const pos = makePosition();
    const out = formatCloseResult(
      pos,
      { success: true, is_virtual: false, pnl_usd: 5.5, close_txs: ["tx-aaa", "tx-bbb"] },
      true,
    );
    expect(out).toContain("Closed");
    expect(out).toContain("tx-aaa");
    expect(out).toContain("tx-bbb");
  });
  it("includes claim txs when provided", () => {
    const pos = makePosition();
    const out = formatCloseResult(
      pos,
      { success: true, close_txs: ["tx-aaa"], claim_txs: ["tx-claim"] },
      true,
    );
    expect(out).toContain("tx-claim");
  });
});

describe("formatCloseAllResult", () => {
  it("renders mixed success/failure — successful entries use 'closed'", () => {
    const results = [
      { pair: "SOL/USDC", success: true, pnl_pct: 5.5 },
      { pair: "BONK/SOL", success: false, error: "RPC timeout" },
    ];
    const out = formatCloseAllResult(results);
    expect(out).toContain("SOL/USDC");
    expect(out).toContain("BONK/SOL");
    expect(out).toContain("closed");
    expect(out).toContain("failed");
    expect(out).toContain("RPC timeout");
  });
  it("renders the VP tag for virtual positions", () => {
    const out = formatCloseAllResult([
      { pair: "X/Y", success: true, pnl_pct: 1, is_virtual: true },
    ]);
    expect(out).toContain("(VP)");
  });
});

describe("formatSetNote", () => {
  it("contains the pair and the note text", () => {
    const out = formatSetNote("SOL/USDC", "wait for confirmation");
    expect(out).toContain("SOL/USDC");
    expect(out).toContain("wait for confirmation");
  });
  it("escapes markdown in pair and note", () => {
    const out = formatSetNote("FOO*BAR", "alpha_beta");
    expect(out).toContain("FOO\\*BAR");
    expect(out).toContain("alpha\\_beta");
  });
});

describe("formatSetConfig", () => {
  it("renders 'Config update failed' when unknownKeys provided", () => {
    const out = formatSetConfig("foo", 1, ["bogusKey"]);
    expect(out).toContain("Config update failed");
    expect(out).toContain("bogusKey");
  });
  it("renders 'Updated' with key and value on success", () => {
    const out = formatSetConfig("maxPositions", 5);
    expect(out).toContain("Updated");
    expect(out).toContain("maxPositions");
    expect(out).toContain("5");
  });
});

describe("formatDeployResult", () => {
  it("contains the pair name, pool, amount, position", () => {
    const out = formatDeployResult(
      { name: "SOL/USDC", pool: "pool-xyz" },
      { position: "pos-abc", txs: ["tx-deploy-123456789"] },
      0.5,
      50,
      "spot",
    );
    expect(out).toContain("SOL/USDC");
    expect(out).toContain("pool-xyz");
    expect(out).toContain("0.5");
    expect(out).toContain("pos-abc");
  });
  it("renders range coverage when provided", () => {
    const out = formatDeployResult(
      { name: "X/Y", pool: "p" },
      { range_coverage: { downside_pct: 30, upside_pct: 15 } },
      1,
      50,
      "spot",
    );
    expect(out).toContain("Range:");
    expect(out).toContain("30.00%");
    expect(out).toContain("15.00%");
  });
});

describe("formatPause", () => {
  it("contains 'Paused'", () => {
    expect(formatPause()).toContain("Paused");
  });
});

describe("formatResume", () => {
  it("contains 'resumed' when not already running", () => {
    expect(formatResume(false)).toContain("resumed");
  });
  it("contains 'already running' when already running", () => {
    expect(formatResume(true)).toContain("already running");
  });
});

describe("formatQueued", () => {
  it("contains the count and truncated text", () => {
    // Use a non-repeating string so substr() checks are unambiguous
    const prefix = "X".repeat(60);
    const suffix = "Y".repeat(20);
    const text = prefix + suffix;
    const out = formatQueued(3, text);
    expect(out).toContain("3");
    // Truncated to 60 chars — prefix is preserved
    expect(out).toContain(prefix);
    // The untruncated portion (the trailing Y's) should NOT appear
    expect(out).not.toContain(suffix);
  });
});

describe("formatQueueFull", () => {
  it("contains 'Queue is full'", () => {
    expect(formatQueueFull()).toContain("Queue is full");
  });
});

describe("formatError", () => {
  it("returns 'Error: <message>'", () => {
    expect(formatError("something went wrong")).toBe("Error: something went wrong");
  });
});

// ── Notification Formatters ──────────────────────────────────────

describe("formatDeployNotification", () => {
  it("contains pair, amount, position", () => {
    const out = formatDeployNotification({
      pair: "SOL/USDC",
      amountSol: 0.5,
      position: "pos-abcdefgh-1234",
      tx: "tx-signature-1234567890abcdef",
    });
    expect(out).toContain("SOL/USDC");
    expect(out).toContain("0.5");
    expect(out).toContain("pos-abc"); // truncated to first 8 chars
  });
  it("includes range coverage when provided", () => {
    const out = formatDeployNotification({
      pair: "X/Y",
      amountSol: 1,
      rangeCoverage: { downside_pct: 30, upside_pct: 15, width_pct: 45 },
    });
    expect(out).toContain("30.00%");
    expect(out).toContain("15.00%");
  });
  it("includes bin step and base fee when provided", () => {
    const out = formatDeployNotification({
      pair: "X/Y",
      amountSol: 1,
      binStep: 100,
      baseFee: 0.2,
    });
    expect(out).toContain("100");
    expect(out).toContain("0.2%");
  });
});

describe("formatCloseNotification", () => {
  it("contains pair and positive PnL sign", () => {
    const out = formatCloseNotification("SOL/USDC", 5.5, 12.5);
    expect(out).toContain("SOL/USDC");
    expect(out).toContain("+");
    expect(out).toContain("5.50");
  });
  it("uses no sign for zero PnL", () => {
    const out = formatCloseNotification("X/Y", 0, 0);
    // For zero, the sign is still "" per the formatter logic
    expect(out).toContain("0.00");
  });
});

describe("formatSwapNotification", () => {
  it("contains input→output symbols", () => {
    const out = formatSwapNotification({
      inputSymbol: "SOL",
      outputSymbol: "USDC",
      amountIn: 1.5,
      amountOut: 200,
    });
    expect(out).toContain("SOL");
    expect(out).toContain("USDC");
    expect(out).toContain("→");
  });
});

describe("formatOutOfRange", () => {
  it("contains pair and minutes", () => {
    const out = formatOutOfRange("SOL/USDC", 35);
    expect(out).toContain("SOL/USDC");
    expect(out).toContain("35");
  });
});

// ── Cycle Reports ────────────────────────────────────────────────

describe("formatManagementReport", () => {
  it("two positions, mixed actions: STAY and CLOSE 'stop loss'", () => {
    const pos1 = makeReportPos({ position: "pos-1", pair: "SOL/USDC" });
    const pos2 = makeReportPos({ position: "pos-2", pair: "BONK/SOL" });
    const actions = new Map<string, ManagementReportAction>([
      ["pos-1", { action: "STAY" }],
      ["pos-2", { action: "CLOSE", rule: 1, reason: "stop loss" }],
    ]);
    const out = formatManagementReport([pos1, pos2], actions, true);
    expect(out).toContain("SOL/USDC");
    expect(out).toContain("BONK/SOL");
    // STAY was filtered from the summary; "no action" must NOT appear
    expect(out).not.toContain("no action");
    // The CLOSE action should be reflected in the summary
    expect(out).toContain("CLOSE");
  });

  it("all STAY → summary contains 'no action'", () => {
    const pos1 = makeReportPos({ position: "pos-1", pair: "SOL/USDC" });
    const pos2 = makeReportPos({ position: "pos-2", pair: "BONK/SOL" });
    const actions = new Map<string, ManagementReportAction>([
      ["pos-1", { action: "STAY" }],
      ["pos-2", { action: "STAY" }],
    ]);
    const out = formatManagementReport([pos1, pos2], actions, true);
    expect(out).toContain("no action");
  });

  it("empty positions array → summary contains '0 positions' and 'no action'", () => {
    const actions = new Map<string, ManagementReportAction>();
    const out = formatManagementReport([], actions, true);
    expect(out).toContain("0 positions");
    expect(out).toContain("no action");
  });

  it("INSTRUCTION action → line contains 'HOLD (instruction)'", () => {
    const pos = makeReportPos({ position: "pos-1", pair: "SOL/USDC" });
    const actions = new Map<string, ManagementReportAction>([
      ["pos-1", { action: "INSTRUCTION", reason: "wait for confirmation" }],
    ]);
    const out = formatManagementReport([pos], actions, true);
    expect(out).toContain("HOLD (instruction)");
  });

  it("CLAIM action → contains 'Claiming fees'", () => {
    const pos = makeReportPos({ position: "pos-1", pair: "SOL/USDC" });
    const actions = new Map<string, ManagementReportAction>([
      ["pos-1", { action: "CLAIM" }],
    ]);
    const out = formatManagementReport([pos], actions, true);
    expect(out).toContain("Claiming fees");
  });

  it("trailing TP: CLOSE with rule 'exit' → contains 'Trailing TP'", () => {
    const pos = makeReportPos({ position: "pos-1", pair: "SOL/USDC" });
    const actions = new Map<string, ManagementReportAction>([
      ["pos-1", { action: "CLOSE", rule: "exit", reason: "dropped 10% from peak" }],
    ]);
    const out = formatManagementReport([pos], actions, true);
    expect(out).toContain("Trailing TP");
  });

  it("non-exit CLOSE rule → contains 'Rule <n>: <reason>'", () => {
    const pos = makeReportPos({ position: "pos-1", pair: "SOL/USDC" });
    const actions = new Map<string, ManagementReportAction>([
      ["pos-1", { action: "CLOSE", rule: 5, reason: "low yield" }],
    ]);
    const out = formatManagementReport([pos], actions, true);
    expect(out).toContain("Rule 5");
    expect(out).toContain("low yield");
  });

  it("null fields render as '?'", () => {
    const pos = makeReportPos({
      position: "pos-1",
      pair: "SOL/USDC",
      pnl_pct: null,
      total_value_usd: null,
      unclaimed_fees_usd: null,
      age_minutes: null,
    });
    const out = formatManagementReport([pos], new Map(), true);
    // All four nulls should produce "?" in the output
    const qmarkCount = (out.match(/\?/g) ?? []).length;
    expect(qmarkCount).toBeGreaterThanOrEqual(4);
  });

  it("escapes markdown in pair names — raw '*' should not appear unescaped", () => {
    const pos = makeReportPos({
      position: "pos-1",
      pair: "SOL_*_USDC",
    });
    const out = formatManagementReport([pos], new Map(), true);
    // The escaped form (with both * and _ escaped) must appear
    expect(out).toContain("SOL\\_\\*\\_USDC");
    // The unescaped pattern (literal * between two underscores) must NOT appear
    expect(out).not.toContain("_*_");
  });

  it("includes the instruction note when present", () => {
    const pos = makeReportPos({
      position: "pos-1",
      pair: "SOL/USDC",
      instruction: "hold to 2x",
    });
    const out = formatManagementReport([pos], new Map(), true);
    expect(out).toContain("Note:");
    expect(out).toContain("hold to 2x");
  });

  it("summary contains position count and totals", () => {
    const pos1 = makeReportPos({ position: "pos-1", pair: "A/B", total_value_usd: 100, unclaimed_fees_usd: 1 });
    const pos2 = makeReportPos({ position: "pos-2", pair: "C/D", total_value_usd: 200, unclaimed_fees_usd: 2 });
    const out = formatManagementReport([pos1, pos2], new Map(), true);
    expect(out).toContain("2 positions");
    expect(out).toContain("300"); // total value
    expect(out).toContain("3");   // total unclaimed (1+2=3.0000)
  });

  it("INSTRUCTION in summary renders as 'EVAL instruction'", () => {
    const pos = makeReportPos({ position: "pos-1", pair: "SOL/USDC" });
    const actions = new Map<string, ManagementReportAction>([
      ["pos-1", { action: "INSTRUCTION", reason: "wait" }],
    ]);
    const out = formatManagementReport([pos], actions, true);
    expect(out).toContain("EVAL instruction");
  });
});
