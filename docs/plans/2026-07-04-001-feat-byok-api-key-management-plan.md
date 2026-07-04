---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
created: 2026-07-04
updated: 2026-07-04
plan_type: feat
product_contract_source: ce-plan-bootstrap
---

# feat: BYOK — Pi-style `/login` auth flow

## Goal Capsule

Match Pi's credential management model: credentials live in `~/.furnace/auth.json` (chmod 0600), accessed via a `/login` slash command (not a startup gate), with env vars and a `--api-key` CLI flag as higher-priority overrides. Keys starting with `!` are treated as shell commands whose stdout is the actual key — enabling 1Password, `pass`, and other secret managers without a native dependency. On missing key at submit time, show a chat-level status notice pointing to `/login` rather than blocking startup.

**Prior approach (startup-gate + `/keys`):** superseded by this plan. The `ApiKeySetupScreen` TUI component is retained and invoked only from `/login`, never on startup.

---

## Requirements

| ID | Requirement |
|----|-------------|
| R1 | `/login` slash command opens a masked key-entry screen; Enter confirms, Esc dismisses |
| R2 | Confirmed key saved to `~/.furnace/auth.json` with 0600 file permissions |
| R3 | `OPENROUTER_API_KEY` env var takes highest precedence, then `--api-key` flag, then `auth.json`, then empty |
| R4 | Keys stored as `!<shell-command>` are resolved by executing the command and using stdout |
| R5 | Submitting a message with no key configured shows a status notice pointing to `/login`; does not crash or block startup |
| R6 | Storage uses a multi-provider shape for future Anthropic/OpenAI keys |
| R7 | Headless/piped mode with no key emits a clear error pointing to setup options |
| R8 | Running config updates immediately after key confirm — first prompt works without restart |

---

## Key Technical Decisions

**KTD1 — File path: `auth.json` (Pi convention):** `~/.furnace/auth.json` with a JSON map `{ openrouter?: string, anthropic?: string, openai?: string }`. Written with `chmod(0o600)` after each write. Renamed from `keys.json` to match Pi's naming and signal credential intent.

**KTD2 — Shell command resolution (`!<cmd>`):** If the stored key value starts with `!`, the rest is executed via `execSync` with `stdio: ["ignore","pipe","ignore"]`; stdout (trimmed) is the resolved key. Cached for the process lifetime. This is Pi's `resolve-config-value.ts` pattern — enables 1Password (`!op read "..."`), `pass`, and arbitrary secret managers with zero native deps.

**KTD3 — No startup gate:** `runInteractive` in `cli.ts` does NOT check for a missing key before `terminal.run()`. Instead, `handleInteractiveSubmit` checks `isApiKeyMissing(config)` and calls `showTransientStatus("No API key configured. Use /login to set one.")` before returning early. This matches Pi exactly: the TUI launches unconditionally; auth happens on demand.

**KTD4 — `/login` command:** The single interactive auth entry point. Currently Furnace has one provider (OpenRouter) so `/login` goes straight to `showApiKeySetup("openrouter", "OpenRouter", ...)`. The structure supports adding a provider picker as a future unit when a second provider lands.

**KTD5 — `--api-key` CLI flag:** Commander option added to the root program. After `loadConfig()`, if `options.apiKey` is set it overrides `config.openRouterApiKey` (runtime-only, not persisted). Priority: env var > `--api-key` > `auth.json`.

---

## Scope Boundaries

### Deferred to Follow-Up Work
- Provider picker TUI for `/login` (only needed when a second provider is added)
- `/logout` command (remove stored credential)
- OAuth flow (Pi's browser-redirect loop; OpenRouter doesn't offer OAuth today)
- File locking via `proper-lockfile` (Pi adds this for concurrent multi-instance access; low risk for a local single-user tool)
- Displaying auth status in `/settings` panel

### Non-goals
- Encrypting `auth.json` at rest (chmod 0600 is the chosen threat model)
- Per-project key scoping

---

## High-Level Technical Design

