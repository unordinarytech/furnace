---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
created: 2026-07-04
plan_type: feat
product_contract_source: ce-plan-bootstrap
---

# feat: Multi-provider `/login` with provider selector and custom providers

## Goal Capsule

Replace the single-OpenRouter auth flow with a Pi/Factory-style multi-provider system. `/login` opens a provider selector listing built-in providers (OpenRouter, OpenAI, Anthropic, DeepSeek, GLM) and any user-defined custom providers. Users pick a provider, enter an API key, and the provider becomes active. Custom providers are defined in `~/.furnace/providers.json` (Factory-style `customModels` array) with model slugs, base URLs, API keys, and protocol types. A provider abstraction replaces the hardcoded OpenRouter calls, with an OpenAI-compatible adapter covering most providers and a native Anthropic Messages API adapter for direct Anthropic access. OAuth is stubbed ("API key only for now").

---

## Requirements

| ID | Requirement |
|----|-------------|
| R1 | `/login` opens a provider selector screen listing all built-in and custom providers with key-status indicators |
| R2 | Selecting a provider with no saved key shows the masked API key entry screen; selecting one with a saved key shows "already configured" with option to update or switch |
| R3 | OAuth option appears in the auth method selector for providers that may support it, but shows "API key only for now" when selected (stub) |
| R4 | Active provider is persisted in preferences and restored on next launch |
| R5 | `~/.furnace/providers.json` lets users define custom providers with `name`, `baseUrl`, `provider` (protocol type), `apiKey`, `models` array |
| R6 | `auth.json` stores API keys indexed by provider ID; `resolveKeyValue` handles `!cmd` shell resolution for any provider key |
| R7 | Provider abstraction (`Provider` interface) with `streamChat`, `completeChat`, `completeToolChat`, `listModels` methods |
| R8 | OpenAI-compatible adapter covers OpenRouter, OpenAI, DeepSeek, GLM, and custom OpenAI-compatible providers by parameterizing base URL and auth header |
| R9 | Anthropic native adapter implements the Anthropic Messages API (different request format, streaming, tool call shape, auth header) |
| R10 | `/model` command fetches model list from the active provider's endpoint; custom providers with static `models` arrays use those instead of an API call |
| R11 | Existing `OPENROUTER_API_KEY` env var and existing `auth.json` `openrouter` key continue to work (backward compat) |
| R12 | `--api-key` CLI flag overrides the active provider's key at runtime |
| R13 | Bare message submit with no key for the active provider shows status notice pointing to `/login` |

---

## Key Technical Decisions

**KTD1 — Provider interface:** A `Provider` interface in `src/providers/types.ts` with methods `streamChat`, `completeChat`, `completeToolChat`, `listModels`. Each adapter implements this interface. The agent loop and CLI call through the interface, never directly to OpenRouter functions. This is the same separation Pi uses (`BaseModel`/`OpenAIModel`/`AnthropicModel`).

**KTD2 — Two protocol types:** `openai-compatible` (OpenAI Chat Completions format: `POST /v1/chat/completions`, `Authorization: Bearer`, SSE streaming with `data:` lines, tool calls as `tool_calls` array) and `anthropic` (Anthropic Messages API: `POST /v1/messages`, `x-api-key` + `anthropic-version` headers, SSE with `content_block_delta` events, tool calls as `tool_use`/`tool_result` content blocks). DeepSeek, GLM, and generic custom providers use `openai-compatible`.

**KTD3 — Built-in providers:** Defined as static config in `src/providers/registry.ts`. Each has an `id`, `displayName`, `baseUrl`, `protocol` (`openai-compatible` or `anthropic`), and `envVar` (fallback env var name). Built-ins: `openrouter` (existing), `openai`, `anthropic`, `deepseek`, `glm`. No API keys are hardcoded — all come from `auth.json` or env vars.

**KTD4 — Custom providers file:** `~/.furnace/providers.json` with shape:
```
{
  "providers": [
    {
      "id": "my-local-llm",
      "displayName": "Local LLM",
      "baseUrl": "http://localhost:11434/v1",
      "protocol": "openai-compatible",
      "apiKey": "!pass show local-llm-key",
      "models": [
        { "id": "llama-3.3-70b", "displayName": "Llama 3.3 70B", "contextLength": 131072 }
      ]
    }
  ]
}
```
File permissions `0600`. The `apiKey` field supports `!cmd` shell resolution (same as `auth.json` keys). The `models` array provides static model definitions for providers that don't have a `/models` endpoint. Modeled after Factory's `customModels` array in `~/.factory/settings.json`.

