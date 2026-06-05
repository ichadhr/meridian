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
import { mergeVirtualPositions } from "../tools/merge-virtual-positions.js";
import { getVirtualCloseRule } from "../tools/virtual-close-rule.js";

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (e) {
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
  const onChain = [];
  const vps = [
    { id: "vp_001", pool: "P1", base_mint: "M1", deployed_at: new Date(Date.now() - 600000).toISOString() },
    { id: "vp_002", pool: "P2", base_mint: "M2", deployed_at: new Date(Date.now() - 300000).toISOString() },
    { id: "vp_003", pool: "P3", base_mint: "M3", deployed_at: new Date(Date.now() - 60000).toISOString() },
  ];
  const result = mergeVirtualPositions(onChain, vps);
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
  const result = mergeVirtualPositions(onChain, vps);
  if (result.total_positions !== 3) throw new Error(`Expected 3, got ${result.total_positions}`);
  // Original on-chain positions still first, unchanged
  if (result.positions[0].position !== "pk1") throw new Error("On-chain order broken");
  if (result.positions[1].position !== "pk2") throw new Error("On-chain order broken");
  if (result.positions[2].source !== "virtual") throw new Error("VP should be at index 2");
});

test("A4: VP PnL math — current vs initial value", () => {
  const now = Date.now();
  const onChain = [];
  const vps = [
    {
      id: "vp_001",
      pool: "P1",
      base_mint: "M1",
      deployed_at: new Date(now - 1000 * 60 * 60).toISOString(),  // 60m ago
      initial_value_usd: 100,
      current_value_usd: 110,
      total_fees_earned_usd: 2.5,
    },
  ];
  const result = mergeVirtualPositions(onChain, vps, 0, now);
  const p = result.positions[0];
  if (Math.abs(p.pnl_usd - 10) > 0.001) throw new Error(`pnl_usd: expected 10, got ${p.pnl_usd}`);
  if (Math.abs(p.pnl_pct - 10) > 0.001) throw new Error(`pnl_pct: expected 10, got ${p.pnl_pct}`);
  if (p.unclaimed_fees_usd !== 2.5) throw new Error(`fees: expected 2.5, got ${p.unclaimed_fees_usd}`);
  if (p.total_value_usd !== 110) throw new Error(`total_value_usd: expected 110, got ${p.total_value_usd}`);
});

test("A5: VP with no PnL data (null values) — no crash, null pnl fields", () => {
  const vps = [
    { id: "vp_001", pool: "P1", base_mint: "M1", deployed_at: new Date().toISOString() },
  ];
  const result = mergeVirtualPositions([], vps);
  const p = result.positions[0];
  if (p.pnl_usd !== null) throw new Error(`Expected null pnl_usd, got ${p.pnl_usd}`);
  if (p.pnl_pct !== null) throw new Error(`Expected null pnl_pct, got ${p.pnl_pct}`);
});

test("A6: VP in_range = false when _oor_since is set", () => {
  const vps = [
    { id: "vp_001", pool: "P1", base_mint: "M1", _oor_since: new Date().toISOString() },
  ];
  const result = mergeVirtualPositions([], vps);
  if (result.positions[0].in_range !== false) throw new Error("OOR VP should be in_range=false");
});

test("A7: VP in_range = true when _oor_since is null", () => {
  const vps = [
    { id: "vp_001", pool: "P1", base_mint: "M1", _oor_since: null },
  ];
  const result = mergeVirtualPositions([], vps);
  if (result.positions[0].in_range !== true) throw new Error("In-range VP should be in_range=true");
});

