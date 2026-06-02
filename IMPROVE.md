# Meridian — Improvement Plan

> Created: June 1, 2026 | Status: Living document  
> Complements: `ISSUES.md` (current bugs) and `CLAUDE.md` (architecture)  
> Goal: Document what can be made better, with code references, effort estimates, and trade-offs

---

## 1. Architecture Recap (for context)

Meridian is a **ReAct (Reason + Act) agent** with three roles sharing one LLM client:

```
┌─────────────┐
│ index.js    │  Main entry: REPL + cron + Telegram
└──────┬──────┘
       │
       ├── management cron (10m) ──→ runManagementCycle()  → MANAGER role
       ├── screening cron  (30m) ──→ runScreeningCycle()   → SCREENER role
       └── Telegram message  ────→ agentLoop(GENERAL role)
                │
                ▼
       ┌─────────────────┐
       │   agent.js      │  One OpenAI client. Per-role model.
       │   (ReAct loop)  │  Filters tools by role.
       └────────┬────────┘
                ▼
       ┌─────────────────┐
       │ tools/executor  │  Safety checks + audit log
       └────────┬────────┘
                ▼
       ┌─────────────────────────────────────┐
       │ dlmm.js  screening.js  wallet.js    │
       │ study.js token.js  definitions.js   │
       └─────────────────────────────────────┘
                │
                ▼
       ┌─────────────────────────────────────┐
       │  state.json  lessons.json           │
       │  pool-memory.json  strategy-library │
       │  decision-log.json  smart-wallets   │
       │  token-blacklist.json               │
       └─────────────────────────────────────┘
```

**The core loop** (`agent.js`):
```js
for (let i = 0; i < MAX_ITERATIONS; i++) {
  const response = await openai.chat.completions.create({
    model, messages, tools
  });
  if (msg.tool_calls) {
    for (const call of msg.tool_calls) {
      const result = await executor.execute(call.name, call.args);
      messages.push({role:"tool", content: result});
    }
    continue;
  }
  return msg.content;
}
```

**Improvements live in three places** (by blast radius):
1. **State/logic bugs** — fix in source (`index.js`, `agent.js`, `executor.js`)
2. **Tool capability gaps** — add to `tools/definitions.js` + `executor.js` + role sets
3. **Architecture rewrites** — proxy servers, separate processes, new modules

---

## 2. Improvement Strategy

Three tiers by effort × impact:

| Tier | Effort | Items | Why |
|------|--------|-------|-----|
| **Quick wins** | 1-2 days each | 4 | Real bugs, low risk, ship this week |
| **Medium** | 1-2 weeks each | 4 | Capability gaps that block real capital |
| **Strategic** | 1-2 months each | 5 | What makes Meridian actually competitive |

**Prioritization rule:** Fix in tier order. Don't start Tier 2 until Tier 1 ships. Don't start Tier 3 until Tier 2 is in production for 1+ month.

**Constraint:** User wants to keep Meridian source untouched where possible. Some Tier 1 fixes require source edits; Tier 2+ should be additive (new files, new processes) rather than invasive rewrites.

---

## 3. Quick Wins

### 3.1 Screening Race Condition Fix

**Problem:** Management cycle triggers screening when positions < `maxPositions`. Cron timer also fires screening at 0/30 min marks. Both can call `runScreeningCycle()` at the same minute. The `_screeningBusy` guard (line 380) prevents double execution but logs are confusing and the management path bypasses the check.

**Current state** (`index.js:355` and `index.js:380-385`):
```js
// Management trigger (~line 355)
if (openPositions.length < config.risk.maxPositions) {
  runScreeningCycle().catch(err => log("screener_error", err.message));
  // ↑ no check if screening is already running
}

// Cron path with guard
if (_screeningBusy) {
  log("cron", "Screening skipped — previous cycle still running");
  return;
}
_screeningBusy = true;
```

**Proposed fix:** Add a single helper that both paths use:
```js
function tryStartScreening(source) {
  if (_screeningBusy) {
    log("cron", `Screening skipped (triggered by ${source}) — already running`);
    return false;
  }
  _screeningLastTriggered = Date.now();
  _screeningBusy = true;
  runScreeningCycle()
    .catch(err => log("screener_error", err.message))
    .finally(() => { _screeningBusy = false; });
  return true;
}
```