**KTD5 — Config evolution:** `FurnaceConfig` replaces `openRouterApiKey: string` with:
- `provider: string` — active provider ID (e.g. `"openrouter"`, `"openai"`, `"my-local-llm"`)
- `apiKey: string` — resolved API key for the active provider
- `providerConfig: ResolvedProvider` — the full provider definition (base URL, protocol, display name, etc.)

`loadConfig()` resolves the active provider from preferences, then resolves its key from: `--api-key` flag > env var > `auth.json[providerId]` (with `resolveKeyValue`) > empty. Backward compat: if no `provider` preference exists, default to `"openrouter"` and use the existing `openrouter` key path.

**KTD6 — `/login` flow redesign:** The current `apiKeySetup` screen becomes the second step. A new `providerSelector` screen is the first step:
1. `providerSelector` — lists built-in + custom providers, shows `✓` for configured, `—` for not configured, `active` for current
2. On select: if provider has no key and protocol is `anthropic`/`openai-compatible`, show `apiKeySetup` screen (masked input)
3. On key save: write to `auth.json[providerId]`, set active provider in preferences, update running config
4. OAuth stub: if user selects a provider and an "OAuth" option is shown, display "OAuth not available yet. Use API key." and return to the provider selector

**KTD7 — Model settings per protocol:** The current `requestOptions()` adds OpenRouter-specific fields (`reasoning: { effort }`, `provider: { sort: "throughput" }`). Each adapter translates `ModelSettings` into its own request options:
- OpenAI-compatible: `reasoning_effort` for OpenAI, ignored for others; `provider.sort` only for OpenRouter
- Anthropic: `thinking: { type: "enabled", budget_tokens: N }` for extended thinking

**KTD8 — `auth.json` schema change:** `StoredKeys` changes from `{ openrouter?: string; anthropic?: string; openai?: string }` to `Record<string, string>` — any provider ID maps to its key string. This is backward compatible since the existing fields are a subset.

---

## Scope Boundaries

### Deferred to Follow-Up Work
- OAuth implementation (browser-redirect flow for any provider that adds it)
- Per-provider model settings persistence (currently model settings are global; switching providers resets to defaults)
- Provider health checks / connection test on key entry
- `/logout` command (remove stored key for a provider)
- Provider-specific features: OpenAI batch API, Anthropic prompt caching, DeepSeek reasoning tokens
- File locking via `proper-lockfile` for concurrent instance safety
- Provider auto-detection from environment variables (e.g. if `ANTHROPIC_API_KEY` is set, suggest Anthropic on first run)

### Non-goals
- Routing requests through multiple providers simultaneously
- Provider failover / automatic retry on a different provider
- Per-project provider scoping (provider is a global preference, not per-project)
- Encrypting `providers.json` or `auth.json` at rest (chmod 0600 threat model)

---

## High-Level Technical Design

```
/login flow:
  providerSelector screen
    ├─ OpenRouter          ✓ configured
    ├─ OpenAI              — not configured
    ├─ Anthropic           — not configured
    ├─ DeepSeek            — not configured
    ├─ GLM                 — not configured
    ├─ [Custom Provider]   ✓ configured
    └─ + Add Custom Provider (opens $EDITOR on providers.json)

  Select provider → apiKeySetup screen (masked input)
    └─ Enter → save to auth.json[providerId] → set active → return to chat

Config resolution (priority order):
  1. --api-key CLI flag
  2. Provider's env var (OPENROUTER_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, ...)
  3. auth.json[providerId] (with !cmd resolution)
  4. providers.json[provider].apiKey (with !cmd resolution, for custom providers)
  5. empty → isApiKeyMissing() = true

Provider call path:
  cli.ts / agent/loop.ts
    → provider.streamChat(config, messages, signal)
    → provider.completeToolChat(config, messages, tools, options, signal)
    → provider.listModels(config)
           │
           ├─ openai-compatible.ts  (OpenRouter, OpenAI, DeepSeek, GLM, custom)
           │    POST {baseUrl}/chat/completions
           │    Auth: Bearer {apiKey}
           │    Streaming: SSE data: lines, [DONE] terminator
           │
           └─ anthropic.ts  (Anthropic native)
                POST {baseUrl}/v1/messages
                Auth: x-api-key + anthropic-version
                Streaming: SSE content_block_delta events
                Tools: tool_use / tool_result content blocks
```