test("A8: solMode=true — _usd fields populated from native SOL values", () => {
  const vps = [{
    id: "vp_test_8",
    pool: "test_pool",
    pool_name: "TEST-SOL",
    pair: "TEST-SOL",
    deployed_at: new Date(Date.now() - 60000).toISOString(),
    amount_sol: 0.5,
    initial_value_usd: 75,                // 0.5 SOL * $150
    sol_price_at_deploy: 150,
    value_sol: 0.5,                        // seeded at deploy
    total_fees_earned_usd: 0.30,           // $0.30 in fees (USD field, unused in solMode)
    total_fees_earned_sol: 0.002,          // 0.002 SOL in fees
    current_value_usd: 76,
    pnl_usd: 1,                            // USD field, unused in solMode
    pnl_sol: 0.0067,                       // ~0.0067 SOL PnL
    pnl_sol_pct: 1.33,                     // native SOL PnL %
  }];
  const result = mergeVirtualPositions([], vps, 150); // solPrice=150 → solMode=true
  const merged = result.positions[0];
  if (merged.total_value_usd !== 0.5) throw new Error(`Expected total_value_usd=0.5 (SOL), got ${merged.total_value_usd}`);
  if (merged.unclaimed_fees_usd !== 0.002) throw new Error(`Expected unclaimed_fees_usd=0.002 (SOL), got ${merged.unclaimed_fees_usd}`);
  if (Math.abs(merged.pnl_pct - 1.33) > 0.001) throw new Error(`Expected pnl_pct≈1.33, got ${merged.pnl_pct}`);
  if (merged.pnl_usd !== 0.0067) throw new Error(`Expected pnl_usd=0.0067 (SOL), got ${merged.pnl_usd}`);
});

test("A9: solMode=false — _usd fields stay USD (passthrough, default behavior)", () => {
  const vps = [{
    id: "vp_test_9",
    pool: "test_pool",
    pool_name: "TEST-SOL",
    pair: "TEST-SOL",
    deployed_at: new Date(Date.now() - 60000).toISOString(),
    amount_sol: 0.5,
    initial_value_usd: 75,
    current_value_usd: 76,
    total_fees_earned_usd: 0.30,
    // No SOL fields — solMode=false means they're not used anyway
  }];
  const result = mergeVirtualPositions([], vps, 0); // solPrice=0 → solMode=false
  const merged = result.positions[0];
  if (merged.total_value_usd !== 76) throw new Error(`Expected total_value_usd=76 (USD), got ${merged.total_value_usd}`);
  if (merged.unclaimed_fees_usd !== 0.30) throw new Error(`Expected unclaimed_fees_usd=0.30 (USD), got ${merged.unclaimed_fees_usd}`);
  // PnL% still computed from USD
  if (Math.abs(merged.pnl_pct - ((76 / 75 - 1) * 100)) > 0.001) throw new Error(`pnl_pct should be ~1.33%, got ${merged.pnl_pct}`);
});

test("A10: lazy migration — old VP without SOL fields falls back to amount_sol", () => {
  // Simulates an old VP from before the fix (no value_sol, no total_fees_earned_sol).
  // The lazy fallback: value_sol = vp.value_sol ?? vp.amount_sol = 0.5
  const vps = [{
    id: "vp_old",
    pool: "old_pool",
    pool_name: "OLD-SOL",
    pair: "OLD-SOL",
    deployed_at: new Date(Date.now() - 600000).toISOString(), // 10 min ago
    amount_sol: 0.5,
    initial_value_usd: 75,
    current_value_usd: 76,
    total_fees_earned_usd: 0.30,
    // NOTE: no value_sol, no total_fees_earned_sol, no pnl_sol_pct
  }];
  const result = mergeVirtualPositions([], vps, 150); // solMode=true
  const merged = result.positions[0];
  // Lazy fallback: valueSol = vp.value_sol ?? vp.amount_sol = 0.5
  if (merged.total_value_usd !== 0.5) throw new Error(`Expected lazy fallback total_value_usd=0.5, got ${merged.total_value_usd}`);
  // No SOL field → no fallback → 0 (feesSol defaults to 0 when missing)
  if (merged.unclaimed_fees_usd !== 0) throw new Error(`Expected unclaimed_fees_usd=0 (no fallback), got ${merged.unclaimed_fees_usd}`);
  // pnl_pct comes from pnl_sol_pct which is null/missing → 0
  if (merged.pnl_pct !== 0) throw new Error(`Expected pnl_pct=0 (no SOL fallback), got ${merged.pnl_pct}`);
});

// ════════════════════════════════════════════════════════════
//  SECTION A-extended: VP close rule unit awareness (meridian-6vw)
// ════════════════════════════════════════════════════════════
//
// getVirtualCloseRule reads polymorphic values from `position` (SOL when
// solMode=true, USD when false). The caller in runVirtualManagementCycle
// is responsible for selecting the unit. These tests verify the function
// responds correctly to the unit the caller passed in.