**Status:** ✅ Fixed (commit `4461b1a`) — `tryStartScreening(source)` centralizes all triggers

---

### 3.2 HiveMind Disable Flag

**Problem:** No clean way to turn HiveMind off. Setting `hiveMindApiKey: ""` in `user-config.json` falls through to the default key in `hivemind.js` (uses `nonEmptyString()`). Result: warnings fire even when user wants to disable.

**Current code** (`hivemind.js:87-89`):
```js
export function isHiveMindEnabled() {
  return getBaseUrl() && getApiKey();  // both have hardcoded defaults
}
```

**Proposed fix:** Add explicit opt-out flag, check first:
```js
export function isHiveMindEnabled() {
  if (config.hiveMind.enabled === false) return false;  // explicit off
  return getBaseUrl() && getApiKey();
}
```

`config.js`:
```js
hiveMind: {
  enabled: true,  // default on, but user can set false
  apiKey: ...,
  url: ...,
  // ...
}
```

**Effort:** 2 hours  
**Impact:** Clean way to disable for users who don't want community data; silences 8+ warnings per cycle  
**Risk:** None — additive  
**Files:** `config.js`, `hivemind.js`, `user-config.json` (add field)

---

### 3.3 Lesson Push Dedup

**Problem:** Every lesson save calls `pushHiveLesson()`. With 8 lessons from the bootstrap, that's 8 pushes per cycle. Identical content pushed repeatedly.

**Current code** (`hivemind.js:292-305`):
```js
export async function pushHiveLesson(lesson) {
  if (!isHiveMindEnabled()) return null;
  // ... POST to hive
}
```

**Proposed fix:** Hash lesson content + dedup before push:
```js
import { createHash } from "crypto";

const _pushedHashes = new Set();  // in-memory, cleared on restart

function lessonHash(lesson) {
  return createHash("sha256")
    .update(JSON.stringify(lesson.text + (lesson.outcome || "")))
    .digest("hex");
}

export async function pushHiveLesson(lesson) {
  if (!isHiveMindEnabled()) return null;
  const hash = lessonHash(lesson);
  if (_pushedHashes.has(hash)) {
    log("hivemind_debug", `Skipping duplicate lesson push: ${hash.slice(0,8)}`);
    return null;
  }
  _pushedHashes.add(hash);
  // ... existing POST
}
```

**Limitation:** In-memory set is lost on restart. For persistence, store hashes in `lessons.json` and check at startup. Adds ~50 lines.

**Effort:** 3 hours (basic) / 6 hours (with persistence)  
**Impact:** 80% reduction in HiveMind API calls; cleaner logs  
**Risk:** None — purely additive; misses are acceptable (re-push on restart is fine)  
**Files:** `hivemind.js`

---

### 3.4 Rate Limit Backoff for Meteora API

**Problem:** Meteora's `/pair/all` endpoint returns 429 under load. Meridian's screening log shows this in production. No backoff — just logs the error and continues.

**Current code** (screening.js — needs verification):
```js
const res = await fetch(METEORA_API);
if (!res.ok) log("screening_warn", `HTTP ${res.status}`);
return [];
```

**Proposed fix:** Exponential backoff with jitter, similar to `agent-meridian.js`:
```js
async function fetchWithBackoff(url, { maxAttempts = 3, baseMs = 1000 } = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetch(url);
    if (res.ok) return res;
    if (res.status === 429 || res.status >= 500) {
      const wait = baseMs * 2 ** attempt + Math.random() * 500;
      log("screening_debug", `Retry ${attempt+1}/${maxAttempts} after ${wait}ms (status ${res.status})`);
      await sleep(wait);
      continue;
    }
    throw new Error(`HTTP ${res.status}`);
  }
  throw new Error("Max retries exhausted");
}
```

**Effort:** 1 day  
**Impact:** Prevents data starvation during Meteora spikes; smoother screening  
**Risk:** None — only adds waits, never fails faster than current code  
**Files:** `tools/screening.js`

---

## 4. Medium Effort

### 4.1 Multi-Provider LLM Proxy

