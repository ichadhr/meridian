# Telegram Message Formats

All formatters from `interfaces/messages.ts` whose output reaches Telegram.
`core/briefing.ts` is included (not in messages.ts, but sends to Telegram).

> **Not included:** `cur`, `fmtPct`, `escapeMarkdown` (helpers), `buildConfigSnapshotInput` (builder), `formatError` (dead code).

---

## DRY RUN Routing

When `DRY_RUN=true`, messages are tagged `(DRY RUN)` at the routing layer — not in formatters.

**Architecture:**
```
interfaces/tags.ts          ← single source of truth
     ↓
interfaces/index.ts         ← re-exports (outbound gate)
     ↓
telegram/index.ts           ← imports from tags.ts
index.ts, manage.ts, screen.ts ← import from interfaces/index.js
```

**Implementation:**
- `interfaces/tags.ts` — defines `dryRunTag()` and `dryRunTitle()`
- `interfaces/index.ts` — re-exports from `tags.ts`
- Consumers import from `interfaces/index.js`

**Convention (important):**
- Primitives (`sendMessage`, `sendLongMessage`, `createLiveMessage`) do NOT auto-tag
- Callers must wrap with `dryRunTag`/`dryRunTitle`, or use `notify*` helpers which wrap internally
- When integrating a new platform, refactor this gate to centralize tagging (opt-out pattern)

**Where tags are applied:**

| Layer | Location | What |
|-------|----------|------|
| LiveMessage title | `createLiveMessage()` in `telegram/index.ts` | Screening + management cycles |
| Notifications | `notifyDeploy/Close/Swap/OOR` in `telegram/index.ts` | Autonomous actions |
| Command responses | `index.ts` handlers | `/positions`, `/close`, `/closeall`, `/deploy` |
| Cycle fallbacks | `manage.ts:281`, `screen.ts:426` | Fallback when liveMessage is null |

**NOT tagged (intentionally):**
- `/help`, `/config`, `/set`, `/setcfg` — info messages
- `/vp` — already says "Virtual Positions"
- `/briefing` — daily summary
- Error-only replies

---

## Quick Reference

| Formatter | Trigger | DRY RUN |
|-----------|---------|---------|
| `formatHelpText` | `/help` | No |
| `formatWalletStatus` | `/status`, `/wallet` | No |
| `formatConfigSnapshot` | `/config`, settings menu | No |
| `formatPositions` | `/positions` | Yes |
| `formatPositionDetail` | `/pool <n>` | No |
| `formatVirtualPositions` | `/vp` | No (already "Virtual") |
| `formatCloseResult` | `/close <n>` | Yes |
| `formatCloseAllResult` | `/closeall` | Yes |
| `formatSetNote` | `/set <n> <note>` | No |
| `formatSetConfig` | `/setcfg <key> <value>` | No |
| `formatDeployResult` | `/deploy <n>` | Yes |
| `formatPause` | `/pause` | No |
| `formatResume` | `/resume` | No |
| `formatQueued` | busy queue | No |
| `formatQueueFull` | full queue | No |
| `formatDeployNotification` | autonomous deploy | Yes |
| `formatCloseNotification` | autonomous close | Yes |
| `formatSwapNotification` | autonomous swap | Yes |
| `formatOutOfRange` | autonomous OOR | Yes |
| `screen.ts` (LLM) | screening cycle | Yes |
| `generateBriefing` | `/briefing`, cron | No |
| `formatManagementReport` | management cycle | Yes |

---

## User Commands (sendMessage)

### `/help` — `formatHelpText()`

```
Telegram commands

/help — show commands
/status — wallet + positions snapshot
/wallet — wallet, deploy amount, HiveMind status
/positions — list open positions
/vp — list virtual (dry-run) positions
/vp report — generate dry-run HTML report
/pool <n> — detailed info for one open position
/close <n> — close one position by index
/closeall — close all open positions
/set <n> <note> — set note/instruction on position
/config — show important runtime config
/settings — button menu for common config
/setcfg <key> <value> — update persisted config
/screen — refresh deterministic candidate list
/candidates — show latest cached candidates
/deploy <n> — deploy candidate by cached index
/briefing — morning briefing
/hive — HiveMind sync status
/hive pull — manual HiveMind pull now
/pause — stop cron cycles
/resume — start cron cycles again
/stop — shut down agent
```

---

### `/status` — `formatWalletStatus()`

