# Circular Dependency: Analysis & Resolution

> [!NOTE]
> **Status: ✅ Implemented.** The event bus approach (Approach E) is already live in the codebase.
> Verified: `tsc --noEmit` clean, 119/119 tests passing.

## Problem

The module graph contained a circular dependency path:

```
scheduler/index.ts
  → core/index.ts
    → core/live/manage.ts
      → llm/index.ts
        → llm/tools/executor.ts
          → scheduler/index.ts  ← cycle closes here
```

Two links create the cycle:

| Link | From | To | Import |
|------|------|----|--------|
| **#1** | `core/live/manage.ts` | `llm/index.ts` | `agentLoop` |
| **#2** | `llm/tools/executor.ts` | `scheduler/index.ts` | `restartCronJobs` |

### Current Impact

- **None in practice.** tsc compiles, 119 tests pass, Node.js resolves the cycle at runtime without initialization races.
- The risk is latent: future changes could introduce top-level initialization dependencies between these modules, causing subtle `undefined` import bugs that are hard to diagnose.

---

## Evaluated Approaches

### ❌ Approach A: Inject `agentLoop` into `ManageDeps` (break link #1)

The idea: add a `runAgent` callback to `ManageDeps`, pass `agentLoop` from `scheduler/index.ts` at the call site, so `core/live/manage.ts` no longer imports from `llm/`.

**Why rejected:**

- **~50 lines of churn** across 4 files (`manage.ts`, `screen.ts`, `scheduler/index.ts`, `core/index.ts`)
- **Pushes LLM wiring into scheduler** — `scheduler/index.ts` should call `runLiveManagementCycle` and `runScreeningCycle` as black boxes, not need to know about `agentLoop`'s signature
- **Adds a `ScreenDeps` type** to `runScreeningCycle` that currently takes only `{ silent }` — unnecessary complexity for a function that works fine with its direct import
- Breaks at the more expensive link (#1) instead of the cheaper one (#2)

### ❌ Approach B: Setter pattern (`setScreeningAgentRunner`)

The idea: a module-level `let _runAgent` variable set via an exported setter, called once at startup.

**Why rejected:**

- **Global mutable state** — a code smell worse than the circular import it replaces
- Introduces a temporal coupling: if the setter isn't called before the first screening cycle, you get a runtime null crash instead of a compile-time import error
- No improvement over the status quo

### ❌ Approach C: Return flags from `executeTool`

The idea: instead of `executor.ts` calling `restartCronJobs()` directly, return `{ needsCronRestart: true }` and observe the flag in `onToolFinish`.

**Why rejected:**

- `onToolFinish` is a **UI hook** (Telegram live messages), not a control flow mechanism
- Flags would need to propagate through the agent loop back to the scheduler — complex plumbing for a simple "restart crons" call
- `index.ts` Telegram handler also calls `executeTool` directly — all those call sites would need updating

### ❌ Approach D: Dynamic `import()` in executor

The idea: replace the static `import` with `const { restartCronJobs } = await import("../../scheduler/index.js")`.

**Why rejected (as primary fix):**

- Technically works — breaks the static cycle, Node caches the module
- But it **hides** the dependency rather than fixing the architecture
- Acceptable as a tactical patch, not as the recommended long-term solution

### ✅ Approach E: Event bus (break link #2) — **Recommended**

The idea: `executor.ts` emits a `"cron-config-changed"` event instead of calling `restartCronJobs()` directly. The scheduler subscribes to this event.

**Why this wins:**

- **Fixes a real layer violation.** A tool handler (`executor.ts`) should not reach up into the scheduler. It should announce what happened; the scheduler decides what to do.
- **~10 lines of churn** across 3 files — smallest footprint of any option
- **Proper semantics.** "Config changed" *is* an event. The subscriber pattern matches the domain.
- **Breaks at the cheapest point.** Link #2 is one import (`restartCronJobs`). Link #1 is `agentLoop`, which is deeply used in `manage.ts`.
- **Easy to discover.** `grep "cron-config-changed"` finds both emitter and listener instantly.

---

## Implementation (Live)

### Files Changed

#### 1. [utils/events.ts](file:///Users/ichadhr/Develop/node/meridian/utils/events.ts) — **NEW**

Typed event bus wrapping `EventEmitter`. The `Events` type map ensures compile-time safety — you can't emit or subscribe to an event that doesn't exist.

```typescript
type Events = {
  "cron-config-changed": () => void;
};

const emitter = new EventEmitter();
export const bus = {
  on<K extends keyof Events>(event: K, listener: Events[K]): void { ... },
  emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): void { ... },
  removeAllListeners<K extends keyof Events>(event: K): void { ... },
};
```

#### 2. [executor.ts](file:///Users/ichadhr/Develop/node/meridian/llm/tools/executor.ts) — **MODIFIED**

- Removed: `import { restartCronJobs } from "../../scheduler/index.js";`
- Added: `import { bus } from "../../utils/events.js";`
- Call site (line 608): `bus.emit("cron-config-changed")` inside `update_config` handler

#### 3. [scheduler/index.ts](file:///Users/ichadhr/Develop/node/meridian/scheduler/index.ts) — **MODIFIED**

- Added: `import { bus } from "../utils/events.js";`
- Subscription wired inside `initScheduler()` (line 59–60) with a `removeAllListeners` guard to prevent duplicate listeners on re-init:

```typescript
export function initScheduler(opts: { healthCheckFn: () => Promise<void> }): void {
  _healthCheckFn = opts.healthCheckFn;
  bus.removeAllListeners("cron-config-changed");
  bus.on("cron-config-changed", () => restartCronJobs());
}
```

`restartCronJobs` remains exported (used by CLI) but is no longer imported by executor.

### Resulting Dependency Graph

```
BEFORE (cycle):
scheduler → core → llm → executor → scheduler

AFTER (DAG):
scheduler → core → llm → executor → utils/events
scheduler → utils/events (subscribe only, no back-edge)
```

```mermaid
graph LR
    S[scheduler] --> C[core]
    C --> M[manage]
    M --> L[llm]
    L --> E[executor]
    E --> EV[utils/events]
    S -.->|subscribes| EV
    style EV fill:#2d6a4f,stroke:#1b4332,color:#fff
```

---

## Verification Results

| Check | Result |
|-------|--------|
| `tsc --noEmit` | ✅ Clean, zero errors |
| `npx vitest run` | ✅ 9 files, 119/119 tests passed |
| `grep -r "scheduler" llm/tools/executor.ts` | ✅ No imports from scheduler (only a comment explaining why) |
| Cycle broken | ✅ `executor.ts` → `utils/events.ts` (no back-edge to scheduler) |

### Remaining Runtime Verification

- [ ] Change a cron interval via Telegram or REPL `update_config`, verify crons restart (log line: `"Cycles started"`)