**The problem (recap from `ISSUES.md` #1 and #7):**  
Meridian has a single OpenAI client. If MiMo v2.5 Pro rate-limits or 502s, the agent goes down. Per-role models exist (`managementModel`, `screeningModel`, `generalModel`) but they all share the same `baseURL` + `apiKey`.

**The solution:** A thin, standalone OpenAI-compatible proxy in front of Meridian.

```
Meridian agent.js
      │
      │ http://localhost:9999/v1/chat/completions
      ▼
┌────────────────────────────────────────┐
│ meridian-llm-proxy/  (separate process)│
│  - 80 lines Node.js or Go              │
│  - Reads routing config from JSON      │
│  - Tries primary → fallback1 → fallback2│
│  - Returns first success, or last error│
└────────────┬───────────────────────────┘
             │
   ┌─────────┼─────────┐
   ▼         ▼         ▼
 MiMo    MiniMax    Healer-alpha
 v2.5    M2.5       (backup)
 Pro
```

**Routing config example** (`proxy-config.json`):
```json
{
  "routes": [
    { "match": { "model": "*" }, "providers": ["mimo", "minimax", "healer"] },
    { "match": { "model": "mimo-v2.5-pro" }, "providers": ["mimo", "minimax"] }
  ],
  "providers": {
    "mimo":    { "baseUrl": "https://token-plan-sgp.xiaomimimo.com/v1", "apiKeyEnv": "MIMO_KEY" },
    "minimax": { "baseUrl": "https://api.MiniMax.chat/v1",             "apiKeyEnv": "MINIMAX_KEY" },
    "healer":  { "baseUrl": "https://openrouter.ai/api/v1",            "apiKeyEnv": "OPENROUTER_KEY" }
  }
}
```

**Meridian config change:**  
```env
LLM_BASE_URL=http://localhost:9999/v1
LLM_API_KEY=any-non-empty-string   # proxy handles auth
LLM_MODEL=mimo-v2.5-pro            # model name passed through to proxy
```

**Implementation:**
```js
// proxy/server.js (sketch)
async function handleChat(req, res) {
  const body = req.body;
  const providers = getProvidersForModel(body.model);
  let lastErr = null;
  for (const p of providers) {
    try {
      const r = await fetch(`${p.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${p.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (r.ok) return res.status(200).send(await r.text());
      if (r.status === 429 || r.status >= 500) { lastErr = r.status; continue; }
      return res.status(r.status).send(await r.text());
    } catch (e) { lastErr = e.message; }
  }
  res.status(503).json({ error: "All providers failed", last: lastErr });
}
```

**Effort:** 1 week  
**Impact:** Massive resilience. If MiMo dies, Meridian keeps running on MiniMax. Currently the entire agent halts on a single 502.  
**Risk:** Low — proxy is well-understood pattern; can disable by reverting `LLM_BASE_URL`  
**New files:** `meridian-llm-proxy/server.js`, `meridian-llm-proxy/config.json`, `meridian-llm-proxy/README.md`

**Status:** Will build once MiniMax backup key is obtained (currently waiting on Telegram DM to `@Angphrodite`).

---

### 4.2 Self-Hosted LPAgent Lite

**The problem:** Meridian depends on `api.agentmeridian.xyz` for top-LPer study. If that endpoint goes down, Meridian deploys blind. We have no control over the upstream.

**The solution:** Build a lightweight indexer for the top 50 pools Meridian actually watches.

```
meridian-indexer/
  src/
    indexer.ts     # WebSocket subscriber to Meteora program
    db.ts          # Postgres + TimescaleDB schema
    pnl.ts         # PnL calculator (Meteora SDK)
    api.ts         # Fastify server exposing /top-lp/:pool
  package.json
```

**What it tracks:**
- Position open/close events (Meteora program logs)
- Per-position: current bin range, active bin, time in range
- Per-position: realized PnL (on close), unrealized PnL (live)
- Per-pool: top LPers by current position size, ranked by ROI

**What it doesn't track (vs real LPAgent):**
- Cross-pool analytics
- Historical strategy labels
- Smart-wallet follow tracking
- Real-time alerts

**Data flow:**
```
Meteora program events
  → WebSocket (Helius enhanced)
  → indexer.ts parses with @meteora-ag/dlmm IDL
  → Postgres/TimescaleDB
  → pnl.ts recomputes every 60s per open position
  → /top-lp/:pool endpoint
