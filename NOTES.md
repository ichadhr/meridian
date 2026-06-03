# Notes

## Virtual Positions & Learning System

### Decision
Virtual positions call `recordPoolDeploy()` directly — NOT `recordPerformance()`.

### Why
`recordPerformance()` feeds into:
- **lessons.json** — `derivLesson()` produces LLM-prompt rules with 0.82–0.88 confidence. No source attribution. The LLM cannot distinguish virtual lessons from real ones.
- **`evolveThresholds()`** — mutates screening thresholds in `user-config.json` (minFeeActiveTvlRatio, minOrganic). Virtual PnL lacks slippage/MEV/execution risk.
- **Darwinian signal weights** — 10-min sample minimum, ±5% per recalc. Miscalibrated weights are worse than no weights.
- **HiveMind sync** — pushes lessons and performance to shared collective intelligence. Other agents consume them. No `is_virtual` field exists in the payload.

### What `recordPoolDeploy()` covers
- pool-memory.json for screener cooldowns ("past loss → hard skip")
- Per-pool deploy history, win rate, avg PnL
- Repeat-deploy cooldowns

### Future Path
Switching from `recordPoolDeploy` to `recordPerformance` later is a one-line change. No backfilling needed — pool-memory already captures all the data. When real closes start accumulating, they naturally override the learning system.

### Oracle Verdict
> "Pool-memory only for now. Go live with defaults. The learning system needs real closes anyway."

## `deployed_at` Gap in Real Positions

Both close paths in `dlmm.js` (relay ~L1784, legacy ~L2071) pass `recordPerformance` but omit `deployed_at`. The data exists in `tracked.deployed_at` from `state.js` — it's just not forwarded. Two-line fix needed when we pick this up.