test("A11: solMode=true — TP fires at SOL PnL=5% (user's reported case)", () => {
  // Mirrors the real cycle: caller passes SOL PnL in pnl_pct when solMode=true.
  const mgmtConfig = { solMode: true, takeProfitPct: 5, stopLossPct: -50 };
  const position = {
    upper_bin: 100, active_bin: 100,                  // not OOR
    pnl_pct: 5.0,                                      // SOL PnL %
    total_value_usd: 0.5,                              // SOL value
    total_fees_earned_usd: 0.001,                      // SOL fees
    deployed_at: new Date(Date.now() - 60000).toISOString(), // 1 min old (no Rule 5 trigger)
    snapshots: [],
  };
  const rule = getVirtualCloseRule(position, mgmtConfig);
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
    total_fees_earned_usd: 0,
    deployed_at: new Date(Date.now() - 60000).toISOString(),
    snapshots: [],
  };
  const rule = getVirtualCloseRule(position, mgmtConfig);
  if (!rule || rule.rule !== 1 || rule.reason !== "stop loss") {
    throw new Error(`Expected stop loss (rule 1), got ${JSON.stringify(rule)}`);
  }
});

test("A13: solMode=true — TP does NOT fire below threshold (regression guard)", () => {
  // Verifies the function does not magically fire; the caller's unit
  // selection is what matters. If the caller passes SOL PnL=4 below TP=5,
  // no close. (This is the inverse of the bug — the bug was that USD
  // PnL=3 was being checked against TP=5 even though the display said 5.46%.)
  const mgmtConfig = { solMode: true, takeProfitPct: 5, stopLossPct: -50 };
  const position = {
    upper_bin: 100, active_bin: 100,
    pnl_pct: 4,                                         // SOL PnL, below threshold
    total_value_usd: 0.5,
    total_fees_earned_usd: 0,
    deployed_at: new Date(Date.now() - 60000).toISOString(),
    snapshots: [],
  };
  const rule = getVirtualCloseRule(position, mgmtConfig);
  if (rule) throw new Error(`Expected no close, got ${JSON.stringify(rule)}`);
});

test("A14: solMode=false — TP fires at USD PnL=5% (backward compat)", () => {
  // solMode=false users must still get correct USD-based TP.
  const mgmtConfig = { solMode: false, takeProfitPct: 5, stopLossPct: -50 };
  const position = {
    upper_bin: 100, active_bin: 100,
    pnl_pct: 5,
    total_value_usd: 50,
    total_fees_earned_usd: 0.1,
    deployed_at: new Date(Date.now() - 60000).toISOString(),
    snapshots: [],
  };
  const rule = getVirtualCloseRule(position, mgmtConfig);
  if (!rule || rule.rule !== 2) throw new Error(`Expected TP, got ${JSON.stringify(rule)}`);
});

test("A15: solMode=true — low yield uses SOL numerator/SOL denominator (unit-agnostic)", () => {
  // Build a position with rich SOL fees to keep yield above threshold,
  // then verify no close. The point is that both numerator and denominator
  // are in the same unit (SOL) and the ratio is unit-agnostic.
  const mgmtConfig = {
    solMode: true,
    takeProfitPct: 5,
    stopLossPct: -50,
    minFeePerTvl24h: 7,
    minAgeBeforeYieldCheck: 60,
  };
  const position = {
    upper_bin: 100, active_bin: 100,
    pnl_pct: 0,                                         // no PnL rules
    total_value_usd: 0.5,                               // 0.5 SOL
    total_fees_earned_usd: 0.005,                       // 0.005 SOL fees
    deployed_at: new Date(Date.now() - 120 * 60000).toISOString(), // 2h old
    snapshots: [],
  };
  // yield = (0.005 / 0.5) * (1440 / 120) * 100 = 12% > 7% → no close
  const rule = getVirtualCloseRule(position, mgmtConfig);
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
    total_value_usd: 0.5,                               // 0.5 SOL
    total_fees_earned_usd: 0.0005,                      // 0.0005 SOL fees (low)
    deployed_at: new Date(Date.now() - 120 * 60000).toISOString(),
    snapshots: [],
  };
  // yield = (0.0005 / 0.5) * (1440 / 120) * 100 = 1.2% < 7% → low yield
  const rule = getVirtualCloseRule(position, mgmtConfig);
  if (!rule || rule.rule !== 5 || rule.reason !== "low yield") {
    throw new Error(`Expected low yield (rule 5), got ${JSON.stringify(rule)}`);
  }
});