```

**Meridian config change:**  
```json
{
  "api": {
    "url": "http://localhost:7777/api",
    "publicApiKey": "self-hosted"
  }
}
```

**Effort:** 1-2 weeks (with current Solana experience)  
**Impact:** Independence from Agent Meridian uptime; 6+ months of historical data for backtesting  
**Risk:** Medium — Solana program IDLs change, position migration logic is tricky. Recommend starting with 1 pool as proof of concept  
**New files:** Entire `meridian-indexer/` directory

**Pre-req:** A $5-10/mo VPS with 50GB disk. Tencent Lighthouse Singapore = $10.08/yr.

---

### 4.3 Adaptive OOR Strategy

**The problem:** Out-of-range handling is binary — wait 30 min, then close. This is too rigid:
- For scalpers, 30 min is too long (price might recover in 5)
- For wide ranges, 30 min is too short (drift is normal)

**Current code** (in `executor.js` and `state.js`):
```js
// Pseudocode of current logic
if (isOutOfRange(position) && timeSinceOOR > 30min) {
  close(position);
}
```

**Proposed fix:** Classify OOR type, apply different strategy:
```js
const oorStrategy = {
  // Price moved far, range too tight — re-deploy elsewhere
  "BREAKOUT": { action: "close", waitMin: 5, rationale: "broken out of range" },
  // Price oscillates around boundary — wait, may recover
  "OSCILLATION": { action: "wait", waitMin: 60, rationale: "near boundary" },
  // Price drifted past entire range — close, dead
  "DEAD": { action: "close", waitMin: 0, rationale: "drift" },
};

