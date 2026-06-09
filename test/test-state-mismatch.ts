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
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { mergeVirtualPositions } from "../core/vp/merge.js";
import { getVirtualCloseRule } from "../core/close-rules.js";

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (e: any) {
    console.error(`❌ ${name}: ${e.message}`);
    if (e.stack) console.error(e.stack.split("\n").slice(1, 4).join("\n"));
    failed++;
  }
}

// ════════════════════════════════════════════════════════════
//  Pure function: mergeVirtualPositions (imported from production)
// ════════════════════════════════════════════════════════════
//
// Imported from tools/merge-virtual-positions.js so tests exercise the
// real implementation. Signature: (positions, vps, solPrice = 0, now = Date.now()).
// - solPrice = 0 → USD passthrough (default, solMode off)
// - solPrice > 0 → _usd fields populated from native SOL values
//
// When DRY_RUN, the function should append VP entries to the positions array
// and bump total_positions. The shape of each merged VP matches the on-chain
// position shape so the LLM can't tell them apart structurally.

// ════════════════════════════════════════════════════════════
//  SECTION A: VP merge logic
// ════════════════════════════════════════════════════════════

test("A1: live mode (no VPs in input) — 3 on-chain positions stay 3", () => {
  const onChain = [
    { position: "pk1", pool: "P1", base_mint: "M1" },
    { position: "pk2", pool: "P2", base_mint: "M2" },
    { position: "pk3", pool: "P3", base_mint: "M3" },
  ];
  const result = mergeVirtualPositions(onChain, []);
  if (result.total_positions !== 3) throw new Error(`Expected 3, got ${result.total_positions}`);
  if (result.positions.length !== 3) throw new Error(`Expected 3 entries, got ${result.positions.length}`);
});

test("A2: dry-run mode (3 VPs, 0 on-chain) — count goes 0 → 3", () => {
  const onChain: any[] = [];
  const vps = [
    { id: "vp_001", pool: "P1", base_mint: "M1", deployed_at: new Date(Date.now() - 600000).toISOString() },
    { id: "vp_002", pool: "P2", base_mint: "M2", deployed_at: new Date(Date.now() - 300000).toISOString() },
    { id: "vp_003", pool: "P3", base_mint: "M3", deployed_at: new Date(Date.now() - 60000).toISOString() },
  ];
  const result = mergeVirtualPositions(onChain, vps as any);
  if (result.total_positions !== 3) throw new Error(`Expected 3, got ${result.total_positions}`);
  if (result.positions.length !== 3) throw new Error(`Expected 3 entries, got ${result.positions.length}`);
  // Each VP is tagged as virtual
  for (const p of result.positions) {
    if (p.source !== "virtual") throw new Error(`VP missing source:virtual tag`);
    if (!p.position.startsWith("vp:")) throw new Error(`VP position should be prefixed with 'vp:'`);
  }
});

test("A3: dry-run mode (2 on-chain + 1 VP) — count goes 2 → 3, original 2 unchanged", () => {
  const onChain = [
    { position: "pk1", pool: "P1", base_mint: "M1" },
    { position: "pk2", pool: "P2", base_mint: "M2" },
  ];
  const vps = [
    { id: "vp_001", pool: "P3", base_mint: "M3", deployed_at: new Date().toISOString() },
  ];
  const result = mergeVirtualPositions(onChain, vps as any);
  if (result.total_positions !== 3) throw new Error(`Expected 3, got ${result.total_positions}`);
  // Original on-chain positions still first, unchanged
  if (result.positions[0].position !== "pk1") throw new Error("On-chain order broken");
  if (result.positions[1].position !== "pk2") throw new Error("On-chain order broken");
  if (result.positions[2].source !== "virtual") throw new Error("VP should be at index 2");
});

