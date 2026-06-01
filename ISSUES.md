# Issues Found During Setup, Dry Run Testing, and DLMM SDK Audit

> Found: May 31, 2026 (setup + dry run) | June 1, 2026 (DLMM SDK audit)  
> Meridian `main` branch | DRY_RUN=true | Wallet: 0 SOL

---

## 1. 429 Rate Limiting — Single Provider Bottleneck

**Severity:** High  
**Status:** Open (needs proxy or multi-key support)

**Problem:**
Meridian uses a single OpenAI client (one `LLM_BASE_URL`, one `LLM_API_KEY`) for all three agent roles (SCREENER, MANAGER, GENERAL). When all roles use the same Token Plan key (e.g., MiMo v2.5 Pro), the provider's rate limit is hit quickly.

```
[ERROR] Agent loop error at step 1: 429 Too many requests
```

**Why it happens:**
- Management cycle: every 10 min → calls LLM
- Screening cycle: every 30 min → calls LLM (multiple steps)
- User chat/REPL → calls LLM on demand
- All share one API key quota

**Workaround:**
- Use per-role model config (`managementModel`, `screeningModel`, `generalModel`) to split across different providers
- BUT: all roles still share the same API key (`LLM_API_KEY`), so splitting models only helps if they're on different rate-limit buckets (rare)

**Proposed fix:**
- Standalone OpenAI-compatible proxy server that routes models → different providers/keys (see `docs/proxy-design.md` — to be created)
- OR: add per-role `LLM_BASE_URL` / `LLM_API_KEY` support in `agent.js`

---

## 2. HiveMind Default Key Rejected

**Severity:** Medium  
**Status:** Fixed (community key applied)

**Problem:**
The built-in HiveMind public key (`bWVyaWRpYW4taXMtdGhlLWJlc3QtYWdlbnRz`) is rejected by the server:

```
[HIVEMIND_WARN] Lesson pull failed: Invalid HiveMind API key
[HIVEMIND_WARN] Agent register failed: Invalid HiveMind API key
```

This repeats 8+ times per cycle for lesson pushes.