---

## Implementation Units

### U1. Provider types, registry, and custom provider config

**Goal:** Define the `Provider` interface, built-in provider definitions, and custom provider loading from `~/.furnace/providers.json`.

**Requirements:** R1, R5, R7, R8, R9

**Dependencies:** none

**Files:**
- `src/providers/types.ts` (create)
- `src/providers/registry.ts` (create)
- `src/providers/custom.ts` (create)
- `test/providers.test.mjs` (create)

**Approach:**
- `src/providers/types.ts`: Define `Protocol = "openai-compatible" | "anthropic"`. Define `ProviderDefinition` with `id`, `displayName`, `baseUrl`, `protocol`, `envVar?`, `models?` (static model list for custom providers). Define `ResolvedProvider` = `ProviderDefinition` + `apiKey: string`. Define the `Provider` interface with `streamChat`, `completeChat`, `completeToolChat`, `listModels` methods (same signatures as current `openrouter.ts` functions but parameterized by `ResolvedProvider` instead of `FurnaceConfig`).
- `src/providers/registry.ts`: Export `BUILTIN_PROVIDERS: ProviderDefinition[]` with entries for `openrouter` (`https://openrouter.ai/api/v1`, `openai-compatible`, env `OPENROUTER_API_KEY`), `openai` (`https://api.openai.com/v1`, `openai-compatible`, env `OPENAI_API_KEY`), `anthropic` (`https://api.anthropic.com`, `anthropic`, env `ANTHROPIC_API_KEY`), `deepseek` (`https://api.deepseek.com/v1`, `openai-compatible`, env `DEEPSEEK_API_KEY`), `glm` (`https://open.bigmodel.cn/api/paas/v4`, `openai-compatible`, env `GLM_API_KEY`). Export `resolveProvider(providerId: string, custom: CustomProvider[]): ProviderDefinition | undefined`.
- `src/providers/custom.ts`: `loadCustomProviders(): Promise<CustomProvider[]>` reads `~/.furnace/providers.json`, returns `[]` on missing/malformed. `saveCustomProviders(providers: CustomProvider[]): Promise<void>` writes with chmod 0600. `CustomProvider` extends `ProviderDefinition` with optional `apiKey` field (for inline key storage, resolved with `resolveKeyValue`).
- Re-export `resolveKeyValue` from `src/keys.ts` for use in custom provider key resolution.

**Patterns to follow:** `src/preferences.ts` for file read/write/mkdir pattern; `src/keys.ts` for chmod 0600 pattern; Factory's `~/.factory/settings.json` `customModels` array structure.

**Test scenarios:**
- `resolveProvider("openrouter", [])` returns the OpenRouter built-in definition
- `resolveProvider("nonexistent", [])` returns undefined
- `resolveProvider("my-custom", customList)` returns the matching custom provider
- `loadCustomProviders()` returns `[]` when file does not exist
- `loadCustomProviders()` returns `[]` on malformed JSON without throwing
- `saveCustomProviders` writes file with mode 0600
- Custom provider with `apiKey: "!echo sk-test"` resolves to `sk-test` through `resolveKeyValue`

**Verification:** All provider tests pass; `npm run typecheck` clean.

---

### U2. OpenAI-compatible provider adapter

**Goal:** Refactor `src/openrouter.ts` into a provider interface implementation that works with any OpenAI Chat Completions endpoint by parameterizing base URL and auth header.

**Requirements:** R7, R8, R11

**Dependencies:** U1

**Files:**
- `src/providers/openai-compatible.ts` (create)
- `src/openrouter.ts` (modify — becomes a thin compatibility shim or is replaced)
- `src/agent/loop.ts` (modify — call through provider interface)
- `src/cli.ts` (modify — title generation, model cache)