test("A17: solMode=true — suspect PnL guard skips PnL rules", () => {
  // SOL PnL is -95% (huge loss) but position still has value 0.02 SOL
  // → likely bin state corruption, skip PnL-based rules.
  const mgmtConfig = { solMode: true, takeProfitPct: 5, stopLossPct: -50 };
  const position = {
    upper_bin: 100, active_bin: 100,
    pnl_pct: -95,
    total_value_usd: 0.02,
    total_fees_earned_usd: 0,
    deployed_at: new Date(Date.now() - 60000).toISOString(),
    snapshots: [],
  };
  const rule = getVirtualCloseRule(position, mgmtConfig);
  if (rule) throw new Error(`Suspect PnL should skip rules, got ${JSON.stringify(rule)}`);
});

test("A18: solMode=true — Rule 6 trend exit uses pnl_sol_pct from snapshots", () => {
  // 4 consecutive down snapshots in SOL PnL → trend exit fires.
  const mgmtConfig = {
    solMode: true,
    takeProfitPct: 5,
    stopLossPct: -50,
    vpTrendExitCycles: 3,
  };
  const position = {
    upper_bin: 100, active_bin: 100,
    pnl_pct: -10,                                       // current SOL PnL (in loss)
    total_value_usd: 0.5,
    total_fees_earned_usd: 0,
    deployed_at: new Date(Date.now() - 60000).toISOString(),
    snapshots: [
      { pnl_pct: -2, pnl_sol_pct: -2 },
      { pnl_pct: -4, pnl_sol_pct: -4 },
      { pnl_pct: -7, pnl_sol_pct: -7 },
      { pnl_pct: -10, pnl_sol_pct: -10 },
    ],
  };
  const rule = getVirtualCloseRule(position, mgmtConfig);
  if (!rule || rule.rule !== 6) throw new Error(`Expected trend exit (rule 6), got ${JSON.stringify(rule)}`);
});

test("A19: solMode=true — Rule 6 with mixed old/new snapshots (silent fallback)", () => {
  // Old snapshots lack pnl_sol_pct; function falls back to pnl_pct (USD).
  // Within a single snapshot pair units are consistent, so the comparison
  // is direction-correct. This test locks in current behavior.
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
    total_fees_earned_usd: 0,
    deployed_at: new Date(Date.now() - 60000).toISOString(),
    snapshots: [
      { pnl_pct: -2 },                                  // old: no pnl_sol_pct
      { pnl_pct: -4 },                                  // old: no pnl_sol_pct
      { pnl_pct: -7 },                                  // old: no pnl_sol_pct
      { pnl_pct: -10 },                                 // old: no pnl_sol_pct
    ],
  };
  // Falls back to pnl_pct (USD) consistently across all 4 snapshots,
  // so the trend is still detected.
  const rule = getVirtualCloseRule(position, mgmtConfig);
  if (!rule || rule.rule !== 6) throw new Error(`Expected trend exit with fallback, got ${JSON.stringify(rule)}`);
});

test("A20: OOR too long — uses THIS cycle's effective OOR minutes", () => {
  // active_bin above upper_bin AND effectiveOorMinutes ≥ 30 → OOR close
  const mgmtConfig = { solMode: true, takeProfitPct: 5, stopLossPct: -50, outOfRangeWaitMinutes: 30 };
  const position = {
    upper_bin: 100, active_bin: 105,                    // 5 bins above
    pnl_pct: 0,
    total_value_usd: 0.5,
    total_fees_earned_usd: 0,
    deployed_at: new Date(Date.now() - 60000).toISOString(),
    snapshots: [],
  };
  const rule = getVirtualCloseRule(position, mgmtConfig, 45); // 45 min OOR
  if (!rule || rule.rule !== 4 || rule.reason !== "OOR") {
    throw new Error(`Expected OOR (rule 4), got ${JSON.stringify(rule)}`);
  }
});

// ════════════════════════════════════════════════════════════
//  SECTION B: occupiedPools/occupiedMints derivation
// ════════════════════════════════════════════════════════════
//
// Mirrors the deploy pre-check logic in executor.js line 750-752.
// After the fix, getMyPositions already includes VPs, so the
// separate VP add loop in deploy pre-check is redundant.

