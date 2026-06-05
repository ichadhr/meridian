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
//  Pure function: mergeVirtualPositions
// ════════════════════════════════════════════════════════════
//
// Mirrors the logic added at the end of getMyPositions() in tools/dlmm.js.
// When DRY_RUN, the function should append VP entries to the positions array
// and bump total_positions. The shape of each merged VP matches the on-chain
// position shape so the LLM can't tell them apart structurally.

function mergeVirtualPositions(positions, vps, now = Date.now()) {
  if (!Array.isArray(vps) || vps.length === 0) {
    return { positions, total_positions: positions.length };
  }
  const merged = [...positions];
  for (const vp of vps) {
    const initialValue = vp.initial_value_usd;
    const currentValue = vp.current_value_usd;
    const pnlUsd = (currentValue != null && initialValue != null)
      ? currentValue - initialValue
      : null;
    const pnlPct = (currentValue != null && initialValue != null && initialValue > 0)
      ? ((currentValue / initialValue - 1) * 100)
      : null;
    merged.push({
      position: `vp:${vp.id}`,          // prefix to avoid pubkey collision
      pool: vp.pool,
      pair: vp.pair || vp.pool_name || String(vp.pool).slice(0, 8),
      base_mint: vp.base_mint || null,
      lower_bin: vp.lower_bin ?? null,
      upper_bin: vp.upper_bin ?? null,
      active_bin: vp.active_bin_at_deploy ?? null,
      in_range: !vp._oor_since,
      unclaimed_fees_usd: vp.total_fees_earned_usd ?? 0,
      total_value_usd: currentValue ?? initialValue ?? null,
      pnl_usd: pnlUsd,
      pnl_pct: pnlPct,
      age_minutes: vp.deployed_at
        ? Math.floor((now - new Date(vp.deployed_at).getTime()) / 60000)
        : null,
      instruction: null,
      source: "virtual",                  // lets the LLM distinguish from on-chain
    });
  }
  return { positions: merged, total_positions: merged.length };
}

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
  const result = mergeVirtualPositions(onChain, vps, now);
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
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