```ts
formatWalletStatus(
  { sol: 12.345, sol_usd: 2143.50, sol_price: 173.65 },
  { total_positions: 2 },
  { solMode: true, maxPositions: 3, deployAmount: 0.5, dryRun: false, hiveEnabled: true },
)
```

```
Wallet: 12.345 SOL ($ 2143.5)
SOL price: $ 173.65
Open positions: 2/3
Next deploy amount: 0.5 SOL
Dry run: no
HiveMind: on
```

---

### `/config` — `formatConfigSnapshot()`

```ts
formatConfigSnapshot({
  strategy: "dynamic-bins", minBinsBelow: 35, maxBinsBelow: 69, defaultBinsBelow: 50,
  deployAmountSol: 0.5, gasReserve: 0.2, maxPositions: 3,
  stopLossPct: -25, takeProfitPct: 50,
  trailingTakeProfit: true, trailingTriggerPct: 30, trailingDropPct: 10,
  outOfRangeWaitMinutes: 30, oorCooldownTriggerCount: 3, oorCooldownHours: 24,
  repeatDeployCooldownEnabled: true, repeatDeployCooldownTriggerCount: 2,
  repeatDeployCooldownHours: 12, repeatDeployCooldownMinFeeEarnedPct: 5,
  repeatDeployCooldownScope: "global",
  minFeePerTvl24h: 1.5, minAgeBeforeYieldCheck: 60,
  screeningCategory: "trending", screeningTimeframe: "5m",
  minTvl: 10000, maxTvl: 150000,
  managementIntervalMin: 10, screeningIntervalMin: 30,
  hiveEnabled: true, agentId: "agent-meridian-7f8a",
})
```

```
Config snapshot

Strategy: dynamic-bins | binsBelow: 35-69 | default 50
Deploy: 0.5 SOL | gasReserve: 0.2 | maxPositions: 3
Stop loss: -25% | take profit: 50%
Trailing: on | trigger 30% | drop 10%
OOR: 30m | cooldown 3x / 24h
Repeat deploy cooldown: on | 2x / 12h | min fee earned 5% | global
Yield floor: 1.5% | min age 60m
Screening: trending / 5m | TVL 10000-150000
Intervals: manage 10m | screen 30m
HiveMind: enabled | agent-meridian-7f8a
```

---

### `/positions` — `formatPositions()`

Two positions, `solMode=true`:

**Formatter output** (clean, no DRY RUN):
```
📊 Open Positions (2):

1. SOL\_USDC | ◎ 25.5 | PnL: +◎ 2.5 | fees: ◎ 1.2345 | 45m 🟢 IN
2. JUP\_SOL | ◎ 12.3 | PnL: -◎ 1.5 | fees: ◎ 0.4521 | 180m 🔴 OOR

/close <n> to close | /set <n> <note> to set instruction
```

**Telegram output** (with DRY RUN tag from routing layer):
```
(DRY RUN) 📊 Open Positions (2):

1. SOL\_USDC | ◎ 25.5 | PnL: +◎ 2.5 | fees: ◎ 1.2345 | 45m 🟢 IN
2. JUP\_SOL | ◎ 12.3 | PnL: -◎ 1.5 | fees: ◎ 0.4521 | 180m 🔴 OOR

/close <n> to close | /set <n> <note> to set instruction
```

> **Why:** DRY RUN tag is added by `dryRunTag()` in the routing layer, not in the formatter. Formatters stay pure (no `process.env` imports).

Empty list (no change):
```
No open positions.
```

---

### `/pool <n>` — `formatPositionDetail()`

**In range:**
```
1. SOL\_USDC
Pool: 8sNq3MUMzw6e7Z7xRpG6v1Z7Z8Z7Z8Z7Z8Z8Z8Z8Z8Z8
Position: pos_abc123def456ghi789
Range: 100 → 140 | active 120
PnL: 12.5% | fees: ◎ 1.2345
Value: ◎ 25.5
Age: 45m | 🟢 IN RANGE
```

**Out of range with instruction:**
```
2. JUP\_SOL
Pool: 4rQ7A8bCdEfGhIjKlMnOpQrStUvWxYz1234567890a
Position: pos_xyz789ghi012jkl345
Range: 200 → 240 | active 250
PnL: -8.3% | fees: ◎ 0.4521
Value: ◎ 12.3
Age: 180m | 🔴 OOR 35m
Note: Close if OOR > 30m
```

---

### `/vp` — `formatVirtualPositions()`

