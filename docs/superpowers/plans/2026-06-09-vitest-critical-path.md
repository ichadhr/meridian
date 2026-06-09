# Vitest Critical Path Coverage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Vitest with 5 test files covering money-critical functions: getCloseRule, computeDeployAmount, computeBinsBelow, getLoneCandidateSkipReason, executeTool.

**Architecture:** Pure unit tests for 4 functions (no mocking needed). DRY_RUN integration test for executeTool (mock providers at SDK boundary). Config overridden per test via Object.assign.

**Tech Stack:** Vitest, TypeScript, ESM

---

## File Structure

| File | Purpose |
|------|---------|
| `vitest.config.ts` | Vitest configuration |
| `tests/close-rules.test.ts` | getCloseRule — 6 close rules + edge cases |
| `tests/deploy-amount.test.ts` | computeDeployAmount — position sizing |
| `tests/bins-below.test.ts` | computeBinsBelow — volatility scaling |
| `tests/candidate-guard.test.ts` | getLoneCandidateSkipReason — token filtering |
| `tests/tool-executor.test.ts` | executeTool — dispatch + safety checks (DRY_RUN) |

---

## Task 1: Install Vitest and Create Config

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json`

- [ ] **Step 1: Install vitest**

Run: `npm install -D vitest`
Expected: vitest added to devDependencies

- [ ] **Step 2: Create vitest.config.ts**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globals: true,
    environment: "node",
  },
});
```

- [ ] **Step 3: Add test:unit script to package.json**

In `package.json`, add to `"scripts"`:
```json
"test:unit": "vitest run",
"test": "vitest run && npm run test:all"
```

- [ ] **Step 4: Verify vitest runs**

Run: `npm run test:unit`
Expected: 0 tests found (no test files yet), exits cleanly

- [ ] **Step 5: Commit**

```bash
git add vitest.config.ts package.json package-lock.json
git commit -m "test: add vitest with critical path config"
```

---

## Task 2: Close Rules Tests

**Files:**
- Create: `tests/close-rules.test.ts`

- [ ] **Step 1: Write the failing test file**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { getCloseRule } from "../core/close-rules.js";
import type { CloseRulePosition, CloseRuleConfig } from "../core/close-rules.js";

const baseConfig: CloseRuleConfig = {
  stopLossPct: -20,
  takeProfitPct: 50,
  outOfRangeWaitMinutes: 30,
  minFeePerTvl24h: 0.05,
  minAgeBeforeYieldCheck: 60,
  solMode: true,
};

function pos(overrides: Partial<CloseRulePosition> = {}): CloseRulePosition {
  return {
    upper_bin: 100,
    active_bin: 90,
    pnl_pct: 5,
    total_value_usd: 100,
    unclaimed_fees_usd: 10,
    deployed_at: new Date(Date.now() - 3600_000).toISOString(),
    ...overrides,
  };
}