**Approach:**
- `src/providers/openai-compatible.ts`: Export `createOpenAICompatibleProvider(def: ProviderDefinition): Provider` — returns an object implementing the `Provider` interface. All four methods (`streamChat`, `completeChat`, `completeToolChat`, `listModels`) use `def.baseUrl` instead of the hardcoded `https://openrouter.ai/api/v1`. Auth header: `Authorization: Bearer ${resolvedProvider.apiKey}`. OpenRouter-specific headers (`HTTP-Referer`, `X-Title`) are added only when `def.id === "openrouter"`.
- `requestOptions` becomes per-provider: `openai-compatible` adapter has a `buildRequestOptions(config, def)` that adds `reasoning: { effort }` only for OpenRouter (OpenRouter-specific extension), `reasoning_effort` for OpenAI, and nothing for other providers. `provider: { sort: "throughput" }` only for OpenRouter.
- `src/openrouter.ts`: The existing exported types (`OpenRouterMessage`, `OpenRouterToolCall`, `OpenRouterModel`, etc.) are moved to `src/providers/types.ts` and re-exported from `openrouter.ts` for backward compat. The function implementations move to the adapter. `openrouter.ts` can either be deleted (with imports updated) or kept as a thin shim that delegates to the adapter — the shim approach minimizes import churn.
- `src/agent/loop.ts`: Replace `import { streamOpenRouterResponse, completeOpenRouterToolResponse } from "../openrouter.js"` with calls through the provider interface on `config.providerConfig`.
- `src/cli.ts`: `createModelListCache` calls `config.provider.listModels(config)` instead of `listOpenRouterModels(config)`. Title generation calls `config.provider.completeChat(config, messages)`.

**Patterns to follow:** Pi's `BaseModel`/`OpenAIModel` separation; existing `openrouter.ts` streaming logic (moved, not rewritten).

**Test scenarios:**
- OpenAI-compatible adapter with OpenRouter definition: `streamChat` sends request to `https://openrouter.ai/api/v1/chat/completions` with `HTTP-Referer` and `X-Title` headers
- OpenAI-compatible adapter with OpenAI definition: `streamChat` sends to `https://api.openai.com/v1/chat/completions` without `HTTP-Referer`/`X-Title`
- OpenAI-compatible adapter with custom provider: `streamChat` sends to custom base URL
- `listModels` calls `{baseUrl}/models` and returns parsed model list
- `requestOptions` for OpenRouter includes `reasoning` and `provider.sort`; for OpenAI includes `reasoning_effort`; for DeepSeek includes neither
- Existing streaming/tool-call parsing behavior preserved (no regression in agent loop)

**Verification:** `npm run typecheck` clean; existing 92+ tests pass; `npm run dev -- -p "Reply with exactly: ok"` works with OpenRouter as active provider.

---

### U3. Config + key resolution per provider

**Goal:** Update `FurnaceConfig` to be provider-aware. `loadConfig()` resolves the active provider, its base URL, and API key from preferences, env vars, and `auth.json`.

**Requirements:** R4, R6, R11, R12, R13

**Dependencies:** U1, U2

**Files:**
- `src/config.ts` (modify)
- `src/keys.ts` (modify)
- `src/preferences.ts` (modify)
- `src/cli.ts` (modify — `--api-key` flag application)

**Approach:**
- `src/keys.ts`: Change `StoredKeys` from a fixed-shape type to `Record<string, string>` — any provider ID maps to its key. Existing `getStoredKey("openrouter")` still works. Add `getProviderKey(providerId: string): Promise<string | undefined>` that calls `getStoredKey(providerId)` and resolves through `resolveKeyValue`.
- `src/preferences.ts`: Add `provider?: string` to `FurnacePreferences`. Default to `"openrouter"` when unset.
- `src/config.ts`: Replace `openRouterApiKey: string` with `provider: string`, `apiKey: string`, `providerConfig: ResolvedProvider`. `loadConfig()` flow:
  1. Load preferences → get `provider` (default `"openrouter"`)
  2. Load custom providers → `resolveProvider(providerId, customProviders)` → get `ProviderDefinition`
  3. Resolve key: `--api-key` flag > `process.env[def.envVar]` > `auth.json[providerId]` (with `resolveKeyValue`) > `customProviders[providerId].apiKey` (with `resolveKeyValue`) > `""`
  4. Build `ResolvedProvider` from definition + resolved key
  5. Select adapter: `openai-compatible` → `createOpenAICompatibleProvider(def)`, `anthropic` → `createAnthropicProvider(def)` (U6)
  6. Set `config.provider`, `config.apiKey`, `config.providerConfig`
- `src/cli.ts`: `--api-key` flag overrides `config.apiKey` and `config.providerConfig.apiKey` at runtime.
- `isApiKeyMissing(config)` changes from `!config.openRouterApiKey` to `!config.apiKey`.
- Backward compat: if `preferences.provider` is unset and `auth.json` has `openrouter` key, provider defaults to `"openrouter"` and key resolves from the existing path. No migration needed.