function classifyOOR(position, priceHistory) {
  const distance = priceHistory.currentActiveBin - position.upperBin;
  const velocity = priceHistory.binDeltaLast1h;
  if (Math.abs(distance) > position.binWidth * 0.5) return "BREAKOUT";
  if (Math.abs(velocity) < 5) return "OSCILLATION";
  return "DEAD";
}
```

**Effort:** 2 weeks  
**Impact:** Estimated 20-40% improvement in realized PnL for OOR positions  
**Risk:** Medium — wrong classification = closes too early or too late. Need backtesting before shipping  
**Files:** `tools/dlmm.js`, `agent.js` (prompt update), `state.js` (track price history)

---

### 4.4 Position Sizing — Kelly Criterion Lite

**The problem:** `positionSizePct` is fixed at 35%. No scaling by edge confidence.

**Current formula** (`config.js`):
```js
function computeDeployAmount(walletSol) {
  const deployable = walletSol - config.management.gasReserve;
  return clamp(deployable * config.management.positionSizePct,
               config.management.deployAmountSol,
               config.risk.maxDeployAmount);
}
```

**Proposed fix:** Score each candidate 0-1, scale position by score:
```js
function computeKellySize(walletSol, candidateScore) {
  const baseSize = computeDeployAmount(walletSol);
  const kellyFraction = clamp(candidateScore, 0.25, 1.0);  // never below 25%
  return baseSize * kellyFraction;
}
```

**Candidate score** (from LPAgent study + screening):
- Top LPer avg ROI > 50%: +0.3
- Top LPer win rate > 70%: +0.2
- Pool TVL > 50k: +0.2
- Token organic ratio > 80%: +0.2
- Bundler % < 10%: +0.1
- (max 1.0)

**Effort:** 1 week  
**Impact:** Concentrate capital in best opportunities, reduce loss in marginal ones  
**Risk:** Medium — wrong scoring = under-deployment. Need to log scores and outcomes for review  
**Files:** `config.js`, `tools/screening.js`, `agent.js` (prompt update)

---

### 4.5 Structured Instruction Format (Replace LLM Parsing)

**The problem:** When a user calls `set_position_note("close at 5% profit")`, the text is stored verbatim in `state.json` as a freeform string. The LLM is the **only** thing that parses it. This is fragile:
- LLM might misread "sell at 2x" as "close at +100% PnL" or "+200% PnL"
- LLM might close on a flash spike that satisfies the condition briefly
- Different LLM models interpret the same instruction differently
- Can't easily test instruction handling in isolation

**Current code** (`index.js:262-265`):
```js
// Instruction-set — pass to LLM, can't parse in JS
if (p.instruction) {
  actionMap.set(p.position, { action: "INSTRUCTION" });
  continue;  // LLM must handle
}
```

This explicitly says "can't parse in JS" — but it CAN, with a structured format.

**Proposed fix:** Define a structured instruction schema that JS can evaluate deterministically:

```js
// user-config.json — supported instruction types
{
  "management": {
    "instructionSchema": {
      "pnl_target": { "field": "pnl_pct", "op": ">=", "value_pct": 5 },
      "hold_time":  { "field": "minutes_held", "op": ">=", "value_min": 120 },
      "fee_target": { "field": "fees_earned_usd", "op": ">=", "value_usd": 10 },
      "stop_loss":  { "field": "pnl_pct", "op": "<=", "value_pct": -10 }
    }
  }
}
```

Tool wrapper:
```js
// New: tools/instructions.js
export function evaluateInstruction(instruction, position) {
  const { type, params } = instruction;
  const schema = config.management.instructionSchema[type];
  if (!schema) return null;
  
  const current = position[schema.field];
  const target = schema.value_pct ?? schema.value_min ?? schema.value_usd;
  
  const passes = matchOp(current, schema.op, target);
  return { passes, current, target, op: schema.op, type };
}
```

LLM becomes optional — only needed for freeform `"don't close before sunset"` style instructions, which would fall back to the old behavior.

**Effort:** 1 week  
**Impact:** Deterministic, testable, faster (no LLM call for common instructions), consistent across LLM models  
**Risk:** Low — additive; old freeform behavior preserved as fallback  
**Files:** `config.js`, new `tools/instructions.js`, `tools/definitions.js` (add new `set_structured_instruction` tool), `index.js` (add evaluation step)

---

### 4.6 Stuck-STAY AI Review (Catches Slow Deaths)

**The problem:** When JS rules return `STAY` for a position (in-range, no instruction, fees below threshold, no OOR), the LLM is **never consulted**. But the LLM might catch a slow death:
- Volume has dropped 80% over the last hour
- Token narrative shifted (e.g., a partnership fell through)
- Competing pool just launched with 10x the incentives
- Smart wallets that were in the pool have all left

The LLM gets all this context but never sees it because JS already said STAY.

**Current code** (`index.js:307-311`):
```js
const actionPositions = positionData.filter(p => {
  const a = actionMap.get(p.position);
  return a.action !== "STAY";
});

if (actionPositions.length > 0) {
  // LLM called ONLY for non-STAY positions
}
```

**Proposed fix:** Add a periodic AI review for positions that have been STAY for too long:

```js
// New config field
{
  "management": {
    "aiReviewAfterStuckMin": 120,  // 2 hours of STAY → force LLM review
    "aiReviewMaxCallsPerDay": 6    // limit LLM cost
  }
}

// In management cycle
const stuckPositions = positionData.filter(p => 
  actionMap.get(p.position).action === "STAY" &&
  (p.minutes_since_last_llm_review ?? p.age_minutes) > config.management.aiReviewAfterStuckMin
);