**Current** — single line per position:
```
📊 Virtual Positions (2):

vp\_3f8a2b9c1d4e5f6a | BONK\_SOL | PnL: 18.70% | fees: ◎ 0.79 | 🟢 IN
vp\_1a2b3c4d5e6f7890 | WIF\_SOL | PnL: -3.20% | fees: ◎ 0.12 | 🔴 OOR
```

**Proposed** — multi-line per position:
```
📊 Virtual Positions (2)

1. BONK\_SOL 🟢 IN
   PnL: 18.70% | fees ◎ 0.79
   ID: vp\_3f8a2b9c1d4e5f6a

2. WIF\_SOL 🔴 OOR
   PnL: -3.20% | fees ◎ 0.12
   ID: vp\_1a2b3c4d5e6f7890
```

> **Why:** Same multi-line format as `/positions`. Pair + status on line 1, numbers on line 2, ID on line 3. DRY RUN tag added.

Empty list:
```
No open virtual positions.
```

---

### `/close <n>` — `formatCloseResult()`

**Formatter output** (clean, no DRY RUN):
```
✅ Closed SOL\_USDC

PnL: ◎ 2.5
Tx: 5xK9pQ3mN7rT2vW8yB4cF6gH1jL3nP5qR8sU2wX4zA7bC
```

**Telegram output** (with DRY RUN tag from routing layer):
```
(DRY RUN) ✅ Closed SOL\_USDC

PnL: ◎ 2.5
Tx: 5xK9pQ3mN7rT2vW8yB4cF6gH1jL3nP5qR8sU2wX4zA7bC
```

> **Why:** DRY RUN tag is added by `dryRunTag()` in the routing layer, not in the formatter.

**Live success with claim:**
```
(DRY RUN) ✅ Closed JUP\_SOL

PnL: $ -1.5
Tx: 3aB7cD9eF1gH2iJ3kL4mN5oP6qR7sT8uV9wX0yZ1aB2c
Claim: 2xY4zA6bC8dE0fG1hI2jK3lM4nO5pQ6rS7tU8vW9xY0zZ
```

**VP success:**
```
✅ Closed VP BONK\_SOL

PnL: 18.70% | ◎ 1.4000
```

**Failure:**
```
❌ Close failed: SOL\_USDC

Transaction simulation failed: insufficient SOL for fees
```

> **Why:** Raw JSON is unreadable on mobile. Extract the error message, show which pair failed.

---

### `/closeall` — `formatCloseAllResult()`

**Formatter output** (clean, no DRY RUN):
```
Close-all finished.

SOL\_USDC: closed PnL 12.50%
JUP\_SOL: failed (RPC timeout)
BONK\_SOL (VP): closed PnL 18.70%
```

**Telegram output** (with DRY RUN tag from routing layer):
```
(DRY RUN) Close-all finished.

SOL\_USDC: closed PnL 12.50%
JUP\_SOL: failed (RPC timeout)
BONK\_SOL (VP): closed PnL 18.70%
```
   PnL: 18.70%