**Patterns to follow:** Existing `loadConfig()` layering (env > stored > default); Factory's key resolution priority.

**Test scenarios:**
- `loadConfig()` with no preferences and no auth.json: provider = `"openrouter"`, apiKey = `""`, `isApiKeyMissing` = true
- `loadConfig()` with `OPENROUTER_API_KEY` env var: provider = `"openrouter"`, apiKey = env var value
- `loadConfig()` with `auth.json` containing `{ "openrouter": "sk-test" }`: provider = `"openrouter"`, apiKey = `"sk-test"`
- `loadConfig()` with `preferences.provider = "deepseek"` and `auth.json` containing `{ "deepseek": "sk-ds" }`: provider = `"deepseek"`, apiKey = `"sk-ds"`
- `loadConfig()` with `preferences.provider = "my-custom"` and `providers.json` containing custom provider with inline `apiKey: "!echo sk-custom"`: apiKey resolved to `"sk-custom"`
- `--api-key sk-override` flag: `config.apiKey` = `"sk-override"` regardless of other sources

**Verification:** `npm run typecheck` clean; existing tests updated to use new config shape; all tests pass.

---

### U4. `/login` provider selector TUI

**Goal:** New `providerSelector` screen that lists all providers with key-status indicators. Replaces the current direct-to-`apiKeySetup` flow.

**Requirements:** R1, R2, R3, R4

**Dependencies:** U1, U3

**Files:**
- `src/ui/ink-terminal.tsx` (modify — new screen variant, `showProviderSelector` method, `ProviderSelectorScreen` component)
- `src/cli.ts` (modify — `/login` handler opens provider selector instead of direct key entry)
- `src/commands.ts` (no change — `/login` already exists)

**Approach:**
- New `UiScreen` variant: `{ kind: "providerSelector"; providers: ProviderDisplayRow[]; onSelect: (providerId: string) => void; onCancel: () => void }`. `ProviderDisplayRow` has `id`, `displayName`, `status: "configured" | "unconfigured" | "active"`, `protocol`.
- `ProviderSelectorScreen` component: renders a scrollable list (same `useInput` up/down/Enter/Esc pattern as `SettingsPanel`). Each row shows: `✓` (configured) / `—` (not configured) / `●` (active), display name, protocol label. Footer: "Enter to select · Esc to cancel".
- On select: call `onSelect(providerId)`. The CLI handler then:
  - If provider has a saved key or env var: show "Already configured. Update key? (y/n)" — if yes, show `apiKeySetup` screen; if no, set active provider and return to chat
  - If provider has no key: show `apiKeySetup` screen directly
  - On key save: `setStoredKey(providerId, key)`, update `preferences.provider = providerId`, update `config.provider` / `config.apiKey` / `config.providerConfig` in place, `showTransientStatus("Provider set to {name}. API key saved.")`
- OAuth stub: The provider selector shows an "Auth method" sub-selector only if the provider `protocol` is `anthropic` or `openai` (providers that might someday support OAuth). Options: "API Key" (proceed to `apiKeySetup`) and "OAuth (coming soon)" (shows transient status "OAuth not available yet. Use API key." and returns to selector). For `openrouter`, `deepseek`, `glm`, and custom providers, skip the sub-selector and go straight to API key entry.
- `FurnaceTerminal.showProviderSelector(providers, onSelect, onCancel)` method.

**Patterns to follow:** `SettingsPanel` component for scrollable list + `useInput` pattern; `ApiKeySetupScreen` for the second-step key entry; `showTransientStatus` for feedback.

**Test scenarios:** none — interactive TUI state; verified manually and through typecheck.

**Verification:** `npm run typecheck` clean; `/login` in dev shows provider list; selecting a provider shows key entry; saving key returns to chat with status notice; Esc returns to chat without changes.

---

### U5. Model listing for all providers

**Goal:** Each provider adapter implements `listModels()`. `/model` command fetches from the active provider. Custom providers with static `models` arrays use those instead of an API call.

**Requirements:** R10

**Dependencies:** U2

**Files:**
- `src/providers/openai-compatible.ts` (modify — `listModels` implementation)
- `src/providers/types.ts` (modify — `ModelInfo` type)
- `src/cli.ts` (modify — `createModelListCache` uses provider interface)