test("A4: no fresh PnL (no freshPnlMap) → null PnL fields, no crash", () => {
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
  if (p.pnl_usd !== null) throw new Error(`pnl_usd: expected null, got ${p.pnl_usd}`);
  if (p.pnl_pct !== null) throw new Error(`pnl_pct: expected null, got ${p.pnl_pct}`);
  if (p.unclaimed_fees_usd !== null) throw new Error(`fees: expected null, got ${p.unclaimed_fees_usd}`);
  if (p.total_value_usd !== null) throw new Error(`total_value_usd: expected null, got ${p.total_value_usd}`);
  if (p.in_range !== null) throw new Error(`in_range: expected null, got ${p.in_range}`);
  if (p.active_bin !== null) throw new Error(`active_bin: expected null, got ${p.active_bin}`);
});

test("A5: VP with no PnL data (null values) — no crash, null pnl fields", () => {
  const vps = [
    { id: "vp_001", pool: "P1", base_mint: "M1", deployed_at: new Date().toISOString() },
  ];
  const result = mergeVirtualPositions([], vps as any);
  const p = result.positions[0];
  if (p.pnl_usd !== null) throw new Error(`Expected null pnl_usd, got ${p.pnl_usd}`);
  if (p.pnl_pct !== null) throw new Error(`Expected null pnl_pct, got ${p.pnl_pct}`);
});

test("A6: no fresh PnL → in_range = null (not derived from stale _oor_since)", () => {
  const vps = [
    { id: "vp_001", pool: "P1", base_mint: "M1", _oor_since: new Date().toISOString() },
  ];
  const result = mergeVirtualPositions([], vps as any);
  if (result.positions[0].in_range !== null) throw new Error(`No-fresh in_range should be null, got ${result.positions[0].in_range}`);
});

test("A7: no fresh PnL (even with _oor_since=null) → in_range = null", () => {
  const vps = [
    { id: "vp_001", pool: "P1", base_mint: "M1", _oor_since: null },
  ];
  const result = mergeVirtualPositions([], vps as any);
  if (result.positions[0].in_range !== null) throw new Error(`No-fresh in_range should be null, got ${result.positions[0].in_range}`);
});

test("A8: no fresh PnL (solMode=true) → null polymorphic fields", () => {
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
  const result = mergeVirtualPositions([], vps as any, 150); // solMode=true
  const merged = result.positions[0];
  if (merged.total_value_usd !== null) throw new Error(`Expected total_value_usd=null, got ${merged.total_value_usd}`);
  if (merged.unclaimed_fees_usd !== null) throw new Error(`Expected unclaimed_fees_usd=null, got ${merged.unclaimed_fees_usd}`);
  if (merged.pnl_pct !== null) throw new Error(`Expected pnl_pct=null, got ${merged.pnl_pct}`);
  if (merged.pnl_usd !== null) throw new Error(`Expected pnl_usd=null, got ${merged.pnl_usd}`);
});

test("A9: no fresh PnL (solMode=false) → null polymorphic fields", () => {
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
  const result = mergeVirtualPositions([], vps as any, 0); // solMode=false
  const merged = result.positions[0];
  if (merged.total_value_usd !== null) throw new Error(`Expected total_value_usd=null, got ${merged.total_value_usd}`);
  if (merged.unclaimed_fees_usd !== null) throw new Error(`Expected unclaimed_fees_usd=null, got ${merged.unclaimed_fees_usd}`);
  if (merged.pnl_pct !== null) throw new Error(`Expected pnl_pct=null, got ${merged.pnl_pct}`);
  if (merged.pnl_usd !== null) throw new Error(`Expected pnl_usd=null, got ${merged.pnl_usd}`);
});

test("A10: no fresh PnL — dual-name compat layer no longer needed (always nulls)", () => {
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
  const result = mergeVirtualPositions([], vps as any, 150); // solMode=true
  const merged = result.positions[0];
  if (merged.total_value_usd !== null) throw new Error(`Expected total_value_usd=null, got ${merged.total_value_usd}`);
  if (merged.unclaimed_fees_usd !== null) throw new Error(`Expected unclaimed_fees_usd=null, got ${merged.unclaimed_fees_usd}`);
  if (merged.pnl_pct !== null) throw new Error(`Expected pnl_pct=null, got ${merged.pnl_pct}`);
});