```

> **Why:** Multi-line separates each position with status icon. Error messages are extracted from inline to dedicated line.

> **Why:** When closing multiple positions, knowing the mode at a glance prevents confusion.

---

### `/set <n> <note>` — `formatSetNote()`

```
✅ Note set for SOL\_USDC:
"Close if PnL > 30%"
```

---

### `/setcfg <key> <value>` — `formatSetConfig()`

**Success:**
```
✅ Updated deployAmountSol = 0.75
```

**Unknown key:**
```
Config update failed.
Unknown: foo, bar
```

---

### `/deploy <n>` — `formatDeployResult()`

**Formatter output** (clean, no DRY RUN):
```
✅ Deployed WIF\_SOL
Pool: WIFpEP9o8XvK7kH4sB2nQ5rT8uV1wX4yZ7aB3cD6eF9g
Amount: 0.5 SOL
Range: 18.50% downside | 24.30% upside
Position: pos\_dep\_abc123def456ghi789
Tx: 9xK2pQ5mN8rT3vW6yB9cF2gH5jL8nP1qR4sU7wX0zA3b
```

**Telegram output** (with DRY RUN tag from routing layer):
```
(DRY RUN) ✅ Deployed WIF\_SOL
Pool: WIFpEP9o8XvK7kH4sB2nQ5rT8uV1wX4yZ7aB3cD6eF9g
Amount: 0.5 SOL
Range: 18.50% downside | 24.30% upside
Position: pos\_dep\_abc123def456ghi789
Tx: 9xK2pQ5mN8rT3vW6yB9cF2gH5jL8nP1qR4sU7wX0zA3b
```

> **Why:** Deploying real SOL vs paper — must be unambiguous.

**Without range coverage (fallback):**
```
✅ Deployed JTO\_SOL
Pool: JTOpEP9o8XvK7kH4sB2nQ5rT8uV1wX4yZ7aB3cD6eF9g
Amount: 0.5 SOL
Strategy: dynamic-bins | binsBelow: 35
Position: pos\_dep\_xyz789ghi012jkl345
```

---

### `/pause` — `formatPause()`

```
⏸ Paused autonomous cycles. Telegram control still works. Use /resume to start again.
```

---

### `/resume` — `formatResume()`

**Was paused:**
```
▶️ Autonomous cycles resumed.
```

**Already running:**
```
Autonomous cycles are already running.
```

---

### Busy queue — `formatQueued()`

```
⏳ Queued (2 in queue): "what positions are open?"
```

---

### Full queue — `formatQueueFull()`

```
Queue is full (5 messages). Wait for the agent to finish.
```

---

## Autonomous Notifications (sendLongMessage)

These fire automatically from `interfaces/telegram/index.ts` after tool execution or management cycle events.

---

### Deploy notification — `formatDeployNotification()`

**Formatter output** (clean, no DRY RUN):
```
✅ **Deployed** WIF\_SOL
Amount: 0.5 SOL
Price range: 2.340e-5 – 8.760e-5
Range cover: 18.50% downside | 24.30% upside | 42.80% total
Bin step: 100  |  Base fee: 0.2%
Position: `pos_dep_...`
Tx: `9xK2pQ5mN8rT3vW6...`
```

**Telegram output** (with DRY RUN tag from routing layer):
```
(DRY RUN) ✅ **Deployed** WIF\_SOL
Amount: 0.5 SOL
Price range: 0.0000234 – 0.0000876
Range cover: 18.50% downside | 24.30% upside | 42.80% total
Bin step: 100  |  Base fee: 0.2%
Position: `pos_dep_...`
Tx: `9xK2pQ5mN8rT3vW6...`
Tx: `9xK2pQ5mN8rT3vW6...`
```

> **Why:** `2.340e-5` is hard to parse mentally. `0.0000234` is immediately readable as a small token price. DRY RUN tag added to header.

**Minimal opts (no change):**
```
✅ **Deployed** JTO\_SOL
Amount: 0.5 SOL
Position: `pos_dep_...`
Tx: `3aB7cD9eF1gH2iJ3...`
```

---

### Close notification — `formatCloseNotification()`

**Formatter output** (clean, no DRY RUN):
```
🔒 **Closed** SOL\_USDC
PnL: +$2.50 (+12.50%)
```

**Telegram output** (with DRY RUN tag from routing layer):
```
(DRY RUN) 🔒 **Closed** SOL\_USDC
PnL: +$2.50 (+12.50%)
```

**Negative PnL:**
```
(DRY RUN) 🔒 **Closed** JUP\_SOL
PnL: $-1.50 (-8.30%)
```

---

### Swap notification — `formatSwapNotification()`

**Formatter output** (clean, no DRY RUN):
```
🔄 **Swapped** JUP\_SOL → SOL
In: 5.234 | Out: 0.0123
Tx: `8xY1zA4bC7dE0fG3...`
```

**Telegram output** (with DRY RUN tag from routing layer):
```
(DRY RUN) 🔄 **Swapped** JUP\_SOL → SOL
In: 5.234 | Out: 0.0123
Tx: `8xY1zA4bC7dE0fG3...`
```

---

### Out-of-range notification — `formatOutOfRange()`

**Formatter output** (clean, no DRY RUN):
```
⚠️ **Out of Range** JUP\_SOL
Been OOR for 35 minutes
```

**Telegram output** (with DRY RUN tag from routing layer):
```
(DRY RUN) ⚠️ **Out of Range** JUP\_SOL
OOR for 35m (threshold: 30m)
```

> **Why:** Shows the position exceeded the close-rule threshold (30m), making it clear why the bot may close it. DRY RUN tag added by routing layer.

---

## Management Cycle

### Screening cycle — `core/screen.ts` (LLM-generated)

**Source:** `createLiveMessage()` at `interfaces/telegram/index.ts:340` builds the header + tool progress. LLM generates the report body via `agentLoop()` at `screen.ts:318`.

**Full tool flow (15 tools, 3 phases):**

| Phase | Tool | Purpose |
|-------|------|---------|
| Pre-check | `getMyPositions` | Positions count |
| Pre-check | `getWalletBalances` | SOL balance |
| Pre-fetch | `getTopCandidates` | Pool candidates |
| Pre-fetch | `checkSmartWalletsOnPool` | Smart wallets per pool |
| Pre-fetch | `getTokenNarrative` | Narrative per token |
| Pre-fetch | `getTokenInfo` | Token info/audit |
| Pre-fetch | `getActiveBin` | Active bin per pool |
| LLM reasoning | `getWalletBalance` | Recheck SOL |
| LLM reasoning | `getMyPositions` | Recheck positions |
| LLM reasoning | `getTopCandidates` | Search more |
| LLM reasoning | `searchPools` | Search pools |
| LLM reasoning | `getPoolMemory` | Past deploys |
| LLM reasoning | `getTokenHolders` | Holder breakdown |
| LLM reasoning | `getPerformanceHistory` | Past performance |
| Action | `deployPosition` | Deploy (locked) |

**Flush behavior:** Fixed 1-second interval (not 300ms debounce). Tool progress updates are batched and sent at most once per second. `finalize()` and `fail()` bypass the interval.

**Full message structure (DEPLOY case):**
```
🔍 Screening Cycle (DRY RUN)                ← title (dryRunTitle adds tag)