**Approach:**
- `ModelInfo` type (replacing `OpenRouterModel`): `{ id, name, contextLength, supportedParameters, pricing? }` — same shape, renamed for provider-agnosticism.
- OpenAI-compatible `listModels`: `GET {baseUrl}/models` with `Authorization: Bearer` header. Parse response: OpenAI format `{ data: [{ id, ... }] }`, DeepSeek/GLM similar. OpenRouter has extra fields (pricing, supported_parameters) — parse when present, default when absent.
- Custom providers with `models` array in `providers.json`: `listModels` returns the static array directly, no HTTP call. Each entry: `{ id, displayName, contextLength }` → mapped to `ModelInfo`.
- `src/cli.ts`: `createModelListCache(input.config)` calls `input.config.providerConfig.listModels(input.config)` (or the adapter's method, depending on how U2 wires it). Cache the promise per provider.
- Model autocomplete in `prompt-input.tsx` receives items from the active provider's model list. No change needed if the items flow through the same `autocompleteItems` prop.
- `ModelEditorPanel` settings (reasoning, fast, context): `supportedParameters` determines which settings are available. OpenRouter models expose `supported_parameters`; OpenAI models expose `supported_parameters` in their API; DeepSeek/GLM may not — default to empty array (all settings disabled). Fast routing (`provider.sort`) is OpenRouter-only — disable the fast toggle for non-OpenRouter providers.

**Patterns to follow:** Existing `listOpenRouterModels` parsing logic (generalized); Factory's static `models` array for custom providers.

**Test scenarios:**
- OpenAI-compatible `listModels` with OpenRouter: returns models with pricing and supportedParameters
- OpenAI-compatible `listModels` with OpenAI: returns models without pricing, supportedParameters from API or empty
- OpenAI-compatible `listModels` with custom provider that has static `models` array: returns static list without HTTP call
- OpenAI-compatible `listModels` with custom provider that has no `models` array: calls `{baseUrl}/models`
- `listModels` on a provider with an invalid key: throws error with status code
- Model autocomplete items come from the active provider's model list

**Verification:** `npm run typecheck` clean; `/model` in dev with OpenRouter shows OpenRouter models; switching to a custom provider shows its static models.

---

### U6. Anthropic native Messages API adapter

**Goal:** Implement the Anthropic Messages API as a provider adapter, supporting direct Anthropic API key usage without going through OpenRouter.

**Requirements:** R7, R9

**Dependencies:** U1, U2

**Files:**
- `src/providers/anthropic.ts` (create)
- `src/providers/registry.ts` (modify — Anthropic built-in uses `anthropic` protocol)
- `test/providers-anthropic.test.mjs` (create)

**Approach:**
- `createAnthropicProvider(def: ProviderDefinition): Provider` — implements the `Provider` interface using Anthropic's Messages API.
- **Auth:** Headers `x-api-key: {apiKey}`, `anthropic-version: 2023-06-01`, `content-type: application/json`. No Bearer token.
- **`streamChat`:** `POST {baseUrl}/v1/messages` with body `{ model, messages, max_tokens, system?, stream: true }`. Messages use the Anthropic format: `role: "user" | "assistant"`, `content: string | ContentBlock[]`. System messages are extracted and passed as top-level `system` parameter, not in the messages array. Streaming: SSE with event types `message_start`, `content_block_start`, `content_block_delta` (text deltas), `message_stop`. Parse `content_block_delta` events where `delta.type === "text_delta"` and yield `delta.text`.
- **`completeChat`:** Same endpoint with `stream: false`. Response: `{ content: [{ type: "text", text }], ... }` — extract `content[0].text`.
- **`completeToolChat`:** Anthropic tool calling uses `tools` array with `input_schema` (not `parameters`), and `tool_choice`. Response streaming: `content_block_start` with `type: "tool_use"` provides tool name and id; `content_block_delta` with `delta.type: "input_json_delta"` provides arguments in chunks. Accumulate arguments per tool use index. Tool results are sent back as `tool_result` content blocks in subsequent messages, not as separate `tool` role messages.
- **`listModels`:** `GET {baseUrl}/v1/models` with `x-api-key` header. Parse `{ data: [{ id, display_name, context_window }] }`.
- **Message conversion:** The agent loop and CLI build messages in OpenAI format (`OpenRouterMessage[]`). The Anthropic adapter converts at the boundary: extract system messages, convert `tool` role messages to `user` role with `tool_result` content blocks, convert `tool_calls` in assistant messages to `tool_use` content blocks. This conversion lives in the adapter, not in the agent loop.
- **Model settings:** `reasoningEffort` maps to `thinking: { type: "enabled", budget_tokens: N }` where N is derived from the effort level. `contextLength` maps to `max_tokens` (capped at model's max output). `fast` is ignored (OpenRouter-only).

**Patterns to follow:** Pi's `AnthropicModel` implementation for message format conversion and streaming event parsing; Anthropic API docs for request/response shapes.

**Test scenarios:**
- Message conversion: OpenAI-format message with `role: "system"` is extracted to top-level `system` parameter
- Message conversion: OpenAI-format assistant message with `tool_calls` becomes Anthropic assistant message with `tool_use` content blocks
- Message conversion: OpenAI-format `tool` role message becomes Anthropic `user` message with `tool_result` content block
- `streamChat` request body: has `max_tokens`, `model`, `messages`, `system` (when system messages present); no `system` key when absent
- `streamChat` headers: includes `x-api-key` and `anthropic-version`; does NOT include `Authorization: Bearer`
- `completeToolChat` streaming: accumulates `input_json_delta` chunks into complete tool arguments
- `listModels` parses Anthropic model list response with `display_name` and `context_window` fields

**Verification:** `npm run typecheck` clean; all new anthropic adapter tests pass; existing tests unaffected.

---

## Verification Contract

| Gate | Command / Action |
|------|-----------------|
| Typecheck | `npm run typecheck` |
| Tests | `npm test` — all existing tests pass + new provider tests |
| `/login` provider list | `/login` in dev → provider selector shows OpenRouter, OpenAI, Anthropic, DeepSeek, GLM, and any custom providers |
| Key entry | Select OpenAI → paste key → "Provider set to OpenAI. API key saved." → chat works |
| Provider switch | `/login` → select DeepSeek → enter key → model list updates to DeepSeek models |
| Backward compat | Existing `auth.json` with `openrouter` key → OpenRouter works without re-login |
| `--api-key` flag | `furnace --api-key sk-test` → uses override for active provider |
| Custom provider | Add entry to `~/.furnace/providers.json` → `/login` shows it → select → chat works |
| Custom static models | Custom provider with `models` array → `/model` shows those models without API call |
| Anthropic native | `/login` → Anthropic → enter key → `/model` shows Anthropic models → chat works with Messages API |
| OAuth stub | Select a provider → "OAuth (coming soon)" → "OAuth not available yet. Use API key." |
| No-key submit | `furnace` with no key; send a message → "No API key configured. Use /login to set one." |

---

## Definition of Done

- Provider types, registry, and custom provider config implemented and tested (U1)
- OpenAI-compatible adapter replaces hardcoded OpenRouter calls; agent loop and CLI use provider interface (U2)
- `FurnaceConfig` is provider-aware; `loadConfig()` resolves provider, key, and base URL (U3)
- `/login` shows provider selector with status indicators; key entry and provider switching work (U4)
- Model listing works for all providers; custom providers with static models use config (U5)
- Anthropic native Messages API adapter implemented and tested (U6)
- All existing tests pass (92+ baseline); new provider tests pass
- `npm run typecheck` clean
- `~/.furnace/providers.json` and `~/.furnace/auth.json` created with 0600 on first use

---

## Sources & Research

- Factory droid `~/.factory/settings.json` — `customModels` array structure with `model`, `displayName`, `baseUrl`, `apiKey`, `provider` fields
- Factory droid `~/.factory/droids/*.md` — droid config with `model: custom:<model-id>` for BYOK models
- Pi `packages/coding-agent/src/core/auth-guidance.ts` — `/login` command, provider selector, `formatNoApiKeyFoundMessage`
- Pi `packages/coding-agent/src/modes/interactive/interactive-mode.ts` — `showLoginProviderSelector`, `showApiKeyLoginDialog`
- Furnace `src/openrouter.ts` — current API call structure (hardcoded URLs, Bearer auth, SSE streaming)
- Furnace `src/config.ts` — `FurnaceConfig` type, `loadConfig()` layering
- Furnace `src/keys.ts` — `auth.json` storage, `resolveKeyValue` for `!cmd` keys
- Furnace `src/ui/ink-terminal.tsx` — `UiScreen` union, `ApiKeySetupScreen`, `SettingsPanel` patterns
- Anthropic API docs — Messages API request/response format, streaming events, tool use