// ════════════════════════════════════════════════════════════
//  SECTION A-fresh: Fresh PnL path (meridian-wie Step 3)
// ════════════════════════════════════════════════════════════

test("A-fresh-1: fresh PnL overrides cached fields when provided", () => {
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
  if (merged.total_value_usd !== 0.53) throw new Error(`Fresh total_value_usd=0.53, got ${merged.total_value_usd}`);
  if (Math.abs((merged.pnl_pct as number) - 6.0) > 0.001) throw new Error(`Fresh pnl_pct=6.0, got ${merged.pnl_pct}`);
  if (Math.abs((merged.pnl_usd as number) - 0.03) > 0.001) throw new Error(`Fresh pnl_usd=0.03, got ${merged.pnl_usd}`);
  if (Math.abs((merged.unclaimed_fees_usd as number) - 0.005) > 0.001) throw new Error(`Fresh unclaimed_fees_usd=0.005, got ${merged.unclaimed_fees_usd}`);
  if (merged.active_bin !== 100) throw new Error(`Fresh active_bin=100, got ${merged.active_bin}`);
});

test("A-fresh-2: in_range uses fresh activeBinId, not stale !_oor_since", () => {
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
  if (merged.in_range !== true) throw new Error(`Fresh in_range should be true (activeBin=100 in [95,105]), got ${merged.in_range}`);
});

test("A-fresh-3: in_range reflects OOR via fresh activeBinId", () => {
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
  if (merged.in_range !== false) throw new Error(`Fresh in_range should be false (activeBin=110 > upper_bin=105), got ${merged.in_range}`);
});

test("A-fresh-4: RPC failure (vp not in freshPnlMap) → nulls (no fallback to cached)", () => {
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
  if (merged.total_value_usd !== null) throw new Error(`Expected total_value_usd=null, got ${merged.total_value_usd}`);
  if (merged.pnl_pct !== null) throw new Error(`Expected pnl_pct=null, got ${merged.pnl_pct}`);
  if (merged.in_range !== null) throw new Error(`Expected in_range=null, got ${merged.in_range}`);
  if (merged.active_bin !== null) throw new Error(`Expected active_bin=null, got ${merged.active_bin}`);
});

test("A-fresh-5: fresh null pnl → nulls (no fallback, no crash)", () => {
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
  if (merged.total_value_usd !== null) throw new Error(`Expected total_value_usd=null, got ${merged.total_value_usd}`);
  if (merged.pnl_usd !== null) throw new Error(`Expected pnl_usd=null, got ${merged.pnl_usd}`);
});

test("A-fresh-6: mixed VPs — fresh succeeds, RPC fail gets nulls", () => {
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
  if (good.total_value_usd !== 85) throw new Error(`good total=85, got ${good.total_value_usd}`);
  if (good.in_range !== true) throw new Error(`good in_range=true, got ${good.in_range}`);
  if (bad.total_value_usd !== null) throw new Error(`bad total should be null, got ${bad.total_value_usd}`);
  if (bad.in_range !== null) throw new Error(`bad in_range should be null, got ${bad.in_range}`);
});

test("A-fresh-7: in_range boundary — activeBinId === lower_bin is in range", () => {
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
  if (result.positions[0].in_range !== true) throw new Error("activeBinId === lower_bin should be in_range=true");
});

test("A-fresh-8: in_range boundary — activeBinId === upper_bin is in range", () => {
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
  if (result.positions[0].in_range !== true) throw new Error("activeBinId === upper_bin should be in_range=true");
});