```
Key resolution (priority order):
  OPENROUTER_API_KEY env var
    │ present → use directly
    ▼ absent
  --api-key CLI flag
    │ present → use directly (not persisted)
    ▼ absent
  auth.json["openrouter"]
    │ starts with "!" → execSync(cmd), use stdout
    │ otherwise → use literal value
    ▼ absent or empty
  openRouterApiKey = ""   → isApiKeyMissing() = true

Submit path (interactive):
  handleInteractiveSubmit
    ├─ isApiKeyMissing? → showTransientStatus("No API key. Use /login.") → return
    └─ run agent turn normally

/login path:
  showApiKeySetup("openrouter", "OpenRouter", onSave, onCancel)
    └─ ApiKeySetupScreen (masked input, Enter/Esc)
         └─ onSave(key) → resolveAndStore → config.openRouterApiKey = key
```

---

## Implementation Units

### U1. Rename storage to `auth.json` + shell command resolution

**Goal:** Update `src/keys.ts` to write `auth.json` instead of `keys.json` and resolve `!<cmd>` key values.

**Requirements:** R2, R4, R6

**Dependencies:** none

**Files:**
- `src/keys.ts` (modify)
- `test/keys.test.mjs` (modify)

**Approach:**
- Change `keysPath()` to return `join(homedir(), ".furnace", "auth.json")`
- Add `resolveKeyValue(raw: string): string | undefined` — if `raw.startsWith("!")`, run `execSync(raw.slice(1), { encoding: "utf8", stdio: ["ignore","pipe","ignore"], timeout: 10000 })` and return trimmed stdout; on error return `undefined`. Cache results per process lifetime in a `Map<string, string>`.
- Export `resolveKeyValue` for use in `config.ts`
- Update `test/keys.test.mjs` to reflect `auth.json` path; add test for `!<cmd>` resolution

**Patterns to follow:** Pi's `resolve-config-value.ts` → `executeCommandUncached` pattern; existing `src/keys.ts` for read/write/chmod

**Test scenarios:**
- `getStoredKey` reads from `auth.json` (not `keys.json`)
- `resolveKeyValue("sk-literal")` returns `"sk-literal"`
- `resolveKeyValue("!echo sk-from-cmd")` returns `"sk-from-cmd"`
- `resolveKeyValue("!exit 1")` (failing command) returns `undefined`
- Shell command result is cached — calling twice invokes the command only once

**Verification:** All new and existing key storage tests pass; `npm run typecheck` clean.

---

### U2. Config: wire `--api-key` flag + shell command resolution

**Goal:** Thread `--api-key` runtime override into `loadConfig()`; resolve `!<cmd>` keys from `auth.json`.

**Requirements:** R3, R4, R8

**Dependencies:** U1

**Files:**
- `src/config.ts` (modify)
- `src/cli.ts` (modify — add `--api-key` Commander option, pass to config)

**Approach:**
- In `src/cli.ts`, add `.option("--api-key <key>", "Override API key for this session (not persisted)")` to the Commander program
- After `loadConfig()`, if `options.apiKey` is non-empty: `config.openRouterApiKey = options.apiKey`
- In `src/config.ts`'s `loadConfig()`: after resolving `storedKey = await getStoredKey("openrouter")`, call `resolveKeyValue(storedKey ?? "")` before assigning to `openRouterApiKey` — so `!<cmd>` keys from `auth.json` are resolved at load time
- Env var path is unchanged (literal string, no shell command resolution needed — env vars are already resolved by the shell)

**Patterns to follow:** Existing Commander options in `src/cli.ts`; existing `loadConfig()` layering

**Test scenarios:** None — structural wiring; covered by integration (manual smoke)

**Verification:** `npm run typecheck` clean; `furnace --api-key sk-override` works without saving to `auth.json`.

---

### U3. Remove startup gate; add submit-time key check

**Goal:** Remove the startup `showApiKeySetup` call from `runInteractive`; add a check in `handleInteractiveSubmit` that shows a status notice when no key is configured.

**Requirements:** R5, R7, R8

**Dependencies:** U2

**Files:**
- `src/cli.ts` (modify)