**Fix applied:**
Community key from Telegram discussion group (`@agentmeridian`, msg #115):
- `hiveMindApiKey: hm_8f3c...`
- `publicApiKey: bWVyaWRpYW4taXMtdGhlLWJlc3QtYWdlbnRz`

Both set in `user-config.json`. HiveMind now connects.

---

## 3. LPAgent 401 — Requires Paid Plan

**Severity:** Low  
**Status:** Open (no free alternative)

**Problem:**
The top-LPer study feature requires LPAgent API. Free plan returns 401:

```
[LPAGENT_API] HTTP 401 for owner BjwJRDaW: {"message":"Unauthorized"}
```

**Why:**
- LPAgent top-LPer endpoint (`/pools/{id}/top-lpers`) requires Premium or Enterprise plan
- No free alternative exists for aggregated LPer performance data

**Impact:**
- Agent cannot study top LPers to generate strategy lessons
- Learning engine still works via own closed positions (`lessons.js`)
- Non-blocking for dry run

---

## 4. Screening Race Condition — Management vs Cron

**Severity:** Low (guards work, but noisy)  
**Status:** Open

**Problem:**
When management cycle ends with open positions below `maxPositions`, it triggers a screening cycle. If the cron timer also fires screening at the same minute (schedules align at 0/30 min marks), both call `runScreeningCycle()` simultaneously.

```
[CRON] No open positions — triggering screening cycle     ← management trigger
[CRON] Screening skipped — previous cycle still running   ← cron blocked
[CRON] Starting screening cycle                           ← management proceeds
```

**Current guard:**
`_screeningBusy` (line 380) correctly blocks the second caller — no double execution. But the log is confusing and the management trigger should check `_screeningBusy` before calling.

**Proposed fix:**
Add `!_screeningBusy` check to management's screening trigger at line 355, and set `_screeningLastTriggered` immediately before the async call to prevent the TOCTOU gap.

---

## 5. OKX Data Unavailable — Niche Tokens

**Severity:** Trivial  
**Status:** Expected behavior

**Problem:**
OKX OnchainOS returns "unavailable" for many meme/niche tokens during screening:

```
[OKX] advanced-info unavailable for JTVO-SOL (9VY2rDbt)
[OKX] price-info unavailable for ZINC-SOL (zinc155B)
```

**Why:**
OKX only tracks tokens with sufficient market activity. Niche tokens are silently skipped during enrichment.

**Impact:**
- Agent falls back to Jupiter + Meteora data for those tokens
- No functional impact — just log noise

---

## 6. HiveMind Lesson Push Spam

**Severity:** Low  
**Status:** Mitigated (HiveMind key fixed, but no true "off" switch)

**Problem:**
When HiveMind push fails (invalid key or network error), every lesson save generates a warning. 8 lessons = 8 identical warnings in a single cycle:

```
[HIVEMIND_WARN] Lesson push failed: Invalid HiveMind API key  (×8)
```

**Fix applied:**
Valid HiveMind key resolves the `403`/`401` errors.

**Remaining issue:**
No clean "disable HiveMind" toggle. Setting `hiveMindUrl` or `hiveMindApiKey` to empty string falls through to defaults. A `hiveMindEnabled: false` flag is needed.

---

## 7. No Multi-Provider LLM Support

**Severity:** Medium  
**Status:** Open (design limitation)

**Problem:**
`agent.js` creates a single `new OpenAI(...)` client. All per-role models share the same `baseURL` and `apiKey`. Switching providers requires restarting with different env vars.

**Proposed solution:**
- Standalone proxy (see issue #1)
- OR: per-role env vars like `LLM_MANAGEMENT_BASE_URL`, `LLM_SCREENING_API_KEY`

---

## 8. Base Fee Calculated 100× Too High

**Severity:** Critical  
**Status:** Open (1-line fix available)

**Problem:**
`tools/dlmm.js:614` calculates base fee with an extra `× 100` factor that makes the reported value 100× larger than the SDK's actual base fee percentage.

**Current code** (`tools/dlmm.js:614`):
```js
// Read base fee directly from pool — baseFactor * binStep / 10^6 gives fee in %
const actualBaseFee = baseFactor > 0
  ? parseFloat((baseFactor * actualBinStep / 1e6 * 100).toFixed(4))
  : null;
```

**Why this is wrong (per `DLMM.md` Section 7):**
The SDK formula is:
```
baseFeeRatePercentage = (baseFactor × binStep × 10 × 10^powerFactor) × 100 / FEE_PRECISION
                        where FEE_PRECISION = 1_000_000_000
```
For `powerFactor=0`: `baseFactor × binStep × 1000 / 1_000_000_000 = baseFactor × binStep / 1_000_000`

Meridian's formula: `baseFactor × binStep / 1_000_000 × 100` → **100× too high**.

**Concrete example** (baseFactor=100, binStep=100):
| Source | Formula | Result |
|--------|---------|--------|
| SDK actual | `100×100×1000 / 1e9` | **0.01%** |
| Meridian | `100×100×100 / 1e6` | **1.0%** |

**Impact:**
- The reported `base_fee_pct` is passed into the LLM prompt as part of the pool metrics block
- LLM sees inflated base fees and may incorrectly reject low-fee pools or prefer pools with bad base fees
- Does NOT affect on-chain funds — strictly a decision-quality issue
- No on-chain safety risk (deploy safety checks are independent of this value)

**Proposed fix:**
```js
// Option A (minimal — just remove the × 100):
const actualBaseFee = baseFactor > 0
  ? parseFloat((baseFactor * actualBinStep / 1e6).toFixed(4))
  : null;

// Option B (full SDK alignment including powerFactor):
const powerFactor = pool.lbPair.parameters?.baseFeePowerFactor ?? 0;
const FEE_PRECISION = 1_000_000_000;
const baseFeeRate = baseFactor * actualBinStep * 10 * Math.pow(10, powerFactor);
const actualBaseFee = baseFactor > 0
  ? parseFloat((baseFeeRate * 100 / FEE_PRECISION).toFixed(4))
  : null;
```

**Related:** Issue #11 (M-3) covers the missing `baseFeePowerFactor` term.

---

## 9. `claimFees` Does Not Claim Meteora Rewards

**Severity:** High  
**Status:** Open

**Problem:**
The standalone `claimFees` function (`tools/dlmm.js:1458-1501`) only calls `pool.claimSwapFee()`, which claims **swap fees only** — not Meteora liquidity mining rewards (up to 2 reward mints per pool, stored in `lbPair.rewardInfos`).

**Current code** (`tools/dlmm.js:1478`):
```js
const txs = await pool.claimSwapFee({
  owner: wallet.publicKey,
  position: positionData,
});
```

**Why this matters (per `DLMM.md` Section 8):**
Meteora pools can have token incentives on top of swap fees. Per DLMM SDK, reward claiming requires `claimReward2` on-chain instructions, which are only bundled inside:
- `removeLiquidity({ shouldClaimAndClose: true })` — used by `close_position` flow ✅
- The rebalance path

**The standalone `claimFees` silently leaves rewards unclaimed.**

**Impact:**
- If the agent uses `claim_fees` to compound (reclaim fees without closing), it collects swap fees but loses reward tokens
- For pools with active rewards, this is lost income
- The `close_position` flow (line 1800) DOES claim rewards correctly, so this only affects the standalone claim path
- This is a **silent bug** — no error, no warning, just missed rewards

**Proposed fix:**
Option A (minimal — document the limitation):
- Add a note to the LLM prompt that `claim_fees` only claims swap fees, not rewards

Option B (complete — claim rewards too):
```js
// After claimSwapFee, claim each reward mint
const rewardInfos = pool.lbPair.rewardInfos || [];
for (let i = 0; i < rewardInfos.length; i++) {
  if (rewardInfos[i]) {
    const rewardTxs = await pool.claimReward({
      owner: wallet.publicKey,
      position: positionData,
      rewardIndex: i,
    });
    // ... send txs
  }
}
```

Option C (use removeLiquidity with bps=0 if supported by SDK):
```js
// Verify SDK supports zero-bps claim
const txs = await pool.removeLiquidity({
  user: wallet.publicKey,
  position: positionData,
  fromBinId: positionData.positionData.lowerBinId,
  toBinId: positionData.positionData.upperBinId,
  bps: new BN(0),  // 0 = claim only, no remove
  shouldClaimAndClose: false,
});
```

---

## 10. Slippage Inconsistency Between Deploy Paths

**Severity:** High  
**Status:** Open

**Problem:**
Meridian uses two different slippage values for the two deploy code paths — 100× apart. Both values are also outside the recommended range.

**Current code:**
- Standard path (≤69 bins), `tools/dlmm.js:816`: `slippage: 1000` (10%)
- Wide-range path (>69 bins), `tools/dlmm.js:800`: `slippage: 10` (0.1%)

**Why this matters:**
- **Standard path (10% slippage)** is extremely loose. Sandwich attacks on every deploy can extract up to 10% of position value. Real-world impact: ~0.5-2% loss per deploy from MEV.
- **Wide-range path (0.1% slippage)** is extremely tight. The `addLiquidityByStrategyChunkable` path operates across multiple transactions. Between TX blocks, even small price moves will violate 0.1% tolerance, causing frequent failures and wasted gas.

**Impact:**
- Standard deploys: exposed to MEV/sandwich attacks
- Wide-range deploys: frequent TX failures, wasted gas, retry loops
- Both are easy to fix

**Proposed fix:**
Normalize both paths to a consistent, reasonable value:
```js
// In config.js:
{
  "management": {
    "deploySlippageBps": 150  // 1.5% — typical for concentrated liquidity
  }
}

// In both deploy code paths:
slippage: config.management.deploySlippageBps
```

Recommended range: 100-200 bps (1-2%). Below 1% = frequent failures; above 5% = MEV risk.

---

## 11. Medium-Severity SDK Usage Issues (M-1 to M-5)

**Severity:** Medium  
**Status:** Open (deferred fixes)

Five issues identified during the DLMM SDK audit. All affect decision quality or robustness, none cause on-chain loss.

### M-1: No Active Bin Recheck Before TX Send

**Location:** `tools/dlmm.js:493` (fetch) → `tools/dlmm.js:769-817` (TX build)

**Problem:** Between fetching the active bin and sending the deploy TX, the active bin can move (especially in volatile pools where DLMM.md Section 4 confirms bin skipping is possible). No recheck is performed.

**Mitigation in place:** 35-69 bin range provides buffer. Sub-second fetch-to-broadcast window makes this unlikely except during extreme volatility.

**Fix:** Add pre-send recheck: abort only if active bin change exceeds 20% of total range.

### M-2: `getPositionPnl` Relies Entirely on External API, No SDK Fallback

**Location:** `tools/dlmm.js:959-1021`

**Problem:** Per `DLMM.md` Section 11, "No SDK helper for PnL — you calculate it manually from `processPosition()` output." Meridian avoids this by using Meteora's external PnL API (`dlmm.datapi.meteora.ag/positions/{pool}/pnl`). No fallback to SDK's `pool.getPosition()` → `processPosition()` → manual per-bin sum.

**Impact:** If the Meteora PnL API is down or returning stale data, PnL calculations are wrong or unavailable. Affects close decisions, stop-loss/take-profit triggers, and performance recording.

**Fix:** Add a fallback path using SDK's `pool.getPosition()` to get `PositionBinData[]` and manually sum fees/liquidity.

### M-3: Base Fee Doesn't Account for `baseFeePowerFactor`

**Location:** `tools/dlmm.js:614`

**Problem:** The SDK formula includes `10^baseFeePowerFactor` when `powerFactor > 0`. Meridian's formula omits this term entirely. Per `DLMM.md` Section 10, this is only used "for target fees > 0.65%" — rare but not impossible.

**Impact:** For pools with `baseFeePowerFactor > 0`, Meridian would under-calculate the base fee. Combined with Issue #8 (the ×100 bug), the resulting number is essentially wrong for all cases.

**Fix:** See Issue #8 Option B for the complete formula including `baseFeePowerFactor`.

### M-4: `claimSwapFee` Existence as Public SDK Method is Unverified

**Location:** `tools/dlmm.js:1478` and `tools/dlmm.js:1765`

**Problem:** The DLMM.md reference (Section 13) states "No standalone public method. Fee claiming is embedded in `removeLiquidity`." Yet Meridian calls `pool.claimSwapFee(...)` directly. Either:
- The reference is outdated (method was added later), OR
- The method is private/internal, and Meridian accidentally depends on it

Since Meridian runs without errors today, the method likely IS public — but worth verifying against the actual SDK version in `package.json`.

**Fix:** Check SDK version, verify `claimSwapFee` exists in source, add version pin to `package.json` if not already pinned.

### M-5: Fee Precision Risk for Non-SOL Token Amounts (Dead Code Path)

**Location:** `tools/dlmm.js:616-623`

**Problem:** `Math.floor()` on a JS number before converting to BN. For SOL deploys (0.5-50 SOL), no precision loss. For token X with arbitrary decimals, `finalAmountX × 10^decimals` could exceed `Number.MAX_SAFE_INTEGER` (~9 × 10^15). However, Meridian enforces `amount_x=0` for all deploys, so this code path is currently dead.

**Impact:** None today. Becomes a real risk if dual-sided deploys are ever added.

**Fix:** Use `BigInt` for the conversion:
```js
const totalXLamports = new BN(
  BigInt(Math.floor(finalAmountX)) * BigInt(10) ** BigInt(decimals)
);
```

---

## 12. Low-Severity SDK Usage Issues (L-1 to L-3)

**Severity:** Low  
**Status:** Open (cosmetic / design tradeoffs)

Three minor issues. Not bugs — design choices that may be worth revisiting.

### L-1: Volatility=0 Check May Reject Fresh Pools Too Aggressively

**Location:** `tools/screening.js:47-49` (`isUsableVolatility`), `tools/dlmm.js:477-479`, `tools/executor.js:145-150`

**Problem:** `isUsableVolatility(value)` requires `value > 0` (strictly positive). The Meteora API returns `volatility = 0` for freshly created pools where `volatilityAccumulator=0` (no bin jumps yet). This blocks deployment on new pools even if they have legitimate volume.

**Assessment:** Correct during screening — a pool with zero volatility has no price movement data to size a bin range. But may reject pools that are 5-10 minutes old with genuine volume but no significant price movement yet.

**Fix:** Consider allowing a very low default (e.g., `volatility = 0.5`) for fresh pools, or add a configurable `minPoolAgeMinutes` threshold.

### L-2: `getPositionPnl` Fallback for Relay Positions is Fragile

**Location:** `tools/dlmm.js:959-1021`

**Problem:** When LPAgent relay is enabled, `getPositionPnl` first tries cache, falls back to Meteora PnL API. The cache is cleared by `getMyPositions({ force: true })`, making multiple parallel PnL calls expensive. The fallback path also logs a warning that the agent never sees.

**Fix:** Low priority. Ensure fallback consistently returns the same schema shape.

### L-3: LPAgent Direct API → Meridian Mapping Has No Schema Validation

**Location:** `tools/dlmm.js:902-929` (`fetchLpAgentOpenPositions`), lines 1211-1336 (mapping in `getMyPositions`)

**Problem:** LPAgent API is an external dependency. If the response schema changes (field renames, new nesting), Meridian silently receives null data. The address mapping has safe fallbacks (`p.position || p.id || p.tokenId`), but the PnL/value fields have no fallback validation.

**Fix:** Add lightweight schema validation on the LPAgent response shape. At minimum, assert that `data` is an array and positions have expected keys. Log the raw response on schema mismatch for debugging.

---

## Summary

| #  | Issue | Severity | Status |
|----|-------|----------|--------|
| 1  | 429 rate limiting | High | Open |
| 2  | HiveMind key rejected | Medium | Fixed |
| 3  | LPAgent paid plan required | Low | Open |
| 4  | Screening race condition | Low | Open |
| 5  | OKX unavailable for niche tokens | Trivial | Expected |
| 6  | HiveMind push spam | Low | Mitigated |
| 7  | No multi-provider LLM support | Medium | Open |
| 8  | Base fee calculated 100× too high | **Critical** | **Open (1-line fix)** |
| 9  | `claimFees` does not claim Meteora rewards | High | Open |
| 10 | Slippage inconsistency between deploy paths (10% vs 0.1%) | High | Open |
| 11 | Medium-severity SDK issues (M-1 to M-5) | Medium | Open (deferred) |
| 12 | Low-severity SDK issues (L-1 to L-3) | Low | Open (deferred) |