if (stuckPositions.length > 0 && aiReviewBudgetLeft()) {
  log("cron", `Triggering AI review for ${stuckPositions.length} stuck position(s)`);
  await agentLoop(`
    REVIEW REQUIRED — ${stuckPositions.length} position(s) have been STAY for >2h.
    ${stuckPositions.map(p => `POSITION: ${p.pair} | last_2h_volume_drop=${p.volume_drop_2h_pct}% | last_2h_smart_wallet_outflows=${p.sw_outflows_2h}`).join("\n")}
    Decide: HOLD, CLOSE, or CLAIM. Justify your decision in one line.
  `, ..., "MANAGER", ..., { budgetDeduct: 1 });
}
```

**Effort:** 1 week  
**Impact:** Catches slow deaths that JS rules miss; estimated 5-15% reduction in bleed-out losses  
**Risk:** Medium — could trigger unnecessary LLM churn. Cap with `aiReviewMaxCallsPerDay` to control cost. Log every review for later analysis  
**Files:** `index.js`, `config.js`, new `state.js` field for `last_llm_review_at`

---

### 4.7 Trailing TP State Centralization (Fix Brittle Logic)

**The problem:** Trailing take-profit logic in `index.js:230-249` has 3 nested conditions, 4 state flags (`needs_confirmation`, `shouldUsePnlRecheck`, `queueTrailingDropConfirmation`, `scheduleTrailingDropConfirmation`), and state lives in two places (state.json + memory). Hard to follow, hard to test, brittle.

**Current code** (`index.js:230-249`):
```js
for (const p of positionData) {
  if (
    !p.pnl_pct_suspicious &&
    queuePeakConfirmation(p.position, p.pnl_pct, { immediate: !shouldUsePnlRecheck() }) &&
    shouldUsePnlRecheck()
  ) {
    schedulePeakConfirmation(p.position);
  }
  const exit = updatePnlAndCheckExits(p.position, p, config.management);
  if (exit) {
    if (exit.action === "TRAILING_TP" && exit.needs_confirmation && shouldUsePnlRecheck()) {
      if (queueTrailingDropConfirmation(p.position, exit.peak_pnl_pct, exit.current_pnl_pct, config.management.trailingDropPct)) {
        scheduleTrailingDropConfirmation(p.position);
      }
      continue;
    }
    exitMap.set(p.position, exit.reason);
  }
}
```

**Problems:**
1. Three `continue` paths make the loop hard to reason about
2. State (`needs_confirmation`) lives in the exit object but actual scheduling is in another module
3. `shouldUsePnlRecheck()` is a config flag that's checked multiple times — what if it changes mid-cycle?
4. No tests for the state transitions (peak → drop → confirm → exit)

**Proposed fix:** Centralize trailing TP state in a single source of truth:

```js
// New: state/trailing-tp.js
class TrailingTPStateMachine {
  constructor(position) {
    this.position = position;
    this.state = "TRACKING";  // TRACKING | PEAKED | CONFIRMING | EXITED
    this.peak_pnl = position.pnl_pct;
    this.confirm_cycles = 0;
  }
  
  update(currentPnl, config) {
    if (this.state === "EXITED") return null;
    
    if (currentPnl > this.peak_pnl) {
      this.peak_pnl = currentPnl;
      this.state = "PEAKED";
      this.confirm_cycles = 0;
    }
    
    const drop = this.peak_pnl - currentPnl;
    if (drop >= config.trailingDropPct) {
      if (this.state === "PEAKED") {
        this.state = "CONFIRMING";
        this.confirm_cycles = 1;
        return { action: "WAIT_CONFIRM", reason: `drop ${drop}% from peak ${this.peak_pnl}%` };
      }
      if (this.state === "CONFIRMING") {
        this.confirm_cycles += 1;
        if (this.confirm_cycles >= config.trailingConfirmCycles) {
          this.state = "EXITED";
          return { action: "EXIT", reason: `confirmed drop ${drop}% from peak ${this.peak_pnl}%` };
        }
      }
    }
    
    return null;
  }
}
```

In `index.js`:
```js
for (const p of positionData) {
  const machine = getOrCreateTrailingTPState(p.position);
  const exit = machine.update(p.pnl_pct, config.management);
  if (exit) {
    if (exit.action === "EXIT") {
      exitMap.set(p.position, exit.reason);
    }
    // WAIT_CONFIRM just persists, no action needed
  }
}
```

**Effort:** 1-2 weeks  
**Impact:** Easier to test, easier to reason about, fewer bugs. Behavior preserved 1:1 (verify with existing position log replay)  
**Risk:** Medium — state machine refactor could introduce subtle bugs. Add unit tests before/after to verify behavior  
**Files:** New `state/trailing-tp.js`, `index.js` refactor, new `test/trailing-tp.test.js`

---

## 5. Strategic (1-2 months)

### 5.1 Multi-Strategy LLM

**The problem:** Meridian uses a single strategy per pool (effectively "spot" with a width). The LPAgent study reveals pools where Bid-Ask or Curve strategies dominate.

**Proposed approach:** Make strategy a first-class concept in the prompt:
```
Tool: study_top_lpers returns:
  patterns: { preferred_strategies: { spot: 60%, bid_ask: 30%, curve: 10% } }
  