**Approach:**
- Delete the `if (isApiKeyMissing(input.config)) { terminal.showApiKeySetup(...) }` block that precedes `refreshCurrentSession()` in `runInteractive`
- In `handleInteractiveSubmit`, at the top (before any command parsing), add:
  ```
  if (isApiKeyMissing(input.config)) {
    showTransientStatus('No API key configured. Use /login to set one.')
    return
  }
  ```
- Headless/piped error messages are unchanged (already in place from previous unit)
- The `onCancel: () => { terminal.stop(); process.exit(0) }` callback in the old startup gate is removed — Esc on the `/login` screen now simply dismisses without exiting

**Test scenarios:**
- Submit-time missing key: `handleInteractiveSubmit` with empty `config.openRouterApiKey` does not call `runPromptQueue`; status notice is set

**Verification:** `npm run typecheck` clean; `furnace` with no key starts normally; sending a message shows the notice; `/login` sets the key; next message succeeds.

---

### U4. Rename `/keys` → `/login` in commands and handler

**Goal:** Rename the slash command to `/login` throughout `commands.ts` and `cli.ts`; update the Esc/cancel behavior to simply dismiss (not exit).

**Requirements:** R1, R8

**Dependencies:** U3

**Files:**
- `src/commands.ts` (modify)
- `src/cli.ts` (modify)

**Approach:**
- In `src/commands.ts`: change `{ name: "/keys", description: "Set or update API key" }` → `{ name: "/login", description: "Set or update API key" }`
- In `src/cli.ts` command handler: change `command.name === "/keys"` → `command.name === "/login"`; update `onCancel` from `() => { terminal.stop(); process.exit(0) }` to `() => {}` (simple dismiss — Pi does not exit on cancel from `/login`)
- Confirmation message after save: `showTransientStatus("API key saved.", 2000)`

**Patterns to follow:** Existing `/settings` handler shape

**Test scenarios:** None — naming change; verified via typecheck and manual smoke

**Verification:** `npm run typecheck` clean; `/login` appears in autocomplete; `/keys` no longer works; Esc from key-entry screen returns to chat without exiting.

---

## Verification Contract

| Gate | Command / Action |
|------|-----------------|
| Typecheck | `npm run typecheck` |
| Tests | `npm test` — 99+/99 passing |
| Storage file name | `stat ~/.furnace/auth.json` after `/login` — mode 0600 |
| Env override | `OPENROUTER_API_KEY=x furnace` — no setup screen, chat works |
| `--api-key` flag | `furnace --api-key sk-x` — chat works, `auth.json` unchanged |
| Shell command key | Store `!echo sk-from-cmd` in `auth.json`; `loadConfig()` resolves to `sk-from-cmd` |
| No-key submit | `furnace` with no key; send a message → status notice appears, no crash |
| `/login` command | `/login` in chat → masked input screen; Enter saves; next message succeeds |
| Esc from `/login` | Esc returns to chat without exiting the process |
| Headless no-key | `furnace -p "hello"` with no key → stderr error message, exit 1 |

---

## Definition of Done

- `auth.json` used (not `keys.json`); `resolveKeyValue` handles `!<cmd>` keys (U1)
- `--api-key` flag wired; stored `!<cmd>` keys resolved at load time (U2)
- Startup gate removed; submit-time status notice in place (U3)
- `/login` replaces `/keys`; Esc dismisses without exiting (U4)
- All 99 tests passing; typecheck clean

---

## Sources & Research

- Pi `packages/coding-agent/src/core/auth-storage.ts` — `auth.json`, credential shape, OAuth structure
- Pi `packages/coding-agent/src/core/resolve-config-value.ts` — `!<cmd>` shell resolution pattern
- Pi `packages/coding-agent/src/modes/interactive/interactive-mode.ts` — `/login` command, submit-time auth check, `showApiKeyLoginDialog`
- Furnace `src/keys.ts` — existing storage module (U1 modifies)
- Furnace `src/config.ts` — `loadConfig()` layering (U2 modifies)
- Furnace `src/cli.ts` — `handleInteractiveSubmit`, `runInteractive`, Commander program (U3/U4 modify)
