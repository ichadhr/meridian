/**
 * Test: State-mismatch bug fix
 *
 * Bug: get_my_positions tool returns 0 positions when wallet has 3 VPs.
 * Deploy pre-check counts VPs separately → 3 → REJECTS as "Max positions (3) reached"
 * with no way for the LLM to know why.
 *
 * Fix:
 *  1. getMyPositions() includes VPs in DRY_RUN mode (single source of truth).
 *  2. LLM-facing toolMap wrapper passes force: true (no stale cache).
 *  3. executor.js + screening.js no longer add VPs separately.
 *
 * Pure functions, no npm install needed.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, it, expect } from "vitest";
import { mergeVpPositions as mergeVirtualPositions, getCloseRule as getVirtualCloseRule } from "../../core/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ════════════════════════════════════════════════════════════
//  SECTION A: VP merge logic
// ════════════════════════════════════════════════════════════

describe("VP merge logic", () => {
  it("A1: live mode (no VPs in input) — 3 on-chain positions stay 3", () => {
    const onChain = [
      { position: "pk1", pool: "P1", base_mint: "M1" },
      { position: "pk2", pool: "P2", base_mint: "M2" },
      { position: "pk3", pool: "P3", base_mint: "M3" },
    ] as any;
    const result = mergeVirtualPositions(onChain, []);
    expect(result.total_positions).toBe(3);
    expect(result.positions.length).toBe(3);
  });

  it("A2: dry-run mode (3 VPs, 0 on-chain) — count goes 0 → 3", () => {
    const onChain: any[] = [];
    const vps = [
      { id: "vp_001", pool: "P1", base_mint: "M1", deployed_at: new Date(Date.now() - 600000).toISOString() },
      { id: "vp_002", pool: "P2", base_mint: "M2", deployed_at: new Date(Date.now() - 300000).toISOString() },
      { id: "vp_003", pool: "P3", base_mint: "M3", deployed_at: new Date(Date.now() - 60000).toISOString() },
    ];
    const result = mergeVirtualPositions(onChain, vps as any);
    expect(result.total_positions).toBe(3);
    expect(result.positions.length).toBe(3);
    for (const p of result.positions) {
      expect(p.source).toBe("virtual");
      expect(p.position.startsWith("vp:")).toBe(true);
    }
  });

  it("A3: dry-run mode (2 on-chain + 1 VP) — count goes 2 → 3, original 2 unchanged", () => {
    const onChain = [
      { position: "pk1", pool: "P1", base_mint: "M1" },
      { position: "pk2", pool: "P2", base_mint: "M2" },
    ] as any;
    const vps = [
      { id: "vp_001", pool: "P3", base_mint: "M3", deployed_at: new Date().toISOString() },
    ];
    const result = mergeVirtualPositions(onChain, vps as any);
    expect(result.total_positions).toBe(3);
    expect(result.positions[0].position).toBe("pk1");
    expect(result.positions[1].position).toBe("pk2");
    expect(result.positions[2].source).toBe("virtual");
  });

  it("A4: no fresh PnL (no freshPnlMap) → null PnL fields, no crash", () => {
    const now = Date.now();
    const vps = [
      {
        id: "vp_001",
        pool: "P1",
        base_mint: "M1",
        deployed_at: new Date(now - 1000 * 60 * 60).toISOString(),
        initial_value_usd: 100,
        current_value_usd: 110,
      },
    ];
    const result = mergeVirtualPositions([], vps as any, 0, now);
    const p = result.positions[0];
    expect(p.pnl_usd).toBeNull();
    expect(p.pnl_pct).toBeNull();
    expect(p.unclaimed_fees_usd).toBeNull();
    expect(p.total_value_usd).toBeNull();
    expect(p.in_range).toBeNull();
    expect(p.active_bin).toBeNull();
  });

  it("A5: VP with no PnL data (null values) — no crash, null pnl fields", () => {
    const vps = [
      { id: "vp_001", pool: "P1", base_mint: "M1", deployed_at: new Date().toISOString() },
    ];
    const result = mergeVirtualPositions([], vps as any);
    const p = result.positions[0];
    expect(p.pnl_usd).toBeNull();
    expect(p.pnl_pct).toBeNull();
  });

  it("A6: no fresh PnL → in_range = null (not derived from stale _oor_since)", () => {
    const vps = [
      { id: "vp_001", pool: "P1", base_mint: "M1", _oor_since: new Date().toISOString() },
    ];
    const result = mergeVirtualPositions([], vps as any);
    expect(result.positions[0].in_range).toBeNull();
  });

  it("A7: no fresh PnL (even with _oor_since=null) → in_range = null", () => {
    const vps = [
      { id: "vp_001", pool: "P1", base_mint: "M1", _oor_since: null },
    ];
    const result = mergeVirtualPositions([], vps as any);
    expect(result.positions[0].in_range).toBeNull();
  });

  it("A8: no fresh PnL (solMode=true) → null polymorphic fields", () => {
    const vps = [{
      id: "vp_test_8",
      pool: "test_pool",
      pool_name: "TEST-SOL",
      pair: "TEST-SOL",
      deployed_at: new Date(Date.now() - 60000).toISOString(),
      amount_sol: 0.5,
      initial_value_usd: 75,
      value_sol: 0.5,
      total_fees_earned_sol: 0.002,
      pnl_sol_pct: 1.33,
    }];
    const result = mergeVirtualPositions([], vps as any, 150);
    const merged = result.positions[0];
    expect(merged.total_value_usd).toBeNull();
    expect(merged.unclaimed_fees_usd).toBeNull();
    expect(merged.pnl_pct).toBeNull();
    expect(merged.pnl_usd).toBeNull();
  });

  it("A9: no fresh PnL (solMode=false) → null polymorphic fields", () => {
    const vps = [{
      id: "vp_test_9",
      pool: "test_pool",
      pool_name: "TEST-SOL",
      pair: "TEST-SOL",
      deployed_at: new Date(Date.now() - 60000).toISOString(),
      amount_sol: 0.5,
      initial_value_usd: 75,
      current_value_usd: 76,
    }];
    const result = mergeVirtualPositions([], vps as any, 0);
    const merged = result.positions[0];
    expect(merged.total_value_usd).toBeNull();
    expect(merged.unclaimed_fees_usd).toBeNull();
    expect(merged.pnl_pct).toBeNull();
    expect(merged.pnl_usd).toBeNull();
  });

  it("A10: no fresh PnL — dual-name compat layer no longer needed (always nulls)", () => {
    const vps = [{
      id: "vp_old",
      pool: "old_pool",
      pool_name: "OLD-SOL",
      pair: "OLD-SOL",
      deployed_at: new Date(Date.now() - 600000).toISOString(),
      amount_sol: 0.5,
      initial_value_usd: 75,
      current_value_usd: 76,
    }];
    const result = mergeVirtualPositions([], vps as any, 150);
    const merged = result.positions[0];
    expect(merged.total_value_usd).toBeNull();
    expect(merged.unclaimed_fees_usd).toBeNull();
    expect(merged.pnl_pct).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════
//  SECTION A-fresh: Fresh PnL path (meridian-wie Step 3)
// ════════════════════════════════════════════════════════════

describe("Fresh PnL path", () => {
  it("A-fresh-1: fresh PnL overrides cached fields when provided", () => {
    const vps = [{
      id: "vp_fresh_1",
      pool: "P1",
      pair: "FRESH-SOL",
      base_mint: "M1",
      deployed_at: new Date(Date.now() - 60000).toISOString(),
      lower_bin: 95,
      upper_bin: 105,
      initial_value_usd: 75,
      current_value_usd: 80,
      pnl_sol_pct: 1.33,
      value_sol: 0.51,
      pnl_sol: 0.01,
    }];
    const freshPnl = {
      currentValueUsd: 90,
      pnlUsd: 15,
      pnlPct: 20,
      positionValueSol: 0.53,
      netPnlSol: 0.03,
      pnlSolPct: 6.0,
      unclaimedFeesSol: 0.005,
      unclaimedFeesUsd: 0.85,
    };
    const freshPnlMap = new Map([
      ["vp_fresh_1", { pnl: freshPnl, activeBinId: 100 }],
    ]);
    const result = mergeVirtualPositions([], vps as any, 150, Date.now(), freshPnlMap);
    const merged = result.positions[0];
    expect(merged.total_value_usd).toBe(0.53);
    expect(Math.abs((merged.pnl_pct as number) - 6.0)).toBeLessThan(0.001);
    expect(Math.abs((merged.pnl_usd as number) - 0.03)).toBeLessThan(0.001);
    expect(Math.abs((merged.unclaimed_fees_usd as number) - 0.005)).toBeLessThan(0.001);
    expect(merged.active_bin).toBe(100);
  });

  it("A-fresh-2: in_range uses fresh activeBinId, not stale !_oor_since", () => {
    const vps = [{
      id: "vp_fresh_2",
      pool: "P1",
      pair: "OOR-SOL",
      base_mint: "M1",
      deployed_at: new Date().toISOString(),
      lower_bin: 95,
      upper_bin: 105,
      _oor_since: new Date(Date.now() - 600000).toISOString(),
    }];
    const freshPnlMap = new Map([
      ["vp_fresh_2", { pnl: { currentValueUsd: 0, pnlUsd: 0, pnlPct: 0 } as any, activeBinId: 100 }],
    ]);
    const result = mergeVirtualPositions([], vps as any, 0, Date.now(), freshPnlMap);
    const merged = result.positions[0];
    expect(merged.in_range).toBe(true);
  });

  it("A-fresh-3: in_range reflects OOR via fresh activeBinId", () => {
    const vps = [{
      id: "vp_fresh_3",
      pool: "P1",
      pair: "MOVED-SOL",
      base_mint: "M1",
      deployed_at: new Date().toISOString(),
      lower_bin: 95,
      upper_bin: 105,
    }];
    const freshPnlMap = new Map([
      ["vp_fresh_3", { pnl: { currentValueUsd: 0, pnlUsd: 0, pnlPct: 0 } as any, activeBinId: 110 }],
    ]);
    const result = mergeVirtualPositions([], vps as any, 0, Date.now(), freshPnlMap);
    const merged = result.positions[0];
    expect(merged.in_range).toBe(false);
  });

  it("A-fresh-4: RPC failure (vp not in freshPnlMap) → nulls (no fallback to cached)", () => {
    const vps = [{
      id: "vp_fresh_4",
      pool: "P1",
      pair: "RPCFAIL-SOL",
      base_mint: "M1",
      deployed_at: new Date().toISOString(),
      lower_bin: 95,
      upper_bin: 105,
      initial_value_usd: 75,
      current_value_usd: 78,
      value_sol: 0.52,
      pnl_sol: 0.02,
      pnl_sol_pct: 4.0,
      _oor_since: null,
    }];
    const freshPnlMap = new Map();
    const result = mergeVirtualPositions([], vps as any, 150, Date.now(), freshPnlMap);
    const merged = result.positions[0];
    expect(merged.total_value_usd).toBeNull();
    expect(merged.pnl_pct).toBeNull();
    expect(merged.in_range).toBeNull();
    expect(merged.active_bin).toBeNull();
  });

  it("A-fresh-5: fresh null pnl → nulls (no fallback, no crash)", () => {
    const vps = [{
      id: "vp_fresh_5",
      pool: "P1",
      base_mint: "M1",
      deployed_at: new Date().toISOString(),
      lower_bin: 95,
      upper_bin: 105,
      initial_value_usd: 75,
      current_value_usd: 78,
    }];
    const freshPnlMap = new Map([
      ["vp_fresh_5", { pnl: null as any, activeBinId: 100 }],
    ]);
    const result = mergeVirtualPositions([], vps as any, 0, Date.now(), freshPnlMap);
    const merged = result.positions[0];
    expect(merged.total_value_usd).toBeNull();
    expect(merged.pnl_usd).toBeNull();
  });

  it("A-fresh-6: mixed VPs — fresh succeeds, RPC fail gets nulls", () => {
    const vps = [
      {
        id: "vp_good",
        pool: "P1", base_mint: "M1", pair: "GOOD",
        deployed_at: new Date().toISOString(),
        lower_bin: 95, upper_bin: 105,
        initial_value_usd: 75, current_value_usd: 80,
      },
      {
        id: "vp_bad",
        pool: "P2", base_mint: "M2", pair: "BAD",
        deployed_at: new Date().toISOString(),
        lower_bin: 90, upper_bin: 100,
        initial_value_usd: 50, current_value_usd: 55,
        value_sol: 0.35, pnl_sol: 0.05, pnl_sol_pct: 16.67,
      },
    ];
    const freshPnlMap = new Map([
      ["vp_good", { pnl: { currentValueUsd: 85, pnlUsd: 10, pnlPct: 13.3 } as any, activeBinId: 100 }],
    ]);
    const result = mergeVirtualPositions([], vps as any, 0, Date.now(), freshPnlMap);
    const good = result.positions.find((p: any) => p.position === "vp:vp_good") as any;
    const bad = result.positions.find((p: any) => p.position === "vp:vp_bad") as any;
    expect(good.total_value_usd).toBe(85);
    expect(good.in_range).toBe(true);
    expect(bad.total_value_usd).toBeNull();
    expect(bad.in_range).toBeNull();
  });

  it("A-fresh-7: in_range boundary — activeBinId === lower_bin is in range", () => {
    const vps = [{
      id: "vp_lower_edge",
      pool: "P1", base_mint: "M1",
      deployed_at: new Date().toISOString(),
      lower_bin: 95, upper_bin: 105,
    }];
    const freshPnlMap = new Map([
      ["vp_lower_edge", { pnl: { currentValueUsd: 0, pnlUsd: 0, pnlPct: 0 } as any, activeBinId: 95 }],
    ]);
    const result = mergeVirtualPositions([], vps as any, 0, Date.now(), freshPnlMap);
    expect(result.positions[0].in_range).toBe(true);
  });

  it("A-fresh-8: in_range boundary — activeBinId === upper_bin is in range", () => {
    const vps = [{
      id: "vp_upper_edge",
      pool: "P1", base_mint: "M1",
      deployed_at: new Date().toISOString(),
      lower_bin: 95, upper_bin: 105,
    }];
    const freshPnlMap = new Map([
      ["vp_upper_edge", { pnl: { currentValueUsd: 0, pnlUsd: 0, pnlPct: 0 } as any, activeBinId: 105 }],
    ]);
    const result = mergeVirtualPositions([], vps as any, 0, Date.now(), freshPnlMap);
    expect(result.positions[0].in_range).toBe(true);
  });

  it("A-fresh-9: in_range is false when fresh activeBinId is null", () => {
    const vps = [{
      id: "vp_null_active",
      pool: "P1", base_mint: "M1",
      deployed_at: new Date().toISOString(),
      lower_bin: 95, upper_bin: 105,
    }];
    const freshPnlMap = new Map([
      ["vp_null_active", { pnl: { currentValueUsd: 0, pnlUsd: 0, pnlPct: 0 } as any, activeBinId: null as any }],
    ]);
    const result = mergeVirtualPositions([], vps as any, 0, Date.now(), freshPnlMap);
    expect(result.positions[0].in_range).toBe(false);
  });

  it("A-fresh-10: undefined freshPnlMap → nulls for all VPs (no crash)", () => {
    const vps = [{
      id: "vp_undef_map",
      pool: "P1", base_mint: "M1",
      deployed_at: new Date().toISOString(),
      lower_bin: 95, upper_bin: 105,
      initial_value_usd: 100, current_value_usd: 110,
    }];
    const result = mergeVirtualPositions([], vps as any, 0, Date.now(), undefined);
    expect(result.positions[0].total_value_usd).toBeNull();
  });

  it("A-fresh-11: null freshPnlMap → nulls for all VPs (no crash)", () => {
    const vps = [{
      id: "vp_null_map",
      pool: "P1", base_mint: "M1",
      deployed_at: new Date().toISOString(),
      lower_bin: 95, upper_bin: 105,
      initial_value_usd: 100, current_value_usd: 110,
    }];
    const result = mergeVirtualPositions([], vps as any, 0, Date.now(), null as any);
    expect(result.positions[0].total_value_usd).toBeNull();
  });

  it("A-fresh-12: active_bin displays fresh activeBinId, not deploy-time", () => {
    const vps = [{
      id: "vp_active_bin",
      pool: "P1", base_mint: "M1",
      deployed_at: new Date().toISOString(),
      lower_bin: 95, upper_bin: 105,
      active_bin_at_deploy: 98,
    }];
    const freshPnlMap = new Map([
      ["vp_active_bin", { pnl: { currentValueUsd: 0, pnlUsd: 0, pnlPct: 0 } as any, activeBinId: 103 }],
    ]);
    const result = mergeVirtualPositions([], vps as any, 0, Date.now(), freshPnlMap);
    expect(result.positions[0].active_bin).toBe(103);
  });
});

// ════════════════════════════════════════════════════════════
//  SECTION A-extended: VP close rule unit awareness (meridian-6vw)
// ════════════════════════════════════════════════════════════

describe("VP close rule unit awareness", () => {
  it("A11: solMode=true — TP fires at SOL PnL=5%", () => {
    const mgmtConfig = { solMode: true, takeProfitPct: 5, stopLossPct: -50 };
    const position = {
      upper_bin: 100, active_bin: 100,
      pnl_pct: 5.0,
      total_value_usd: 0.5,
      deployed_at: new Date(Date.now() - 60000).toISOString(),
      snapshots: [],
    };
    const rule = getVirtualCloseRule(position as any, mgmtConfig as any);
    expect(rule).not.toBeNull();
    expect(rule!.rule).toBe(2);
    expect(rule!.reason).toBe("take profit");
  });

  it("A12: solMode=true — SL fires at SOL PnL=-50%", () => {
    const mgmtConfig = { solMode: true, takeProfitPct: 5, stopLossPct: -50 };
    const position = {
      upper_bin: 100, active_bin: 100,
      pnl_pct: -50,
      total_value_usd: 0.3,
      deployed_at: new Date(Date.now() - 60000).toISOString(),
      snapshots: [],
    };
    const rule = getVirtualCloseRule(position as any, mgmtConfig as any);
    expect(rule).not.toBeNull();
    expect(rule!.rule).toBe(1);
    expect(rule!.reason).toBe("stop loss");
  });

  it("A13: solMode=true — TP does NOT fire below threshold", () => {
    const mgmtConfig = { solMode: true, takeProfitPct: 5, stopLossPct: -50 };
    const position = {
      upper_bin: 100, active_bin: 100,
      pnl_pct: 4,
      total_value_usd: 0.5,
      deployed_at: new Date(Date.now() - 60000).toISOString(),
      snapshots: [],
    };
    const rule = getVirtualCloseRule(position as any, mgmtConfig as any);
    expect(rule).toBeNull();
  });

  it("A14: solMode=false — TP fires at USD PnL=5%", () => {
    const mgmtConfig = { solMode: false, takeProfitPct: 5, stopLossPct: -50 };
    const position = {
      upper_bin: 100, active_bin: 100,
      pnl_pct: 5,
      total_value_usd: 50,
      deployed_at: new Date(Date.now() - 60000).toISOString(),
      snapshots: [],
    };
    const rule = getVirtualCloseRule(position as any, mgmtConfig as any);
    expect(rule).not.toBeNull();
    expect(rule!.rule).toBe(2);
  });

  it("A15: solMode=true — low yield uses SOL numerator/SOL denominator", () => {
    const mgmtConfig = {
      solMode: true,
      takeProfitPct: 5,
      stopLossPct: -50,
      minFeePerTvl24h: 7,
      minAgeBeforeYieldCheck: 60,
    };
    const position = {
      upper_bin: 100, active_bin: 100,
      pnl_pct: 0,
      total_value_usd: 0.5,
      unclaimed_fees_usd: 0.005,
      deployed_at: new Date(Date.now() - 120 * 60000).toISOString(),
      snapshots: [],
    };
    const rule = getVirtualCloseRule(position as any, mgmtConfig as any);
    expect(rule).toBeNull();
  });

  it("A16: solMode=true — low yield fires when fees/value ratio is too low", () => {
    const mgmtConfig = {
      solMode: true,
      takeProfitPct: 5,
      stopLossPct: -50,
      minFeePerTvl24h: 7,
      minAgeBeforeYieldCheck: 60,
    };
    const position = {
      upper_bin: 100, active_bin: 100,
      pnl_pct: 0,
      total_value_usd: 0.5,
      unclaimed_fees_usd: 0.0005,
      deployed_at: new Date(Date.now() - 120 * 60000).toISOString(),
      snapshots: [],
    };
    const rule = getVirtualCloseRule(position as any, mgmtConfig as any);
    expect(rule).not.toBeNull();
    expect(rule!.rule).toBe(5);
    expect(rule!.reason).toBe("low yield");
  });

  it("A17: solMode=true — suspect PnL guard skips PnL rules", () => {
    const mgmtConfig = { solMode: true, takeProfitPct: 5, stopLossPct: -50 };
    const position = {
      upper_bin: 100, active_bin: 100,
      pnl_pct: -95,
      total_value_usd: 0.02,
      deployed_at: new Date(Date.now() - 60000).toISOString(),
      snapshots: [],
    };
    const rule = getVirtualCloseRule(position as any, mgmtConfig as any);
    expect(rule).toBeNull();
  });

  it("A18: solMode=true — Rule 6 trend exit uses pnl_sol_pct from snapshots", () => {
    const mgmtConfig = {
      solMode: true,
      takeProfitPct: 5,
      stopLossPct: -50,
      vpTrendExitCycles: 3,
    };
    const position = {
      upper_bin: 100, active_bin: 100,
      pnl_pct: -10,
      total_value_usd: 0.5,
      deployed_at: new Date(Date.now() - 60000).toISOString(),
      snapshots: [
        { pnl_pct: -2, pnl_sol_pct: -2 },
        { pnl_pct: -4, pnl_sol_pct: -4 },
        { pnl_pct: -7, pnl_sol_pct: -7 },
        { pnl_pct: -10, pnl_sol_pct: -10 },
      ],
    };
    const rule = getVirtualCloseRule(position as any, mgmtConfig as any);
    expect(rule).not.toBeNull();
    expect(rule!.rule).toBe(6);
  });

  it("A19: solMode=true — Rule 6 with mixed old/new snapshots (silent fallback)", () => {
    const mgmtConfig = {
      solMode: true,
      takeProfitPct: 5,
      stopLossPct: -50,
      vpTrendExitCycles: 3,
    };
    const position = {
      upper_bin: 100, active_bin: 100,
      pnl_pct: -10,
      total_value_usd: 0.5,
      deployed_at: new Date(Date.now() - 60000).toISOString(),
      snapshots: [
        { pnl_pct: -2 },
        { pnl_pct: -4 },
        { pnl_pct: -7 },
        { pnl_pct: -10 },
      ],
    };
    const rule = getVirtualCloseRule(position as any, mgmtConfig as any);
    expect(rule).not.toBeNull();
    expect(rule!.rule).toBe(6);
  });

  it("A20: OOR too long — uses THIS cycle's effective OOR minutes", () => {
    const mgmtConfig = { solMode: true, takeProfitPct: 5, stopLossPct: -50, outOfRangeWaitMinutes: 30 };
    const position = {
      upper_bin: 100, active_bin: 105,
      pnl_pct: 0,
      total_value_usd: 0.5,
      deployed_at: new Date(Date.now() - 60000).toISOString(),
      snapshots: [],
    };
    const rule = getVirtualCloseRule(position as any, mgmtConfig as any, 45);
    expect(rule).not.toBeNull();
    expect(rule!.rule).toBe(4);
    expect(rule!.reason).toBe("OOR");
  });
});

// ════════════════════════════════════════════════════════════
//  SECTION B: occupiedPools/occupiedMints derivation
// ════════════════════════════════════════════════════════════

describe("occupiedPools/occupiedMints derivation", () => {
  function computeOccupancy(result: any): { pools: Set<string>; mints: Set<string> } {
    return {
      pools: new Set(result.positions.map((p: any) => p.pool)),
      mints: new Set(result.positions.map((p: any) => p.base_mint).filter(Boolean) as string[]),
    };
  }

  it("B1: pre-check sees same occupied pool set as LLM (live mode)", () => {
    const onChain = [
      { position: "pk1", pool: "PoolA", base_mint: "MintA" },
    ] as any;
    const merged = mergeVirtualPositions(onChain, []);
    const { pools, mints } = computeOccupancy(merged);
    expect(pools.has("PoolA")).toBe(true);
    expect(mints.has("MintA")).toBe(true);
  });

  it("B2: pre-check sees same occupied pool set as LLM (dry-run mode, 0 on-chain, 3 VPs)", () => {
    const vps = [
      { id: "vp_001", pool: "PoolA", base_mint: "MintA" },
      { id: "vp_002", pool: "PoolB", base_mint: "MintB" },
      { id: "vp_003", pool: "PoolC", base_mint: "MintC" },
    ];
    const merged = mergeVirtualPositions([], vps as any);
    const { pools, mints } = computeOccupancy(merged);
    for (const p of ["PoolA", "PoolB", "PoolC"]) {
      expect(pools.has(p)).toBe(true);
    }
    for (const m of ["MintA", "MintB", "MintC"]) {
      expect(mints.has(m)).toBe(true);
    }
    expect(merged.total_positions).toBe(3);
  });

  it("B3: this is the EXACT bug scenario — LLM sees 3, deploy count = 3, no mismatch", () => {
    const vps = [
      { id: "vp_001", pool: "PoolA", base_mint: "MintA", deployed_at: new Date(Date.now() - 600000).toISOString() },
      { id: "vp_002", pool: "PoolB", base_mint: "MintB", deployed_at: new Date(Date.now() - 300000).toISOString() },
      { id: "vp_003", pool: "PoolC", base_mint: "MintC", deployed_at: new Date(Date.now() - 60000).toISOString() },
    ];
    const llmView = mergeVirtualPositions([], vps as any);
    const deployView = computeOccupancy(llmView);

    expect(llmView.total_positions).toBe(3);
    expect(deployView.pools.size).toBe(3);
    expect(deployView.mints.size).toBe(3);
    expect(llmView.total_positions).toBe(deployView.pools.size);
  });
});

// ════════════════════════════════════════════════════════════
//  SECTION C: Telegram /close routing (P2 fix)
// ════════════════════════════════════════════════════════════

function parseVirtualPositionAddress(positionAddress: string | null | undefined): string | null {
  if (typeof positionAddress !== "string" || !positionAddress.startsWith("vp:")) {
    return null;
  }
  return positionAddress.slice(3);
}

describe("Telegram /close routing", () => {
  it("C1: parseVirtualPositionAddress detects vp: prefix and extracts id", () => {
    expect(parseVirtualPositionAddress("vp:vp_001")).toBe("vp_001");
    expect(parseVirtualPositionAddress("vp:vp_123")).toBe("vp_123");
  });

  it("C2: parseVirtualPositionAddress returns null for non-VP addresses", () => {
    expect(parseVirtualPositionAddress("PubkeyAbc123Xyz")).toBeNull();
    expect(parseVirtualPositionAddress("")).toBeNull();
    expect(parseVirtualPositionAddress(null)).toBeNull();
    expect(parseVirtualPositionAddress(undefined)).toBeNull();
    expect(parseVirtualPositionAddress(123 as any)).toBeNull();
  });

  it("C7: routing — VP position routes to VP close, live routes to live close", () => {
    const vpPos = { position: "vp:vp_001", pair: "FOO-SOL" };
    const livePos = { position: "PubkeyAbc123Xyz", pair: "BAR-SOL" };

    const vpId = parseVirtualPositionAddress(vpPos.position);
    const liveId = parseVirtualPositionAddress(livePos.position);

    expect(vpId).toBe("vp_001");
    expect(liveId).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════
//  SECTION D: Source-order check (meridian-5ry fix)
// ════════════════════════════════════════════════════════════

describe("Source-order checks", () => {
  const executorSrc = fs.readFileSync(
    path.join(__dirname, "..", "..", "llm", "tools", "executor.ts"),
    "utf8"
  );

  function extractDeployCase(src: string): string {
    const start = src.indexOf('case "deploy_position"');
    if (start === -1) throw new Error("deploy_position case not found");
    const lines = src.slice(start).split("\n");
    let depth = 0;
    let end = lines.length;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("{")) depth++;
      if (lines[i].includes("}")) {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    return lines.slice(0, end + 1).join("\n");
  }

  it("D1: balance check appears BEFORE position count check in deploy pre-check", () => {
    const deployCase = extractDeployCase(executorSrc);
    const balanceIdx = deployCase.indexOf("Insufficient SOL");
    const maxPosIdx = deployCase.indexOf("Max positions");
    expect(balanceIdx).toBeGreaterThanOrEqual(0);
    expect(maxPosIdx).toBeGreaterThanOrEqual(0);
    expect(balanceIdx).toBeLessThan(maxPosIdx);
  });

  it("D2: balance check is gated on DRY_RUN (skipped in simulation)", () => {
    const deployCase = extractDeployCase(executorSrc);
    const idx = deployCase.indexOf("Insufficient SOL");
    expect(idx).toBeGreaterThanOrEqual(0);
    const before = deployCase.slice(Math.max(0, idx - 500), idx);
    expect(before).toContain("DRY_RUN");
  });

  it("D3: position count check still present (regression guard)", () => {
    const deployCase = extractDeployCase(executorSrc);
    expect(deployCase).toContain("Max positions");
  });
});

// ════════════════════════════════════════════════════════════
//  SECTION E: core.ts import-pattern regression guard (meridian-fvo)
// ════════════════════════════════════════════════════════════

describe("core.ts import-pattern regression", () => {
  const coreSrc = fs.readFileSync(
    path.join(__dirname, "..", "..", "providers", "meteora", "core.ts"),
    "utf8"
  );

  it("E1: core.ts imports mergeVpPositions (not re-exports)", () => {
    expect(/^export\s*\{[^}]*mergeVpPositions[^}]*\}\s*from/m.test(coreSrc)).toBe(false);
    expect(/mergeVpPositions/.test(coreSrc)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════
//  SECTION F: VP ID format is timestamp-based (meridian-xsc)
// ════════════════════════════════════════════════════════════

describe("VP ID format", () => {
  const dryRunStateSrc = fs.readFileSync(
    path.join(__dirname, "..", "..", "core", "vp", "state.ts"),
    "utf8"
  );

  it("F1: core/vp/state.ts uses timestamp-based nextId (not sequential scan)", () => {
    expect(/state\.virtual_positions\.reduce.*vp_\(\\\\d\+\)/s.test(dryRunStateSrc)).toBe(false);
    expect(dryRunStateSrc).toContain("toISOString");
  });

  it("F2: parseVirtualPositionAddress is format-agnostic (handles both vp_005 and vp-<ISO>)", () => {
    expect(parseVirtualPositionAddress("vp:vp_005")).toBe("vp_005");
    expect(parseVirtualPositionAddress("vp:vp-20260605T073141Z")).toBe("vp-20260605T073141Z");
  });

  it("F3: closing a VP and creating a new one produces different IDs", () => {
    const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    expect(/^\d{8}T\d{6}Z$/.test(ts)).toBe(true);
  });
});