describe("getCloseRule", () => {
  describe("Rule 1: Stop-loss", () => {
    it("closes when pnl_pct <= stopLossPct", () => {
      const result = getCloseRule(pos({ pnl_pct: -25 }), baseConfig, 0, 0.1);
      expect(result).toEqual({ action: "CLOSE", rule: 1, reason: "Stop-loss" });
    });

    it("stays when pnl_pct > stopLossPct", () => {
      const result = getCloseRule(pos({ pnl_pct: -10 }), baseConfig, 0, 0.1);
      expect(result).toBeNull();
    });

    it("skips when pnl_pct is null", () => {
      const result = getCloseRule(pos({ pnl_pct: null }), baseConfig, 0, 0.1);
      expect(result).toBeNull();
    });
  });

  describe("Rule 2: Take-profit", () => {
    it("closes when pnl_pct >= takeProfitPct", () => {
      const result = getCloseRule(pos({ pnl_pct: 55 }), baseConfig, 0, 0.1);
      expect(result).toEqual({ action: "CLOSE", rule: 2, reason: "Take-profit" });
    });

    it("stays when pnl_pct < takeProfitPct", () => {
      const result = getCloseRule(pos({ pnl_pct: 40 }), baseConfig, 0, 0.1);
      expect(result).toBeNull();
    });
  });

  describe("Rule 3: Out-of-range timeout", () => {
    it("closes when minutes_out_of_range >= outOfRangeWaitMinutes", () => {
      const result = getCloseRule(pos(), baseConfig, 35, 0.1);
      expect(result).toEqual({ action: "CLOSE", rule: 3, reason: "Out of range" });
    });

    it("stays when minutes_out_of_range < outOfRangeWaitMinutes", () => {
      const result = getCloseRule(pos(), baseConfig, 20, 0.1);
      expect(result).toBeNull();
    });

    it("skips when effectiveOorMinutes is null-ish (0)", () => {
      const result = getCloseRule(pos(), baseConfig, 0, 0.1);
      expect(result).toBeNull();
    });
  });

  describe("Rule 4: Low yield", () => {
    it("closes when fee_per_tvl_24h < minFeePerTvl24h and age > minAge", () => {
      const oldPos = pos({
        deployed_at: new Date(Date.now() - 120 * 60_000).toISOString(),
      });
      const result = getCloseRule(oldPos, baseConfig, 0, 0.01);
      expect(result).toEqual({ action: "CLOSE", rule: 4, reason: "Low yield" });
    });

    it("stays when fee_per_tvl_24h >= minFeePerTvl24h", () => {
      const oldPos = pos({
        deployed_at: new Date(Date.now() - 120 * 60_000).toISOString(),
      });
      const result = getCloseRule(oldPos, baseConfig, 0, 0.1);
      expect(result).toBeNull();
    });

    it("skips when age < minAgeBeforeYieldCheck", () => {
      const result = getCloseRule(pos(), baseConfig, 0, 0.01);
      expect(result).toBeNull();
    });
  });

  describe("Rule 5: Low yield (VP synthetic)", () => {
    it("computes synthetic yield when fee_per_tvl_24h is undefined (VP)", () => {
      const oldPos = pos({
        deployed_at: new Date(Date.now() - 120 * 60_000).toISOString(),
        unclaimed_fees_usd: 0.5,
        total_value_usd: 100,
      });
      const result = getCloseRule(oldPos, baseConfig, 0, undefined);
      // synthetic = (0.5 / 100) * (1440 / 120) * 100 = 6%
      // 6% > minFeePerTvl24h (0.05) → should stay
      expect(result).toBeNull();
    });

    it("skips Rule 5 when fee_per_tvl_24h is null (live SDK failed)", () => {
      const oldPos = pos({
        deployed_at: new Date(Date.now() - 120 * 60_000).toISOString(),
        unclaimed_fees_usd: 0,
        total_value_usd: 100,
      });
      const result = getCloseRule(oldPos, baseConfig, 0, null);
      expect(result).toBeNull();
    });
  });

  describe("Default: STAY", () => {
    it("returns null when no rules trigger", () => {
      const result = getCloseRule(pos({ pnl_pct: 10 }), baseConfig, 5, 0.1);
      expect(result).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/close-rules.test.ts`
Expected: FAIL — module not found or import error (first run may need to resolve paths)

- [ ] **Step 3: Run test to verify it passes**

Run: `npx vitest run tests/close-rules.test.ts`
Expected: All tests PASS. If any fail, adjust test data to match actual getCloseRule behavior.

- [ ] **Step 4: Commit**

```bash
git add tests/close-rules.test.ts
git commit -m "test: add getCloseRule unit tests — 6 rules + edge cases"
```

---

## Task 3: Deploy Amount Tests

**Files:**
- Create: `tests/deploy-amount.test.ts`

- [ ] **Step 1: Write the test file**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { computeDeployAmount } from "../config/index.js";
import { config } from "../config/index.js";

describe("computeDeployAmount", () => {
  const original = {
    gasReserve: config.management.gasReserve,
    rentBuffer: config.management.rentBuffer,
    positionSizePct: config.management.positionSizePct,
    deployAmountSol: config.management.deployAmountSol,
    maxDeployAmount: config.risk.maxDeployAmount,
  };

  beforeEach(() => {
    config.management.gasReserve = 0.05;
    config.management.rentBuffer = 0.01;
    config.management.positionSizePct = 0.35;
    config.management.deployAmountSol = 0.1;
    config.risk.maxDeployAmount = 10;
  });

  afterEach(() => {
    Object.assign(config.management, original);
    config.risk.maxDeployAmount = original.maxDeployAmount;
  });

  it("returns floor when wallet is below minimum", () => {
    // deployable = 0.1 - 0.05 - 0.01 = 0.04
    // dynamic = 0.04 * 0.35 = 0.014
    // result = max(0.1, 0.014) = 0.1 (floor)
    expect(computeDeployAmount(0.1)).toBe(0.1);
  });

  it("returns floor when wallet is zero", () => {
    expect(computeDeployAmount(0)).toBe(0.1);
  });

  it("scales with wallet balance in normal range", () => {
    // deployable = 5 - 0.05 - 0.01 = 4.94
    // dynamic = 4.94 * 0.35 = 1.729
    // result = max(0.1, min(10, 1.729)) = 1.73
    expect(computeDeployAmount(5)).toBe(1.73);
  });

  it("caps at maxDeployAmount", () => {
    // deployable = 100 - 0.05 - 0.01 = 99.94
    // dynamic = 99.94 * 0.35 = 34.979
    // result = min(10, max(0.1, 34.979)) = 10
    expect(computeDeployAmount(100)).toBe(10);
  });

  it("handles negative wallet balance", () => {
    expect(computeDeployAmount(-5)).toBe(0.1);
  });
});
```

- [ ] **Step 2: Run test**

Run: `npx vitest run tests/deploy-amount.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add tests/deploy-amount.test.ts
git commit -m "test: add computeDeployAmount unit tests — sizing formula"
```

---

## Task 4: Bins Below Tests

**Files:**
- Create: `tests/bins-below.test.ts`

**Note:** `computeBinsBelow` is not exported from any barrel. It's a local function in `index.ts`. To test it, we need to either:
1. Export it from `index.ts` and add to a barrel, or
2. Copy the formula logic into the test file as a reference implementation

**Decision:** Export it from `index.ts`. It's a pure function with no side effects.

- [ ] **Step 1: Export computeBinsBelow from index.ts**

In `index.ts`, change:
```ts
function computeBinsBelow(volatility: any): number {
```
to:
```ts
export function computeBinsBelow(volatility: any): number {
```

- [ ] **Step 2: Write the test file**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { computeBinsBelow } from "../index.js";
import { config } from "../config/index.js";

describe("computeBinsBelow", () => {
  const original = {
    minBinsBelow: config.strategy.minBinsBelow,
    maxBinsBelow: config.strategy.maxBinsBelow,
  };

  beforeEach(() => {
    config.strategy.minBinsBelow = 35;
    config.strategy.maxBinsBelow = 69;
  });

  afterEach(() => {
    config.strategy.minBinsBelow = original.minBinsBelow;
    config.strategy.maxBinsBelow = original.maxBinsBelow;
  });

  it("throws on zero volatility", () => {
    expect(() => computeBinsBelow(0)).toThrow("Invalid volatility");
  });

  it("throws on negative volatility", () => {
    expect(() => computeBinsBelow(-1)).toThrow("Invalid volatility");
  });

  it("throws on NaN volatility", () => {
    expect(() => computeBinsBelow(NaN)).toThrow("Invalid volatility");
  });

  it("throws on non-numeric volatility", () => {
    expect(() => computeBinsBelow("abc")).toThrow("Invalid volatility");
  });

  it("returns minBinsBelow for low volatility (1)", () => {
    // 35 + (1/5) * (69-35) = 35 + 6.8 = 41.8 → round = 42
    expect(computeBinsBelow(1)).toBe(42);
  });

  it("returns mid range for volatility 2.5", () => {
    // 35 + (2.5/5) * (69-35) = 35 + 17 = 52
    expect(computeBinsBelow(2.5)).toBe(52);
  });

  it("returns maxBinsBelow for high volatility (5+)", () => {
    // 35 + (5/5) * (69-35) = 35 + 34 = 69
    expect(computeBinsBelow(5)).toBe(69);
    expect(computeBinsBelow(10)).toBe(69);
  });

  it("respects custom config bounds", () => {
    config.strategy.minBinsBelow = 20;
    config.strategy.maxBinsBelow = 40;
    // 20 + (2.5/5) * (40-20) = 20 + 10 = 30
    expect(computeBinsBelow(2.5)).toBe(30);
  });
});
```

- [ ] **Step 3: Run test**

Run: `npx vitest run tests/bins-below.test.ts`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add tests/bins-below.test.ts index.ts
git commit -m "test: add computeBinsBelow unit tests — volatility scaling"
```

---

## Task 5: Candidate Guard Tests

**Files:**
- Create: `tests/candidate-guard.test.ts`

- [ ] **Step 1: Write the test file**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getLoneCandidateSkipReason } from "../core/live/screen.js";
import { config } from "../config/index.js";

function candidate(overrides: Record<string, any> = {}) {
  return {
    pool: { name: "TEST-SOL", gmgn_smart_wallets: 0, ...overrides.pool },
    sw: overrides.sw ?? null,
    n: overrides.n ?? null,
    ti: overrides.ti ?? null,
    mem: null,
  };
}

describe("getLoneCandidateSkipReason", () => {
  const original = {
    minTokenFeesSol: config.screening.minTokenFeesSol,
    maxTop10Pct: config.screening.maxTop10Pct,
    maxBotHoldersPct: config.screening.maxBotHoldersPct,
  };

  beforeEach(() => {
    config.screening.minTokenFeesSol = 30;
    config.screening.maxTop10Pct = 60;
    config.screening.maxBotHoldersPct = 25;
  });

  afterEach(() => {
    config.screening.minTokenFeesSol = original.minTokenFeesSol;
    config.screening.maxTop10Pct = original.maxTop10Pct;
    config.screening.maxBotHoldersPct = original.maxBotHoldersPct;
  });

  it("returns error when pool is missing", () => {
    expect(getLoneCandidateSkipReason({} as any)).toBe("missing candidate data");
  });

  it("skips wash trading", () => {
    const c = candidate({ pool: { is_wash: true } });
    expect(getLoneCandidateSkipReason(c)).toBe("wash trading was flagged");
  });

  it("skips rugpull with no smart wallets", () => {
    const c = candidate({ pool: { is_rugpull: true } });
    expect(getLoneCandidateSkipReason(c)).toBe("rugpull risk was flagged and no smart wallets offset it");
  });

  it("allows rugpull when smart wallets present", () => {
    const c = candidate({
      pool: { is_rugpull: true },
      sw: { in_pool: [{ name: "whale1" }] },
    });
    expect(getLoneCandidateSkipReason(c)).toBeNull();
  });

  it("skips PVP with no smart wallets", () => {
    const c = candidate({ pool: { is_pvp: true } });
    expect(getLoneCandidateSkipReason(c)).toBe("PVP symbol conflict and no smart-wallet confirmation");
  });

  it("skips low token fees", () => {
    const c = candidate({ ti: { global_fees_sol: 10 } });
    expect(getLoneCandidateSkipReason(c)).toContain("token fees");
  });

  it("skips high top10 concentration", () => {
    const c = candidate({ ti: { audit: { top_holders_pct: 80 } } });
    expect(getLoneCandidateSkipReason(c)).toContain("top10 concentration");
  });

  it("skips high bot holders", () => {
    const c = candidate({ ti: { audit: { bot_holders_pct: 30 } } });
    expect(getLoneCandidateSkipReason(c)).toContain("bot holders");
  });

  it("skips when no narrative and no smart wallets", () => {
    const c = candidate();
    expect(getLoneCandidateSkipReason(c)).toBe("only candidate has no narrative and no smart-wallet confirmation");
  });

  it("passes when smart wallets present", () => {
    const c = candidate({ sw: { in_pool: [{ name: "whale1" }] } });
    expect(getLoneCandidateSkipReason(c)).toBeNull();
  });

  it("passes when narrative present", () => {
    const c = candidate({ n: { narrative: "meme coin" } });
    expect(getLoneCandidateSkipReason(c)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test**

Run: `npx vitest run tests/candidate-guard.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add tests/candidate-guard.test.ts
git commit -m "test: add getLoneCandidateSkipReason unit tests — token filtering"
```

---

## Task 6: Tool Executor Tests (DRY_RUN)

**Files:**
- Create: `tests/tool-executor.test.ts`

- [ ] **Step 1: Write the test file**

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { executeTool } from "../llm/tools/executor.js";

describe("executeTool", () => {
  const originalDryRun = process.env.DRY_RUN;

  beforeEach(() => {
    process.env.DRY_RUN = "true";
  });

  afterEach(() => {
    if (originalDryRun === undefined) {
      delete process.env.DRY_RUN;
    } else {
      process.env.DRY_RUN = originalDryRun;
    }
  });

  it("throws on unknown tool", async () => {
    await expect(executeTool("nonexistent_tool", {})).rejects.toThrow("Unknown tool");
  });

  it("dispatches get_wallet_balance successfully", async () => {
    // get_wallet_balance reads from config/providers — in DRY_RUN it should work
    const result = await executeTool("get_wallet_balance", {});
    expect(result).toBeDefined();
  });

  it("rejects deploy_position with amount_y > 0", async () => {
    const result = await executeTool("deploy_position", {
      pool_address: "test-pool",
      amount_y: 1,
      strategy: "conservative",
      bins_below: 35,
      bins_above: 0,
    });
    // Should return error about SOL-only deploys
    expect(result).toBeDefined();
  });

  it("strips model artifacts from tool names", async () => {
    // Some LLMs append artifacts like "<|channel|>commentary" to tool names
    await expect(
      executeTool("get_wallet_balance<|channel|>commentary", {})
    ).rejects.toThrow("Unknown tool");
  });
});
```

- [ ] **Step 2: Run test**

Run: `npx vitest run tests/tool-executor.test.ts`
Expected: All tests PASS (DRY_RUN mode skips real transactions)

- [ ] **Step 3: Commit**

```bash
git add tests/tool-executor.test.ts
git commit -m "test: add executeTool unit tests — dispatch + safety checks"
```

---

## Task 7: Final Verification

- [ ] **Step 1: Run all unit tests**

Run: `npm run test:unit`
Expected: All 5 test files pass, 0 failures

- [ ] **Step 2: Run full lint**

Run: `npm run lint`
Expected: 0 errors (tsc + eslint)

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "test: verify vitest critical path coverage — all passing"
```

---

## Summary

| Task | File | Tests |
|------|------|-------|
| 1 | vitest.config.ts, package.json | Setup |
| 2 | tests/close-rules.test.ts | 10 tests — stop-loss, take-profit, OOR, low yield, VP, default |
| 3 | tests/deploy-amount.test.ts | 5 tests — floor, normal, ceiling, zero, negative |
| 4 | tests/bins-below.test.ts | 8 tests — invalid, low, mid, high, custom bounds |
| 5 | tests/candidate-guard.test.ts | 11 tests — wash, rugpull, PVP, fees, top10, bots, narrative, smart wallets |
| 6 | tests/tool-executor.test.ts | 4 tests — unknown tool, dispatch, SOL-only, artifact stripping |
| 7 | — | Final verification |