Scanning candidates...                      ← intro

✅ get wallet balance — 2.5 SOL             ← pre-check
✅ get my positions — 2/3 open              ← pre-check

✅ get top candidates — 10 pools found      ← pre-fetch
✅ get smart wallets — 10/10 done           ← pre-fetch (per pool)
✅ get token narrative — 10/10 done         ← pre-fetch (per pool)
✅ get token info — 10/10 done              ← pre-fetch (per pool)
✅ get active bin — 5/5 done                ← pre-fetch (passing only)

✅ get token holders — done                 ← LLM reasoning
✅ get pool memory — done                   ← LLM reasoning

---                                         ← separator (LLM output starts here)

🚀 DEPLOYED                                 ← LLM-generated report

WIF\_SOL
pool\_address\_here

◎ 0.5 SOL | dynamic-bins | bin 142
Range: 0.0000234 → 0.0000876
Range cover: 18.50% downside | 24.30% upside | 42.80% total

MARKET
Fee/TVL: 8.4%
Volume: $ 45.2k
TVL: $ 12.3k
Volatility: 3.2
Organic: 85
Mcap: $ 250k
Age: 2.5h

AUDIT
Top10: 42%
Bots: 5%
Fees paid: 12.5 SOL
Smart wallets: AlphaVault, DegenTracker

RISK
Risk level: medium
Bundle: 15%
Sniper: 8%
ATH distance: -35%

WHY THIS WON
Strong narrative, 3 smart wallets present, healthy fee/TVL ratio.
```

**Full message structure (NO DEPLOY case):**
```
🔍 Screening Cycle
Scanning candidates...

✅ get wallet balance — 2.5 SOL
✅ get my positions — 2/3 open

✅ get top candidates — 10 pools found
✅ get smart wallets — 10/10 done
✅ get token narrative — 10/10 done
✅ get token info — 10/10 done
✅ get active bin — 5/5 done

✅ get token holders — done
✅ get pool memory — done

---

⛔ NO DEPLOY

Cycle finished with no valid entry.

BEST LOOKING CANDIDATE
Islands (1.5% fee, bin_step=125) — pool 8eAiYBthqQqQ29ntrRJoEhg7RF2vZya56P4wKDMvKHHV

WHY SKIPPED
Zero smart wallets across all 3 candidates...

REJECTED
- Islands (2.5%) — OOR in 3/5 cycles, 60% OOR rate
- SPCX (2%) — negative PnL drift, 33% win rate
```

**Tool progress format** (from `upsertToolLine` at `telegram/index.ts:401`):
- ⏳ `tool name` — tool started
- ✅ `tool name — done` — tool succeeded
- ❌ `tool name — failed` — tool failed

**Tool failure behavior:**
- `getTopCandidates` fails → cycle returns early ("No candidates available")
- Other pre-fetch tools fail → silently swallowed (null values in prompt)
- LLM can hallucinate data when tools fail (no enforcement) — tracked in `meridian-6ns`

**Proposed** — add DRY RUN to header:
- `screen.ts:134`: `createLiveMessage("🔍 Screening Cycle (DRY RUN)", "Scanning candidates...")`
- `screen.ts:426`: fallback `sendLongMessage(`🔍 Screening Cycle (DRY RUN)\n\n...`)`

> **Why:** Screening is the entry point for deploying real SOL. Must be unambiguous in paper-trading mode.

### Briefing — `generateBriefing()` (core/briefing.ts)

**Current** — HTML format (misaligned with all other formatters):
```
☀️ <b>Morning Briefing</b> (Last 24h)
────────────────
<b>Activity:</b>
📥 Positions Opened: 2
📤 Positions Closed: 1