function computeOccupancy(result) {
  return {
    pools: new Set(result.positions.map((p) => p.pool)),
    mints: new Set(result.positions.map((p) => p.base_mint).filter(Boolean)),
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
  const merged = mergeVirtualPositions([], vps);
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
  // Reproduces: wallet is empty on-chain, 3 VPs in dry-run-state.json,
  // maxPositions = 3, LLM tries to deploy, gets "Max positions (3) reached"
  const vps = [
    { id: "vp_001", pool: "PoolA", base_mint: "MintA", deployed_at: new Date(Date.now() - 600000).toISOString() },
    { id: "vp_002", pool: "PoolB", base_mint: "MintB", deployed_at: new Date(Date.now() - 300000).toISOString() },
    { id: "vp_003", pool: "PoolC", base_mint: "MintC", deployed_at: new Date(Date.now() - 60000).toISOString() },
  ];
  const llmView = mergeVirtualPositions([], vps);
  const deployView = computeOccupancy(llmView);

  // LLM's count
  if (llmView.total_positions !== 3) throw new Error("LLM should see 3 positions");
  // Deploy pre-check's count (the same call)
  if (deployView.pools.size !== 3) throw new Error("Deploy check should see 3 pools");
  if (deployView.mints.size !== 3) throw new Error("Deploy check should see 3 mints");
  // They match — bug fixed
  if (llmView.total_positions !== deployView.pools.size) {
    throw new Error("LLM count and deploy count diverge — bug still present");
  }
});

// ════════════════════════════════════════════════════════════
//  SECTION C: Telegram /close routing (P2 fix)
// ════════════════════════════════════════════════════════════
//
// Mirrors helpers from tools/dry-run-state.js:
//   parseVirtualPositionAddress(positionAddress)
//   computeSimpleVirtualPnl(vp)

function parseVirtualPositionAddress(positionAddress) {
  if (typeof positionAddress !== "string" || !positionAddress.startsWith("vp:")) {
    return null;
  }
  return positionAddress.slice(3);
}

function computeSimpleVirtualPnl(vp) {
  const initialValue = vp?.initial_value_usd;
  const currentValue = vp?.current_value_usd ?? initialValue;
  const pnlUsd = (currentValue != null && initialValue != null)
    ? currentValue - initialValue
    : null;
  const pnlPct = (currentValue != null && initialValue != null && initialValue > 0)
    ? ((currentValue / initialValue - 1) * 100)
    : null;
  return { pnlUsd, pnlPct };
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
  if (parseVirtualPositionAddress(123) !== null) {
    throw new Error("Number should not parse as VP");
  }
});

test("C3: computeSimpleVirtualPnl — profitable VP returns positive PnL", () => {
  const vp = { initial_value_usd: 100, current_value_usd: 115 };
  const { pnlUsd, pnlPct } = computeSimpleVirtualPnl(vp);
  if (Math.abs(pnlUsd - 15) > 0.0001) throw new Error(`pnlUsd: expected 15, got ${pnlUsd}`);
  if (Math.abs(pnlPct - 15) > 0.0001) throw new Error(`pnlPct: expected 15, got ${pnlPct}`);
});

test("C4: computeSimpleVirtualPnl — losing VP returns negative PnL", () => {
  const vp = { initial_value_usd: 100, current_value_usd: 92.50 };
  const { pnlUsd, pnlPct } = computeSimpleVirtualPnl(vp);
  if (Math.abs(pnlUsd - (-7.5)) > 0.0001) throw new Error(`pnlUsd: expected -7.5, got ${pnlUsd}`);
  if (Math.abs(pnlPct - (-7.5)) > 0.0001) throw new Error(`pnlPct: expected -7.5, got ${pnlPct}`);
});

test("C5: computeSimpleVirtualPnl — null vp returns null pnl", () => {
  const { pnlUsd, pnlPct } = computeSimpleVirtualPnl(null);
  if (pnlUsd !== null) throw new Error(`pnlUsd: expected null, got ${pnlUsd}`);
  if (pnlPct !== null) throw new Error(`pnlPct: expected null, got ${pnlPct}`);
});