LLM decides:
  "60% spot → I'll use spot"
  "70% bid_ask → I'll use bid_ask with these parameters"
```

**Save successful strategies** to `strategy-library.json` (already exists, currently unused).  
**Recall** at deploy time: "Last time I used this exact strategy in similar pool, PnL was +18%."

**Effort:** 1 month  
**Impact:** 2-3x more pool types deployable; matches local meta per pool  
**Files:** `prompt.js`, `agent.js`, `strategy-library.js`, `tools/definitions.js`

---

### 5.2 Backtesting Engine

**The problem:** We can't test strategy changes before deploying real capital. The current iteration cycle is "deploy → wait → close → lesson", which is slow.

**Proposed approach:** Replay historical pool data through Meridian's decision logic:
```
Input:  30 days of pool state (bin_id, volume, TVL, fees)
        + Meridian's screening/management rules as code
        + A specific strategy config
Output: Simulated PnL, max drawdown, win rate, hold time distribution
```

**Data source:** Self-hosted indexer (4.2) provides this. Without it, can't backtest.

**Architecture:**
```
backtester/
  runner.ts     # Replays pool data, applies Meridian rules
  strategies/   # Pluggable strategy implementations
  reports/      # Output: charts, metrics, comparison tables
```

**Effort:** 1 month (after 4.2 ships)  
**Impact:** Can A/B test strategies, validate improvements before risking capital  
**Risk:** Backtest overfitting is real — need walk-forward validation, not just in-sample fit

---

### 5.3 Cross-Pool Portfolio Management

**The problem:** Meridian treats each position independently. In reality, capital is shared across all positions. A 70% loss in one pool hurts the others.

**Proposed approach:** Portfolio-level risk management:
- Aggregate exposure per token (concentration limit)
- Correlation matrix between open positions (don't double up on correlated pools)
- Dynamic rebalancing: close weakest if max drawdown hit

**Effort:** 1-2 months  
**Impact:** Better risk-adjusted returns; fewer correlated blowups  
**Files:** New `portfolio.js` module, `state.json` schema extension

---

### 5.4 Risk Parity Sizing

**The problem:** Position size is fixed % of wallet, not volatility-targeted. A high-vol pool gets the same capital as a low-vol pool.

**Proposed approach:** Size inversely to recent volatility:
```js
positionSize = baseSize * (targetVol / poolVol)
```

If target vol = 5% daily and pool vol = 10%, position is half-size.

**Effort:** 2-3 weeks (after 4.4 ships)  
**Impact:** Smoother PnL curve; lower drawdowns  
**Files:** `config.js`, `tools/screening.js`

---

### 5.5 Web Dashboard

**The problem:** All observability is log-based. No way to see positions, PnL, decisions, lessons visually. Can't share screenshots easily.

**Proposed approach:** Read-only Next.js dashboard:
- Position list with current PnL
- Closed positions table with lessons
- Decision log timeline
- Pool memory viewer
- Lesson browser

**Stack:** Next.js 14 (App Router), Tailwind, shadcn/ui. Reads `state.json`, `lessons.json`, `decision-log.json` directly.

**Effort:** 2-3 weeks  
**Impact:** Better debugging, easier tuning, shareable reports  
**Files:** New `dashboard/` directory, separate from Meridian

**Status:** Design taste skill applies here. Should be intentional, not generic.

---

## 6. Recommended Order

**Week 1 (Tier 1):**
1. Race condition fix (1h)
2. HiveMind disable flag (2h)
3. Lesson dedup (3h)
4. Rate limit backoff (1d)
5. Test, commit, deploy

**Week 2-3 (Tier 1 done, move to Tier 2):**
6. Multi-provider LLM proxy (1w) — **highest ROI Tier 2**

**Week 4-6:**
7. Self-hosted indexer (2w) — needed for 4.3, 4.4, 5.2

**Month 2:**
8. Adaptive OOR (2w) — uses indexer data
9. Position sizing Kelly (1w) — uses indexer data
10. **Structured instructions (4.5, 1w)** — fixes LLM instruction parsing brittleness
11. **Stuck-STAY AI review (4.6, 1w)** — catches slow deaths
12. **Trailing TP state machine (4.7, 1-2w)** — fixes brittle exit logic

**Month 3:**
13. Multi-strategy LLM (1m) — uses indexer + Kelly

**Month 4+:**
14. Backtesting engine (1m) — validates everything above
15. Cross-pool portfolio (1-2m) — capital efficiency
16. Risk parity (2-3w) — smoother PnL
17. Web dashboard (2-3w) — observability

**Dependency graph:**
```
3.1, 3.2, 3.3, 3.4 (independent)
       ↓