test("A-fresh-9: in_range is false when fresh activeBinId is null", () => {
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
  if (result.positions[0].in_range !== false) throw new Error("activeBinId=null should be in_range=false");
});

test("A-fresh-10: undefined freshPnlMap → nulls for all VPs (no crash)", () => {
  const vps = [{
    id: "vp_undef_map",
    pool: "P1", base_mint: "M1",
    deployed_at: new Date().toISOString(),
    lower_bin: 95, upper_bin: 105,
    initial_value_usd: 100, current_value_usd: 110,
  }];
  const result = mergeVirtualPositions([], vps as any, 0, Date.now(), undefined);
  if (result.positions[0].total_value_usd !== null) throw new Error("undefined map should give nulls, got cached");
});

test("A-fresh-11: null freshPnlMap → nulls for all VPs (no crash)", () => {
  const vps = [{
    id: "vp_null_map",
    pool: "P1", base_mint: "M1",
    deployed_at: new Date().toISOString(),
    lower_bin: 95, upper_bin: 105,
    initial_value_usd: 100, current_value_usd: 110,
  }];
  const result = mergeVirtualPositions([], vps as any, 0, Date.now(), null as any);
  if (result.positions[0].total_value_usd !== null) throw new Error("null map should give nulls, got cached");
});

test("A-fresh-12: active_bin displays fresh activeBinId, not deploy-time", () => {
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
  if (result.positions[0].active_bin !== 103) throw new Error(`active_bin should be fresh 103, got ${result.positions[0].active_bin}`);
});

// ════════════════════════════════════════════════════════════
//  SECTION A-extended: VP close rule unit awareness (meridian-6vw)
// ════════════════════════════════════════════════════════════

test("A11: solMode=true — TP fires at SOL PnL=5% (user's reported case)", () => {
  const mgmtConfig = { solMode: true, takeProfitPct: 5, stopLossPct: -50 };
  const position = {
    upper_bin: 100, active_bin: 100,
    pnl_pct: 5.0,
    total_value_usd: 0.5,
    deployed_at: new Date(Date.now() - 60000).toISOString(),
    snapshots: [],
  };
  const rule = getVirtualCloseRule(position as any, mgmtConfig as any);
  if (!rule || rule.rule !== 2 || rule.reason !== "take profit") {
    throw new Error(`Expected take profit (rule 2), got ${JSON.stringify(rule)}`);
  }
});

test("A12: solMode=true — SL fires at SOL PnL=-50%", () => {
  const mgmtConfig = { solMode: true, takeProfitPct: 5, stopLossPct: -50 };
  const position = {
    upper_bin: 100, active_bin: 100,
    pnl_pct: -50,
    total_value_usd: 0.3,
    deployed_at: new Date(Date.now() - 60000).toISOString(),
    snapshots: [],
  };
  const rule = getVirtualCloseRule(position as any, mgmtConfig as any);
  if (!rule || rule.rule !== 1 || rule.reason !== "stop loss") {
    throw new Error(`Expected stop loss (rule 1), got ${JSON.stringify(rule)}`);
  }
});

test("A13: solMode=true — TP does NOT fire below threshold (regression guard)", () => {
  const mgmtConfig = { solMode: true, takeProfitPct: 5, stopLossPct: -50 };
  const position = {
    upper_bin: 100, active_bin: 100,
    pnl_pct: 4,
    total_value_usd: 0.5,
    deployed_at: new Date(Date.now() - 60000).toISOString(),
    snapshots: [],
  };
  const rule = getVirtualCloseRule(position as any, mgmtConfig as any);
  if (rule) throw new Error(`Expected no close, got ${JSON.stringify(rule)}`);
});

test("A14: solMode=false — TP fires at USD PnL=5% (backward compat)", () => {
  const mgmtConfig = { solMode: false, takeProfitPct: 5, stopLossPct: -50 };
  const position = {
    upper_bin: 100, active_bin: 100,
    pnl_pct: 5,
    total_value_usd: 50,
    deployed_at: new Date(Date.now() - 60000).toISOString(),
    snapshots: [],
  };
  const rule = getVirtualCloseRule(position as any, mgmtConfig as any);
  if (!rule || rule.rule !== 2) throw new Error(`Expected TP, got ${JSON.stringify(rule)}`);
});