test("C6: computeSimpleVirtualPnl — vp with only initial value, no current", () => {
  // Edge case: just deployed, no snapshot yet
  const vp = { initial_value_usd: 50 };
  const { pnlUsd, pnlPct } = computeSimpleVirtualPnl(vp);
  if (pnlUsd !== 0) throw new Error(`pnlUsd: expected 0, got ${pnlUsd}`);
  if (pnlPct !== 0) throw new Error(`pnlPct: expected 0, got ${pnlPct}`);
});

test("C8: computeSimpleVirtualPnl — division-by-zero guard (initial=0)", () => {
  // Edge case: shouldn't happen, but if initial_value_usd is 0 the
  // pnlPct calculation would divide by zero. Guard must return null, not NaN/Infinity.
  const vp = { initial_value_usd: 0, current_value_usd: 100 };
  const { pnlUsd, pnlPct } = computeSimpleVirtualPnl(vp);
  if (pnlUsd !== 100) throw new Error(`pnlUsd: expected 100, got ${pnlUsd}`);
  if (pnlPct !== null) throw new Error(`pnlPct: expected null (div-by-zero guard), got ${pnlPct}`);
});

// ════════════════════════════════════════════════════════════
//  SECTION D: Source-order check (meridian-5ry fix)
// ════════════════════════════════════════════════════════════
//
// runSafetyChecks in executor.js has hard-to-test side effects, so we
// verify the fix via source-level order check. The "Insufficient SOL"
// check must appear in the deploy_position case BEFORE the
// "Max positions" check, so the LLM sees the real blocker first.

const executorSrc = fs.readFileSync(
  path.join(__dirname, "..", "tools", "executor.js"),
  "utf8"
);

// Extract just the deploy_position case body for focused comparison
function extractDeployCase(src) {
  const start = src.indexOf('case "deploy_position"');
  if (start === -1) throw new Error("deploy_position case not found");
  // Find the closing brace at the same indent level
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
  // Find the position of "Insufficient SOL" and check the surrounding
  // ~20 lines above for a DRY_RUN guard
  const idx = deployCase.indexOf("Insufficient SOL");
  if (idx === -1) throw new Error("'Insufficient SOL' check not found");
  // Look back ~300 chars for the nearest DRY_RUN reference
  const before = deployCase.slice(Math.max(0, idx - 300), idx);
  if (!before.includes("DRY_RUN")) {
    throw new Error("Insufficient SOL check should be gated on DRY_RUN (not found within 300 chars before)");
  }
});

test("D3: position count check still present (regression guard)", () => {
  const deployCase = extractDeployCase(executorSrc);
  if (!deployCase.includes("Max positions")) {
    throw new Error("'Max positions' check should still exist in deploy_position case");
  }
});

test("C7: routing — VP position routes to VP close, live routes to live close", () => {
  // Simulate the routing decision in closeTelegramPosition.
  // The helper detects "vp:" prefix and dispatches accordingly.
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
//
// Bug: tools/dlmm.js used `export { mergeVirtualPositions } from "..."`
// (re-export form) which does NOT create a local binding. The call site
// at line 1680 then threw ReferenceError, causing getMyPositions to
// return 0 positions in dry-run mode and the screening cycle to ignore
// maxPositions. Fix: use `import { ... } from "..."` instead.

const dlmmSrc = fs.readFileSync(
  path.join(__dirname, "..", "tools", "dlmm.js"),
  "utf8"
);

test("E1: dlmm.js imports mergeVirtualPositions (not re-exports)", () => {
  // Verify the fix from meridian-fvo is in place. The re-export form
  // would be: `export { mergeVirtualPositions } from "./merge-virtual-positions.js"`
  // The correct form is: `import { mergeVirtualPositions } from "./merge-virtual-positions.js"`
  if (/^export\s*\{\s*mergeVirtualPositions\s*\}\s*from\s*["']\.\/merge-virtual-positions\.js["']/m.test(dlmmSrc)) {
    throw new Error("dlmm.js uses broken re-export form for mergeVirtualPositions (use `import` instead). See meridian-fvo.");
  }
  if (!/^import\s*\{[^}]*mergeVirtualPositions[^}]*\}\s*from\s*["']\.\/merge-virtual-positions\.js["']/m.test(dlmmSrc)) {
    throw new Error("dlmm.js should `import { mergeVirtualPositions } from './merge-virtual-positions.js'`");
  }
});

// ════════════════════════════════════════════════════════════
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
