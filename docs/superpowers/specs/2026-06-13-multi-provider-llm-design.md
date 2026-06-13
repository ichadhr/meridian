# Multi-Provider LLM Support — Design Spec

## Problem

Meridian currently uses a single OpenAI client pointed at one `LLM_BASE_URL` (defaults to OpenRouter). The `managementModel`, `screeningModel`, and `generalModel` config fields let you pick different model names, but they all go through the same provider endpoint. There's no way to use different providers for different roles (e.g., Anthropic for screening, OpenRouter for management, local LM Studio for general chat) or to fail over to a backup provider when the primary is down.

## Solution

**Provider Registry approach** — each role specifies a primary provider + per-role failover chain. Provider credentials live in `.env` (gitignored), role config lives in `user-config.json` (shareable).

## Design

### 1. Provider Environment Variables

Provider credentials are defined in `.env` using a naming convention with `LLM_PROVIDER_` prefix:

```
LLM_PROVIDER_{NAME}_BASE_URL=<endpoint>
LLM_PROVIDER_{NAME}_APIKEY=<key>
```

Examples:
```env
# ─── LLM Providers ─────────────────────────────────────
# Add providers here. NAME is uppercase, used as lookup key in user-config.json.
# At least one provider must be configured.

LLM_PROVIDER_OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
LLM_PROVIDER_OPENROUTER_APIKEY=sk-or-...

LLM_PROVIDER_ANTHROPIC_BASE_URL=https://api.anthropic.com/v1
LLM_PROVIDER_ANTHROPIC_APIKEY=sk-ant-...

# Local model (LM Studio, Ollama, etc.)
LLM_PROVIDER_LOCAL_BASE_URL=http://localhost:1234/v1
LLM_PROVIDER_LOCAL_APIKEY=lm-studio
```

**Naming convention:**
- `LLM_PROVIDER_` prefix (required — avoids collision with other tools)
- Provider name (uppercase, alphanumeric + underscore)
- `_BASE_URL` suffix (required)
- `_APIKEY` suffix (required — use any string for local models)

**Legacy env var fallback:** If no `LLM_PROVIDER_*` vars exist, fall back to existing `LLM_BASE_URL` / `LLM_API_KEY` / `OPENROUTER_API_KEY` as the default provider (named `"default"`).

### 2. User Config — Per-Role Provider + Model + Fallback

`user-config.json` `llm` section:

```json
{
  "llm": {
    "screeningModel": {
      "provider": "anthropic",
      "model": "claude-opus-4-5",
      "fallback": [
        { "provider": "openrouter", "model": "healer-alpha" }
      ]
    },
    "managementModel": {
      "provider": "openrouter",
      "model": "healer-alpha",
      "fallback": [
        { "provider": "local", "model": "backup-model" }
      ]
    },
    "generalModel": {
      "provider": "local",
      "model": "my-model"
    },

    "temperature": 0.373,
    "maxTokens": 4096,
    "maxSteps": 20,
    "thinkingScreening": true,
    "thinkingManagement": false,
    "thinkingGeneral": false
  }
}
```

**Model config shape:**

```ts
interface ModelConfig {
  provider: string;                    // lookup key into env-defined providers (lowercase)
  model: string;                       // model name sent to the API
  fallback?: Array<{                   // optional failover chain
    provider: string;                  //   each entry is a full provider+model pair
    model: string;
  }>;
}
```

**Why full objects in fallback (not bare strings):** `"fallback": ["openrouter/healer-alpha"]` is ambiguous about which provider to use when the primary is a different provider. Full objects remove this ambiguity — each fallback entry explicitly names its provider.

### 3. Backward Compatibility

Two migration paths:

**Legacy string format (still works):**
```json
"managementModel": "openrouter/healer-alpha"
```
Parsed as: `ModelConfig { provider: "openrouter", model: "healer-alpha", fallback: [] }`.

**Bare model name (still works):**
```json
"managementModel": "healer-alpha"
```
Parsed as: `ModelConfig { provider: "default", model: "healer-alpha", fallback: [] }`.