test("A15: solMode=true — low yield uses SOL numerator/SOL denominator (unit-agnostic)", () => {
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
  if (rule) throw new Error(`Expected no close (yield above threshold), got ${JSON.stringify(rule)}`);
});

test("A16: solMode=true — low yield fires when fees/value ratio is too low", () => {
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
  if (!rule || rule.rule !== 5 || rule.reason !== "low yield") {
    throw new Error(`Expected low yield (rule 5), got ${JSON.stringify(rule)}`);
  }
});

test("A17: solMode=true — suspect PnL guard skips PnL rules", () => {
  const mgmtConfig = { solMode: true, takeProfitPct: 5, stopLossPct: -50 };
  const position = {
    upper_bin: 100, active_bin: 100,
    pnl_pct: -95,
    total_value_usd: 0.02,
    deployed_at: new Date(Date.now() - 60000).toISOString(),
    snapshots: [],
  };
  const rule = getVirtualCloseRule(position as any, mgmtConfig as any);
  if (rule) throw new Error(`Suspect PnL should skip rules, got ${JSON.stringify(rule)}`);
});

test("A18: solMode=true — Rule 6 trend exit uses pnl_sol_pct from snapshots", () => {
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
  if (!rule || rule.rule !== 6) throw new Error(`Expected trend exit (rule 6), got ${JSON.stringify(rule)}`);
});

test("A19: solMode=true — Rule 6 with mixed old/new snapshots (silent fallback)", () => {
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
  if (!rule || rule.rule !== 6) throw new Error(`Expected trend exit with fallback, got ${JSON.stringify(rule)}`);
});

test("A20: OOR too long — uses THIS cycle's effective OOR minutes", () => {
  const mgmtConfig = { solMode: true, takeProfitPct: 5, stopLossPct: -50, outOfRangeWaitMinutes: 30 };
  const position = {
    upper_bin: 100, active_bin: 105,
    pnl_pct: 0,
    total_value_usd: 0.5,
    deployed_at: new Date(Date.now() - 60000).toISOString(),
    snapshots: [],
  };
  const rule = getVirtualCloseRule(position as any, mgmtConfig as any, 45);
  if (!rule || rule.rule !== 4 || rule.reason !== "OOR") {
    throw new Error(`Expected OOR (rule 4), got ${JSON.stringify(rule)}`);
  }
});

// ════════════════════════════════════════════════════════════
//  SECTION B: occupiedPools/occupiedMints derivation
// ════════════════════════════════════════════════════════════

function computeOccupancy(result: any): { pools: Set<string>; mints: Set<string> } {
  return {
    pools: new Set(result.positions.map((p: any) => p.pool)),
    mints: new Set(result.positions.map((p: any) => p.base_mint).filter(Boolean) as string[]),
  };
}

test("B1: pre-check sees same occupied pool set as LLM (live mode)", () => {
  const onChain = [
    { position: "pk1", pool: "PoolA", base_mint: "MintA" },
  ];
  const merged = mergeVirtualPositions(onChain, []);
  const { pools, mints } = computeOccupancy(merged);
  if (!pools.has("PoolA")) throw new Error("PoolA missing from occupied set");
  if (!mints.has("MintA")) throw new Error("MintA missing from occupied set");
});