<b>Performance:</b>
💰 Net PnL: +$12.50
💎 Fees Earned: $3.20
📈 Win Rate (24h): 67%

<b>Lessons Learned:</b>
• Avoid pools with >40% bundle holders
• Close OOR positions faster in high-vol

<b>Current Portfolio:</b>
📂 Open Positions: 3
📊 All-time PnL: $145.20 (72% win)
────────────────
```

**Proposed** — markdown (align with all other formatters):
```
☀️ **Morning Briefing** (Last 24h)
────────────────
**Activity:**
📥 Positions Opened: 2
📤 Positions Closed: 1

**Performance:**
💰 Net PnL: +$12.50
💎 Fees Earned: $3.20
📈 Win Rate (24h): 67%

**Lessons Learned:**
• Avoid pools with >40% bundle holders
• Close OOR positions faster in high-vol

**Current Portfolio:**
📂 Open Positions: 3
📊 All-time PnL: $145.20 (72% win)
────────────────
```

> **Why:** Every other formatter outputs markdown. Briefing is the only one that outputs HTML directly. This creates inconsistency — Briefing needs explicit `parse_mode: "HTML"` while others get auto-converted.
>
> **Requires:**
> 1. Update `core/briefing.ts` to return markdown (`<b>...</b>` → `**...**`)
> 2. Remove `parse_mode: "HTML"` from `index.ts:628` and `scheduler/index.ts:130`
> 3. Let `sendLongMessage()` handle conversion automatically (like all other formatters)

---

### Management report — `formatManagementReport()`

Three positions with mixed actions (solMode=true):

**Before:**
```
**SOL\_USDC** | Age: 45m | Val: ◎ 25.5 | Unclaimed: ◎ 1.2345 | PnL: 12.5% | Yield: 8.4% | 🟢 IN | STAY

**JUP\_SOL** | Age: 180m | Val: ◎ 12.3 | Unclaimed: ◎ 0.4521 | PnL: -8.3% | Yield: 2.1% | 🔴 OOR 35m | CLOSE
Note: "Close if OOR > 30m"
Rule oor: OOR 35m > 30m

**mSOL\_SOL** | Age: 420m | Val: ◎ 18.7 | Unclaimed: ◎ 3.4 | PnL: 22.1% | Yield: 6.8% | 🟢 IN | CLAIM
→ Claiming fees

Summary: 💼 3 positions | ◎ 56.5000 | fees: ◎ 5.0866 | CLOSE (OOR 35m > 30m), CLAIM, EVAL instruction
```

**After** — multi-line per position + DRY RUN header:
```
🔄 Management Cycle (DRY RUN)

**SOL\_USDC** 🟢 IN | STAY
  ◎ 25.5 | fees ◎ 1.2345 | PnL +12.5% | yield 8.4%
  Age: 45m

**JUP\_SOL** 🔴 OOR 35m | CLOSE
  ◎ 12.3 | fees ◎ 0.4521 | PnL -8.3% | yield 2.1%
  Age: 180m
  Note: "Close if OOR > 30m"
  Rule oor: OOR 35m > 30m

**mSOL\_SOL** 🟢 IN | CLAIM
  ◎ 18.7 | fees ◎ 3.4 | PnL +22.1% | yield 6.8%
  Age: 420m
  → Claiming fees

💼 3 positions | ◎ 56.5 | fees ◎ 5.09
Actions: CLOSE (OOR), CLAIM, EVAL instruction
```

> **Why:** The single-line-per-position format is too dense for mobile scanning. The proposed layout puts status + action on line 1 (what's happening), numbers on line 2 (the data), and age on line 3 (context). Summary is split into totals + action list. DRY RUN tag in the header is added by `dryRunTitle()` in the routing layer.

**Detail-line rules** (unchanged):
- `INSTRUCTION` → `HOLD (instruction)` on position line
- `CLOSE` + `rule === "exit"` → `⚡ Trailing TP: {reason}`
- `CLOSE` + other rule → `Rule {rule}: {reason}`
- `CLAIM` → `→ Claiming fees`
- Position has `instruction` → `Note: "{instruction}"`