**Env var fallback (still works):**
If no `LLM_PROVIDER_*` env vars exist, fall back to existing `LLM_BASE_URL` / `LLM_API_KEY` / `OPENROUTER_API_KEY` as the default provider (named `"default"`).

### 4. Provider Resolution at Runtime

```
resolveProvider(role) → { client: OpenAI, model: string }
```

1. Read role config (e.g., `config.llm.screeningModel`)
2. If string → parse as `provider/model` or use default provider
3. If object → use `provider` field to look up env vars
4. Return pre-created client + model name

### 5. Error Classification

Not all errors are equal. Classify before retrying/failover:

```ts
type ErrorDisposition = "retry" | "failover" | "fatal";

function classifyError(error: any): ErrorDisposition {
  const status = error.status ?? error.code;
  const msg = String(error.message || "");

  // Fatal — don't waste credits retrying or failovering
  if (status === 401 || status === 403) return "fatal";    // auth error
  if (status === 400 && !/rate|limit|timeout/i.test(msg)) return "fatal"; // bad request
  if (status === 413 || status === 422) return "fatal";    // context/payload too large

  // Retry — transient, same provider might recover
  if (status === 429) return "retry";        // rate limit — wait and retry
  if (status === 502 || status === 503 || status === 529) return "retry"; // provider overload
  if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET/i.test(msg)) return "retry"; // network

  // Failover — provider is broken, try next in chain
  return "failover";
}
```

### 6. Failover Logic

When a provider call fails:

1. Classify the error
2. If `"retry"` — wait (exponential backoff) and retry same provider (up to 2 retries)
3. If `"failover"` — walk the fallback chain:
   - For each fallback entry, resolve its provider client
   - Retry the same request
   - If fallback also fails, continue to next
4. If `"fatal"` — throw immediately, no retry, no failover
5. If all fallbacks exhausted, throw the original error