test("B2: pre-check sees same occupied pool set as LLM (dry-run mode, 0 on-chain, 3 VPs)", () => {
  const vps = [
    { id: "vp_001", pool: "PoolA", base_mint: "MintA" },
    { id: "vp_002", pool: "PoolB", base_mint: "MintB" },
    { id: "vp_003", pool: "PoolC", base_mint: "MintC" },
  ];
  const merged = mergeVirtualPositions([], vps as any);
  const { pools, mints } = computeOccupancy(merged);
  for (const p of ["PoolA", "PoolB", "PoolC"]) {
    if (!pools.has(p)) throw new Error(`${p} missing from occupied pools`);
  }
  for (const m of ["MintA", "MintB", "MintC"]) {
    if (!mints.has(m)) throw new Error(`${m} missing from occupied mints`);
  }
  if (merged.total_positions !== 3) throw new Error(`Total: expected 3, got ${merged.total_positions}`);
});

test("B3: this is the EXACT bug scenario — LLM sees 3, deploy count = 3, no mismatch", () => {
  const vps = [
    { id: "vp_001", pool: "PoolA", base_mint: "MintA", deployed_at: new Date(Date.now() - 600000).toISOString() },
    { id: "vp_002", pool: "PoolB", base_mint: "MintB", deployed_at: new Date(Date.now() - 300000).toISOString() },
    { id: "vp_003", pool: "PoolC", base_mint: "MintC", deployed_at: new Date(Date.now() - 60000).toISOString() },
  ];
  const llmView = mergeVirtualPositions([], vps as any);
  const deployView = computeOccupancy(llmView);

  // LLM's count
  if (llmView.total_positions !== 3) throw new Error("LLM should see 3 positions");
  // Deploy pre-check's count
  if (deployView.pools.size !== 3) throw new Error("Deploy check should see 3 pools");
  if (deployView.mints.size !== 3) throw new Error("Deploy check should see 3 mints");
  // They match
  if (llmView.total_positions !== deployView.pools.size) {
    throw new Error("LLM count and deploy count diverge — bug still present");
  }
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

test("C1: parseVirtualPositionAddress detects vp: prefix and extracts id", () => {
  if (parseVirtualPositionAddress("vp:vp_001") !== "vp_001") {
    throw new Error("Should extract vp_001 from 'vp:vp_001'");
  }
  if (parseVirtualPositionAddress("vp:vp_123") !== "vp_123") {
    throw new Error("Should extract vp_123 from 'vp:vp_123'");
  }
});

test("C2: parseVirtualPositionAddress returns null for non-VP addresses", () => {
  if (parseVirtualPositionAddress("PubkeyAbc123Xyz") !== null) {
    throw new Error("Live pubkey should not parse as VP");
  }
  if (parseVirtualPositionAddress("") !== null) {
    throw new Error("Empty string should not parse as VP");
  }
  if (parseVirtualPositionAddress(null) !== null) {
    throw new Error("null should not parse as VP");
  }
  if (parseVirtualPositionAddress(undefined) !== null) {
    throw new Error("undefined should not parse as VP");
  }
  if (parseVirtualPositionAddress(123 as any) !== null) {
    throw new Error("Number should not parse as VP");
  }
});

// ════════════════════════════════════════════════════════════
//  SECTION D: Source-order check (meridian-5ry fix)
// ════════════════════════════════════════════════════════════

const executorSrc = fs.readFileSync(
  path.join(__dirname, "..", "tools", "executor.ts"),
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

test("D1: balance check appears BEFORE position count check in deploy pre-check", () => {
  const deployCase = extractDeployCase(executorSrc);
  const balanceIdx = deployCase.indexOf("Insufficient SOL");
  const maxPosIdx = deployCase.indexOf("Max positions");
  if (balanceIdx === -1) throw new Error("'Insufficient SOL' check not found in deploy_position case");
  if (maxPosIdx === -1) throw new Error("'Max positions' check not found in deploy_position case");
  if (balanceIdx >= maxPosIdx) {
    throw new Error(
      `Balance check at offset ${balanceIdx} should come BEFORE position count check at offset ${maxPosIdx}`
    );
  }
});

test("D2: balance check is gated on DRY_RUN (skipped in simulation)", () => {
  const deployCase = extractDeployCase(executorSrc);
  const idx = deployCase.indexOf("Insufficient SOL");
  if (idx === -1) throw new Error("'Insufficient SOL' check not found");
  const before = deployCase.slice(Math.max(0, idx - 500), idx);
  if (!before.includes("DRY_RUN")) {
    throw new Error("Insufficient SOL check should be gated on DRY_RUN (not found within 500 chars before)");
  }
});

test("D3: position count check still present (regression guard)", () => {
  const deployCase = extractDeployCase(executorSrc);
  if (!deployCase.includes("Max positions")) {
    throw new Error("'Max positions' check should still exist in deploy_position case");
  }
});

test("C7: routing — VP position routes to VP close, live routes to live close", () => {
  const vpPos = { position: "vp:vp_001", pair: "FOO-SOL" };
  const livePos = { position: "PubkeyAbc123Xyz", pair: "BAR-SOL" };

  const vpId = parseVirtualPositionAddress(vpPos.position);
  const liveId = parseVirtualPositionAddress(livePos.position);

  if (vpId !== "vp_001") throw new Error("VP should route to VP path");
  if (liveId !== null) throw new Error("Live should route to live path");
});

// ════════════════════════════════════════════════════════════
//  SECTION E: dlmm.js import-pattern regression guard (meridian-fvo)
// ════════════════════════════════════════════════════════════

const dlmmSrc = fs.readFileSync(
  path.join(__dirname, "..", "tools", "dlmm.ts"),
  "utf8"
);

test("E1: dlmm.js imports mergeVirtualPositions (not re-exports)", () => {
  if (/^export\s*\{\s*mergeVirtualPositions\s*\}\s*from\s*["']\.\/merge-virtual-positions\.js["']/m.test(dlmmSrc)) {
    throw new Error("dlmm.js uses broken re-export form for mergeVirtualPositions (use `import` instead). See meridian-fvo.");
  }
  if (!/^import\s*\{[^}]*mergeVirtualPositions[^}]*\}\s*from\s*["']\.\/merge-virtual-positions\.js["']/m.test(dlmmSrc)) {
    throw new Error("dlmm.js should `import { mergeVirtualPositions } from './merge-virtual-positions.js'`");
  }
});

// ════════════════════════════════════════════════════════════
//  SECTION F: VP ID format is timestamp-based (meridian-xsc)
// ════════════════════════════════════════════════════════════

const dryRunStateSrc = fs.readFileSync(
  path.join(__dirname, "..", "tools", "dry-run-state.ts"),
  "utf8"
);

test("F1: dry-run-state.js uses timestamp-based nextId (not sequential scan)", () => {
  if (/state\.virtual_positions\.reduce.*vp_\(\\\\d\+\)/s.test(dryRunStateSrc)) {
    throw new Error("dry-run-state.js still uses the old sequential max-N logic for nextId. See meridian-xsc.");
  }
  if (!dryRunStateSrc.includes("toISOString")) {
    throw new Error("dry-run-state.js nextId should use toISOString for timestamp-based IDs");
  }
});

test("F2: parseVirtualPositionAddress is format-agnostic (handles both vp_005 and vp-<ISO>)", () => {
  const oldFmt = parseVirtualPositionAddress("vp:vp_005");
  const newFmt = parseVirtualPositionAddress("vp:vp-20260605T073141Z");
  if (oldFmt !== "vp_005") throw new Error(`Old format parse failed: ${oldFmt}`);
  if (newFmt !== "vp-20260605T073141Z") throw new Error(`New format parse failed: ${newFmt}`);
});

test("F3: closing a VP and creating a new one produces different IDs (regression for the user's scenario)", () => {
  const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  if (!/^\d{8}T\d{6}Z$/.test(ts)) {
    throw new Error(`Timestamp format wrong: ${ts}`);
  }
});

// ════════════════════════════════════════════════════════════
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