4.1 LLM proxy (independent, parallel with indexer)
       ↓
4.2 Indexer
       ↓
4.3, 4.4 (need indexer)
       ↓
4.5, 4.6, 4.7 (independent of indexer — can ship in parallel with 4.3/4.4)
       ↓
5.1, 5.2 (need 4.3, 4.4)
       ↓
5.3, 5.4 (need 5.1)
       ↓
5.5 Dashboard (independent of all)
```

---

## 7. Dependencies & Risks

**External dependencies:**
- **MiMo v2.5 Pro** — primary LLM, rate limits unknown in production
- **MiniMax M2.5** — backup, requires Telegram DM for free Token Plan
- **Helius RPC** — 50K req/day free, $49/mo for Growth
- **Meteora API** — public, no auth, but rate-limited
- **Agent Meridian** — community API, no SLA

**Risks per tier:**
| Tier | Risk | Mitigation |
|------|------|------------|
| 1 | Source code changes might conflict with upstream Meridian | Keep changes minimal, document them in `ISSUES.md` |
| 2 | New processes (proxy, indexer) = more to deploy/monitor | PM2 / systemd unit files for both |
| 3 | Over-engineering vs. just deploying capital | Each Tier 3 item should pay for itself in <1 month |

**Capital deployment decision:** Once Tier 1 + 4.1 ships, deploy real capital at minimum size. Tier 2+ improvements should be made in parallel with live trading, not before.

---

## 8. Open Decisions Needed

These need user input before implementation:

1. **Tier 1 scope:** Ship all 4 quick wins at once, or one at a time with testing?
2. **Proxy tech:** Node.js (consistent with Meridian) or Go (lower memory, faster)?
3. **Indexer hosting:** Tencent Lighthouse ($10/yr) vs Oracle free tier (always-free, no Singapore region)?
4. **Backtesting approach:** Walk-forward (more rigorous) or in-sample (faster, riskier)?
5. **Strategy library format:** Free-form JSON, or schema-validated with JSON Schema?
6. **Dashboard hosting:** Same VPS as Meridian, or Vercel free tier?
7. **Structured instructions:** Schema-validated (4.5) or keep freeform + LLM fallback? Schema is safer but breaks user habits.
8. **Stuck-STAY review budget:** 6 reviews/day (cost-controlled) or uncapped (more thorough)? Need real usage data to decide.
9. **Trailing TP state refactor:** Big-bang (rewrite + test in one PR) or incremental (ship state machine, keep old logic as backup)?

**Decisions on hold (waiting on external events):**
- MiniMax backup key (waiting on Telegram DM to `@Angphrodite`)
- Real capital deployment (waiting for user to fund wallet)

---

## 9. See Also

- `ISSUES.md` — Current bugs and known limitations
- `CLAUDE.md` — Architecture and code conventions
- `lessons.json` — What Meridian has learned so far
- `decision-log.json` — What Meridian has decided so far

---

## 10. Change Log

| Date | Change |
|------|--------|
| 2026-06-01 | Initial document. Tier 1-3 outlined. No code changes proposed yet. |
| 2026-06-01 | Added 3 new Medium effort items from MANAGER cycle deep-dive: 4.5 Structured Instruction Format, 4.6 Stuck-STAY AI Review, 4.7 Trailing TP State Centralization. Updated dependency graph and recommended order. Added 3 new open decisions. |
| 2026-06-02 | ✅ 3.1 Screening race condition fixed. Virtual position simulation system implemented (5 files, ~900 lines). |