**429 handling:** Current code sleeps 30s on the same provider. With multi-provider, 429 should failover immediately to the next provider (rate limits are per-provider — sleeping won't help if the provider is throttling you).

**Current hardcoded fallback (`stepfun/step-3.5-flash:free`) is removed.** Replaced by per-role `fallback` arrays. If no `fallback` is configured, there's no automatic fallback.

### 7. Client Creation — Eager at Startup

OpenAI clients are created eagerly at startup, not lazily. Max ~3 providers in practice.

```ts
const clients = new Map<string, OpenAI>();

export function initProviders(): void {
  // Scan env for LLM_PROVIDER_* entries
  const providers = discoverProviders();
  for (const name of providers) {
    const baseUrl = process.env[`LLM_PROVIDER_${name.toUpperCase()}_BASE_URL`];
    const apiKey  = process.env[`LLM_PROVIDER_${name.toUpperCase()}_APIKEY`];
    clients.set(name, new OpenAI({
      baseURL: baseUrl!,
      apiKey: apiKey || "dummy",
      timeout: 5 * 60 * 1000,
    }));
  }

  // Legacy fallback: create "default" provider from LLM_BASE_URL / LLM_API_KEY
  if (!clients.has("default")) {
    const baseUrl = process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1";
    const apiKey  = process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY || "dummy";
    clients.set("default", new OpenAI({ baseURL: baseUrl, apiKey, timeout: 5 * 60 * 1000 }));
  }
}

export function getClient(provider: string): OpenAI {
  const client = clients.get(provider);
  if (!client) throw new Error(`Provider "${provider}" not configured — set LLM_PROVIDER_${provider.toUpperCase()}_BASE_URL in .env`);
  return client;
}
```

**Discovery:** Scan `process.env` for keys matching `LLM_PROVIDER_[A-Z]+_BASE_URL`, extract the provider name, validate that `LLM_PROVIDER_{NAME}_APIKEY` also exists.

### 8. Config Loading Changes

`config/index.ts` `llm` section is updated to support both formats:

```ts
llm: {
  // ... existing scalar fields unchanged ...
  managementModel: parseModelConfig("managementModel", "openrouter/healer-alpha"),
  screeningModel:  parseModelConfig("screeningModel",  "openrouter/hunter-alpha"),
  generalModel:    parseModelConfig("generalModel",    "openrouter/healer-alpha"),
}
```

`parseModelConfig()` handles:
- String → legacy format, parsed into `ModelConfig`
- Object → new format, validated and returned as-is
- Missing → default

### 9. `agentLoop` Model Parameter

`agentLoop`'s `model` parameter accepts `ModelConfig | string`:

```ts
export async function agentLoop(
  goal: string,
  maxSteps: number,
  sessionHistory: any[],
  agentType: AgentType,
  model: ModelConfig | string | null,  // ← updated type
  maxOutputTokens: number | null,
  options: AgentLoopOptions,
): Promise<AgentLoopResult> {
  const resolved = resolveModel(model, agentType);
  // resolved = { client: OpenAI, model: string }
  // ... use resolved.client for API calls ...
}
```

All existing callers pass `config.llm.{role}Model` which is now a `ModelConfig` — no caller changes needed.

### 10. `.env.example` Update

Add documented provider section:

```env
# ─── LLM Providers ─────────────────────────────────────────────
# Configure one or more LLM providers. Each needs a BASE_URL and APIKEY.
# Provider name (uppercase) is used as lookup key in user-config.json.
#
# Examples:
#   LLM_PROVIDER_OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
#   LLM_PROVIDER_OPENROUTER_APIKEY=sk-or-...
#
#   LLM_PROVIDER_ANTHROPIC_BASE_URL=https://api.anthropic.com/v1
#   LLM_PROVIDER_ANTHROPIC_APIKEY=sk-ant-...
#
#   LLM_PROVIDER_LOCAL_BASE_URL=http://localhost:1234/v1
#   LLM_PROVIDER_LOCAL_APIKEY=lm-studio
#
# At least one provider must be configured. If none are set, falls back to
# LLM_BASE_URL / LLM_API_KEY / OPENROUTER_API_KEY (legacy behavior).
#
# No quotes needed around values.

LLM_PROVIDER_OPENROUTER_BASE_URL=
LLM_PROVIDER_OPENROUTER_APIKEY=
```

### 11. `update_config` Tool Persistence

The `update_config` tool in `llm/tools/executor.ts` can mutate config at runtime and persists to `user-config.json`. When a user updates a model field via chat, the new value must be:
1. Parsed through `parseModelConfig()` before assigning to the live `config` object
2. Persisted as the object shape (not stringified blob) to `user-config.json`

If the user passes a string like `"anthropic/claude-opus-4-5"`, auto-convert to `{ provider: "anthropic", model: "claude-opus-4-5", fallback: [] }` before persisting.

## Files Changed

| File | Change |
|------|--------|
| `.env.example` | Add `LLM_PROVIDER_*` documentation and example entries |
| `types/index.ts` | Add `ModelConfig` interface, update `LlmConfig` model fields |
| `config/index.ts` | Add `parseModelConfig()`, `discoverProviders()`, `initProviders()`, update `llm` section |
| `llm/agent.ts` | Replace single `client` with `getClient(provider)`, add `classifyError()`, failover loop |
| `llm/tools/executor.ts` | Update `update_config` to handle `ModelConfig` objects on persistence |
| `CLAUDE.md` | Update model configuration docs |
| `docs/structures/6.LLM_FOLDER.md` | Update provider architecture docs |

## Edge Cases

| Scenario | Handling |
|----------|----------|
| Provider not in env | Throw clear error: `Provider "X" not configured — set LLM_PROVIDER_X_BASE_URL in .env` |
| Empty fallback array | No fallback — fail immediately |
| Fallback provider also fails | Continue to next in chain, or throw if exhausted |
| Mixed legacy + new format | Legacy strings auto-parsed into `ModelConfig` shape |
| `DRY_RUN=true` | No change — providers are used regardless of dry run |
| Local model down | Fallback to next in chain, or throw |
| 429 rate limit | Failover immediately to next provider (don't sleep on same provider) |
| 401/403 auth error | Fatal — throw immediately, no retry/failover |

## Migration

No breaking changes. Existing configs with bare model strings continue to work. Users opt into multi-provider by:
1. Adding `LLM_PROVIDER_*` env vars to `.env`
2. Updating `user-config.json` model fields to the object format
