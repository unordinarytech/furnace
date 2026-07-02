---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
title: "feat: CLI competitive parity — input ergonomics, session utilities, config extensibility, and housekeeping"
created: 2026-07-02
branch: feat/tui-copy-command-markdown-revamp
---

# feat: CLI competitive parity — input ergonomics, session utilities, config extensibility, and housekeeping

## Summary

Furnace covers the basics (slash commands, theme/model switching, session history, plan mode, permissions, skills, compaction) but lacks two dozen non-agent-related quality-of-life features present in Claude Code, Codex CLI, Gemini CLI, and OpenCode. This plan closes the most impactful gaps in four categories: input/editing ergonomics (multi-line entry, history search, external editor, basic vim mode), session utility commands (/status, /export, /diff, /undo, /copy, /cost), config and extensibility (global preferences, custom slash commands, headless CLI flags), and housekeeping (desktop notifications, update checker, /bug, shell completions). Terminal bell on turn completion already exists (`process.stdout.write("\x07")` in `runPromptQueue`); the gaps above it do not.

All work lands on branch `feat/tui-copy-command-markdown-revamp`.

---

## Problem Frame

A side-by-side feature audit against Claude Code, Codex CLI, Gemini CLI, and OpenCode surfaced the following gaps in Furnace that are **not** about agent loop logic, tool execution internals, subagents, or MCP:

**Input/editing ergonomics** — Enter always submits (no newline-without-submit), no Ctrl+R history fuzzy search (only linear Up/Down cycling), no $EDITOR integration for long prompts, no vim-mode input editing.

**Session utility commands** — no single `/status` view, no `/export` (dump conversation to file), no `/diff` or `/undo` (session-level file-change tracking and revert), no `/copy` (clipboard), no `/cost` (token + dollar accounting).

**Config and extensibility** — preferences are per-project only (`./furnace/preferences.json`), no global `~/.furnace/` defaults; no user-defined custom slash commands; no `--session <id>` CLI flag; no `--output-format json` for headless scripting.

**Housekeeping** — no desktop notification when a turn finishes while the terminal is unfocused, no startup update/version check, no `/bug` command for quick feedback filing, no shell completion scripts for the `furnace` CLI flags.

---

## Requirements

- **R1** Users can insert a literal newline in the prompt input (Ctrl+J) without submitting.
- **R2** Users can fuzzy-search their prompt history (Ctrl+R) and load a past entry into the input without submitting it.
- **R3** Users can open their `$EDITOR` to compose a long message and have the saved text loaded back into the prompt input (Ctrl+G or `/editor`).
- **R4** Users can opt into a basic vim-style modal input (normal/insert modes) via a preference toggle; default remains standard readline-style.
- **R5** `/status` prints a concise single-screen summary of the current session's model, mode, cwd, theme, context usage, session id, and active permission grant count.
- **R6** `/export [json]` writes the current conversation transcript to a timestamped file in the current directory, defaulting to markdown format with an optional `json` argument.
- **R7** `/diff` shows a unified diff of every file modified by write/edit tool calls during the current session, compared against the content each file had before Furnace touched it.
- **R8** `/undo` reverts the most recent file-modifying tool call: restoring the captured pre-edit content for modified files, or deleting newly created files.
- **R9** `/copy` (or Ctrl+O) copies the most recent assistant response text to the system clipboard.
- **R10** `/cost` displays cumulative token counts and estimated USD spend for the current session and for all sessions under the current working directory.
- **R11** Preferences merge globally (`~/.furnace/preferences.json` as base) then per-project (`.furnace/preferences.json` overrides); `/model --global` and `/theme --global` write to the global file.
- **R12** Custom slash commands are loaded from `.furnace/commands/*.md` (project) and `~/.furnace/commands/*.md` (global) at startup; the filename (minus `.md`) becomes the command name, and the file body is a prompt template with `$ARGUMENTS` substitution.
- **R13** `--session <id>` CLI flag opens a specific saved session by id rather than always resuming the latest.
- **R14** `--output-format json` (only meaningful with `-p`/`--print`) wraps headless output in a JSON envelope `{content, model, sessionId, promptTokens, completionTokens}`.
- **R15** A desktop notification fires (opt-in, gated by `notifications: true` preference) when a turn completes and the terminal reports itself unfocused via ANSI focus-reporting escape sequences.
- **R16** `furnace completion <bash|zsh|fish>` prints a shell completion script covering all known CLI flags.
- **R17** `/bug [message]` prints or opens the Furnace GitHub issues URL, optionally pre-filling the title from the message argument.
- **R18** On startup, a non-blocking background check compares `package.json` version against the npm registry; a one-line notice appears if a newer version is available.

---

## Key Technical Decisions

- **KTD1 — Pre-edit file snapshots in the session entry, not git.** For `/diff` and `/undo`, content snapshots (the file's bytes before write/edit) are captured in `cli.ts`'s `onToolStart` callback for write and edit tool calls (args already contain the target path; a synchronous `readFileSync` read captures existing content before the tool runs). The snapshot is stored as an optional `fileSnapshot?: { path: string; existed: boolean; previousContent?: string }` field in `ToolCallEntryData` (extending `src/session/types.ts`). This approach works in non-git directories, respects the AGENTS.md self-contained-SQLite ethos, and does not require git to be installed or the repo to be clean. `/diff` generates a unified diff by computing the delta between stored `previousContent` and current on-disk content using the `diff` npm package (to be added as a dependency). `/undo` restores `previousContent` for modified files or deletes the file if `existed: false`. A limitation applies: only Furnace-initiated writes are tracked; external edits made outside Furnace during the session are not visible to `/diff`.

- **KTD2 — Usage captured per agent turn, stored in `MessageEntryData`.** To power `/cost`, `completeOpenRouterToolResponse` is extended to request `usage: { include: true }` and parse the `usage` field from the final SSE chunk. `RunAgentTurnResult` gains a `usage?: { promptTokens: number; completionTokens: number }` field (accumulated across all iterations in a multi-tool turn). `cli.ts` attaches usage + cost estimate to the assistant `MessageEntryData` as `usage?: { promptTokens, completionTokens, costUsd }`. Cost estimate uses per-model pricing fetched from the OpenRouter `/models` endpoint (new `pricing?: { prompt: number; completion: number }` field on `OpenRouterModel`, values in USD per token). `/cost` sums all assistant message entries' `usage` for the current session and across all sessions sharing the cwd.

- **KTD3 — Multi-line input via a single `\n` character in the value string.** Ctrl+J inserts a `\n` at the cursor position in `PromptInput`'s value string. Ink renders multi-line text naturally via `<Text wrap="wrap">` inside the existing `<Box>`. The `before/cursor/after` character split must be adjusted to handle `\n` in the value without incorrect cursor rendering — the simplest safe approach: render multi-line content as-is and accept that the cursor position indicator is character-accurate but not visually line-aware (acceptable first-pass UX, consistent with how Ink naturally handles strings with newlines). The existing `onSubmit` call continues to pass the full multi-line string including embedded `\n` characters as the prompt text.

- **KTD4 — History search (Ctrl+R) reuses the existing autocomplete infrastructure.** Pressing Ctrl+R when the input is empty opens a filtered autocomplete dropdown pre-seeded with all `historyItems` entries. The user types to narrow, arrows to select, Enter loads the selected entry into the input (does not submit). This is zero new UI components; it reuses `PromptAutocompleteMenu` and the existing `browsable` flag flow for selecting without submitting.

- **KTD5 — External editor suspends Ink, spawns $EDITOR synchronously, resumes.** Ink renders to a raw-mode stdin. To hand control to $EDITOR the app must temporarily stop Ink's render loop, restore terminal cooked mode, spawn $EDITOR with `stdio: 'inherit'` via Node's `spawnSync`, then re-enter raw mode and resume Ink. The pattern is: `app.unmount()` → `process.stdin.setRawMode(false)` → `spawnSync($EDITOR, [tmpFile], {stdio: 'inherit'})` → read temp file → re-mount or re-trigger `terminal.run()` equivalent. `FurnaceTerminal` will expose a `suspendForEditor(draft: string): Promise<string>` method to encapsulate this, keeping the Ink lifecycle management out of `cli.ts`.

- **KTD6 — Vim mode is an opt-in, minimal normal/insert modal layer within `PromptInput`.** Default is `inputMode: "standard"` (current behavior). With `inputMode: "vim"` (preference), `PromptInput` tracks a `vimMode: "normal" | "insert"` state alongside the existing cursor. In normal mode: `h`/`l` move cursor, `i`/`a` enter insert before/after cursor, `x` deletes char at cursor, `dd` clears the entire value, `0`/`$` go to line start/end, `w`/`b` move by word boundaries. In insert mode, all current standard editing behavior applies; Esc returns to normal. Enter submits from either mode. A small `[N]`/`[I]` mode indicator renders left of the input prefix. Scope is explicitly bounded: no visual mode, no registers, no macros, no counts, no dot-repeat, no ex commands.

- **KTD7 — Custom commands mirror the skills loader pattern.** `src/custom-commands/loader.ts` discovers `.md` files in `.furnace/commands/` (project, higher priority) and `~/.furnace/commands/` (global, lower priority). Filename minus extension becomes the command name (same validation rules as skills). File body is the prompt template; `$ARGUMENTS` in the body is replaced with whatever the user types after the command name; if no `$ARGUMENTS` placeholder is present, the argument is appended. Custom commands are loaded once at startup alongside skills; they appear in the autocomplete dropdown via the same `slashAutocompleteItems` merge point. Invocation dispatches via `runPromptQueue` with the rendered template, identical to skill invocation.

- **KTD8 — Global preferences merge on load, branch on save.** `loadPreferences` reads `~/.furnace/preferences.json` as the global base, then overlays `.furnace/preferences.json` (project). `saveModelPreferences` and `saveThemePreference` accept an optional `scope: "global" | "project"` (default `"project"`). `/model --global <name>` and `/theme --global <name>` detect the `--global` prefix in the argument string and call with `scope: "global"`.

- **KTD9 — Desktop notification uses ANSI focus-reporting and OS notification APIs.** On startup, Furnace writes `\x1b[?1004h` to enable terminal focus-reporting. Raw stdin data events deliver `\x1b[I` (focus gained) and `\x1b[O` (focus lost). A module-level `terminalFocused` boolean tracks state. After each turn completes, if `!terminalFocused` and `preferences.notifications === true`, a platform notification fires: `osascript -e 'display notification "Turn complete" with title "Furnace"'` on macOS, `notify-send "Furnace" "Turn complete"` on Linux. Focus-reporting is disabled (`\x1b[?1004l`) on clean exit.

---

## High-Level Technical Design

### File snapshot lifecycle for /diff and /undo

```
onToolStart (write or edit call)
  ├─ parse target path from tool arguments
  ├─ existsSync(path)? → yes: readFileSync(path) → previousContent
  │                       no:  previousContent = undefined, existed = false
  └─ appendToolCall(..., { fileSnapshot: { path, existed, previousContent } })
         │
         └─ stored in entries table (ToolCallEntryData.fileSnapshot)

/diff command
  ├─ getActivePath(sessionId)
  ├─ filter entries: type=tool_call, name in [write, edit], has fileSnapshot
  ├─ for each: readFileSync(path) → currentContent
  ├─ diff(previousContent ?? "", currentContent) → unified patch
  └─ render to transcript (or status notice if no changes)

/undo command
  ├─ find latest tool_call entry with fileSnapshot not yet undone
  ├─ if existed: writeFileSync(path, previousContent)
  │   else:      unlinkSync(path)
  ├─ append "custom" entry { kind: "undo", toolCallId } to mark as applied
  └─ showTransientStatus("Undid: <path>")
```

### Usage capture and /cost data flow

```
completeOpenRouterToolResponse
  ├─ request body includes: usage: { include: true }
  ├─ final SSE chunk → parsed.usage.prompt_tokens / completion_tokens
  └─ returns OpenRouterAssistantResponse + usage?: { promptTokens, completionTokens }

runAgentTurn
  ├─ accumulates usage across iterations (sum prompt_tokens; completion_tokens last only)
  └─ returns RunAgentTurnResult + usage?

cli.ts → runSingleTurn → after result:
  ├─ fetch model pricing from modelListCache (already resolved)
  ├─ compute costUsd = promptTokens * pricing.prompt + completionTokens * pricing.completion
  └─ store.appendMessage(sessionId, "assistant", content, {
       model, usage: { promptTokens, completionTokens, costUsd }
     })

/cost command
  ├─ getActivePath(sessionId) → sum usage fields from assistant entries → session total
  └─ store.listSessions(cwd) + getActivePath each → lifetime total
```

---

## Scope Boundaries

### In scope
All 18 requirements above, organized into 13 implementation units across four phases.

### Deferred to follow-up work
- Full vim emulation (visual mode, registers, macros, ex commands, repeat counts, dot-repeat) — bounded MVP only in this pass.
- `/redo` (forward-replay of undone edits) — requires snapshotting current content before undo, adding forward-stack; deferred to follow-up.
- Hot-reload of custom commands at runtime (requires file-watching); startup-load-only in this pass.
- Windows-native desktop notification (PowerShell `New-BurntToastNotification` or similar) — macOS and Linux only in this pass.
- MCP server integration — explicitly out of scope (agent-related extensibility).
- `@file` / `@url` mention-in-input attachment syntax — significant new parser; not covered here.
- `!shell` passthrough prefix (run a shell command inline and feed output to model) — borderline agent-loop feature; deferred.
- Image paste (Ctrl+V image data into prompt) — requires terminal graphics protocol support; deferred.
- Git-based diff/undo alternative (for teams who want git-native checkpointing) — snapshot approach in this plan supersedes it; could be offered as an alternative mode later.

### Out of scope (not this product's identity in this pass)
- Subagent/tool-execution internals, MCP, provider adapters, sandboxing mechanics.
- Per-session cost budget / spending limits.

### Superseded plan
`docs/plans/2026-06-27-001-feat-cli-qol-improvements-plan.md` (input history, `/clear`, history filter) is fully shipped as of commit `2be04be`. That plan can be archived.

---

## System-Wide Impact

- `src/session/types.ts` — `ToolCallEntryData` gains optional `fileSnapshot` field; `MessageEntryData` gains optional `usage` field. All existing readers treat unknown fields as unknown (JSON parse), so no migration is needed.
- `src/openrouter.ts` — request body and response parsing changes affect all streaming tool-response calls (new `usage` field in request; new parsing of final chunk). Existing streaming-only consumers (`streamOpenRouterResponse`) are unchanged.
- `src/preferences.ts` — `loadPreferences` behavior changes: it now reads two files. Code paths that call `loadPreferences` without a `cwd` argument (e.g., future CLI uses) will pick up global preferences by default. The change is additive; existing per-project preferences are still honored with higher priority.
- `src/cli.ts` — `onToolStart` for write/edit calls gains a synchronous file read before invoking `appendToolCall`. This adds synchronous I/O to the tool-start hot path. The read is bounded to file content (any file the agent is about to edit must already exist and be readable), and sync I/O is consistent with patterns already present in the codebase (e.g., `better-sqlite3` is synchronous throughout).
- `src/commands.ts` — new command definitions added; existing definitions and their IDs are unchanged.

---

## Risks and Dependencies

- **New npm dependency: `diff`** — needed for unified-diff rendering in `/diff`. It is small (~50 KB), has zero transitive deps, and is mature (v5+). Acceptable addition; verify license (MIT).
- **Ink app lifecycle for external editor (U3)** — unmounting and remounting the Ink app without process exit is non-trivial. If Ink's `unmount` + re-`run` pattern proves unstable, a fallback is to collect editor content after the editor closes and restart the terminal render from scratch (acceptable since it is an explicit user action).
- **OpenRouter usage field availability** — not all models/providers forwarded through OpenRouter populate the `usage` field. Where missing, the turn's cost is recorded as `null` and `/cost` reports "some turns have unknown cost." This is a graceful degradation, not a failure.
- **ANSI focus-reporting terminal support** — not all terminals support `\x1b[?1004h` (e.g., basic `xterm`, some SSH clients). Where unsupported, focus-change events never arrive; `terminalFocused` stays `true`; notifications never fire. That is the safe no-op fallback.
- **osascript / notify-send availability** — both are platform-standard (macOS ships osascript; Ubuntu/Fedora ship notify-send via libnotify). Absence is caught with a try/catch around the `spawnSync`; failure is silent (no crash, no notice).

---

## Implementation Units

### U1. Multi-line input insertion (Ctrl+J)

**Goal:** Let users insert a literal newline in the prompt without submitting.

**Requirements:** R1

**Dependencies:** none

**Files:**
- `src/ui/components/prompt-input.tsx` (modify)

**Approach:** In the `useInput` handler, detect `input === "\n"` with `key.ctrl` (Ctrl+J produces `\n` in most terminals) as a distinct branch before the existing `key.return` check. Insert `\n` at `cursorOffset`, advance cursor by 1. The `before/cursor/after` render split already handles arbitrary characters including `\n` — Ink's `<Text>` wraps naturally. Verify that the `value.trim()` check in the `key.return` branch preserves `\n`-containing input (it does; `trim()` is only used to guard empty-submit, not applied to the submitted value).

**Test scenarios:**
- Ctrl+J inserts `\n` in the middle of existing text, cursor advances.
- Ctrl+J at the start of an empty input inserts a leading newline (input value = `"\n"`).
- Pressing Enter after a multi-line draft submits the full string including embedded newlines.
- Existing Ctrl+A/E/K/U/W readline shortcuts are unaffected by the Ctrl+J addition.

**Verification:** `autocompleteMatches` and `PromptInput` unit-test coverage in `test/smoke.test.mjs`; manual Ctrl+J → multi-line draft → Enter sends visible multi-line prompt.

---

### U2. History fuzzy search (Ctrl+R)

**Goal:** Ctrl+R opens a searchable overlay of past submitted prompts; Enter loads selected entry into input without submitting.

**Requirements:** R2

**Dependencies:** U1 (shares prompt-input.tsx edit session)

**Files:**
- `src/ui/components/prompt-input.tsx` (modify)

**Approach:** Track a `historySearchActive` boolean state in `PromptInput`. When input is empty and Ctrl+R fires, set `historySearchActive = true` and `historySearchQuery = ""`. While active, render `autocompleteItems` as all `historyItems` filtered by substring match against `historySearchQuery`. Typing advances `historySearchQuery`; arrows navigate highlighted item; Enter loads `historyItems[selectedIndex]` into the main value and exits search mode (does not submit). Esc exits search mode and restores the previous draft. The existing `PromptAutocompleteMenu` component renders the filtered list with its existing windowing. `historySearchActive` takes priority over normal autocomplete.

**Test scenarios:**
- Ctrl+R on empty input activates history search mode.
- Typing a substring filters the history list to matching entries only.
- Arrow keys navigate filtered results; highlighted entry previews in the menu.
- Enter with a selection loads the entry into the input field without submitting.
- Esc restores previous draft and exits search mode.
- Ctrl+R while autocomplete dropdown is already open is a no-op (stays in autocomplete mode).
- History search mode is inactive if `historyItems` is empty.

**Verification:** Manual test: start a session, send a few prompts, press Ctrl+R, type partial text, navigate with arrows, press Enter, confirm the input is loaded.

---

### U3. External $EDITOR integration

**Goal:** Ctrl+G (or `/editor`) opens `$EDITOR` with the current input draft in a temp file; on editor close, the saved content is loaded back into the input.

**Requirements:** R3

**Dependencies:** none

**Files:**
- `src/ui/ink-terminal.tsx` (modify — add `suspendForEditor(draft): Promise<string>` on `FurnaceTerminal`)
- `src/ui/components/prompt-input.tsx` (modify — handle Ctrl+G key, call `onOpenEditor` prop)
- `src/cli.ts` (modify — wire `onOpenEditor` to `terminal.suspendForEditor`)

**Approach:** `PromptInput` gains an `onOpenEditor?: (draft: string) => Promise<string>` prop. Ctrl+G fires it with the current value. `FurnaceTerminal.suspendForEditor(draft)` writes `draft` to a `tmp` file via `mkstemp`, calls `process.stdout.write("\x1b[?25h")` to restore cursor, disables Ink raw mode (`process.stdin.setRawMode(false)`), spawns `spawnSync(process.env.EDITOR || "vi", [tmpPath], { stdio: "inherit" })`, reads the temp file, re-enables raw mode, removes the temp file, and returns the content. If `$EDITOR` is not set, show a status notice "Set $EDITOR to use this feature" and return `draft` unchanged. If the editor exits non-zero, return `draft` unchanged.

**Test scenarios:**
- Ctrl+G when `$EDITOR` is unset shows a status notice and leaves input unchanged.
- Ctrl+G when busy (agent running) is blocked with a transient status notice.
- `/editor` command dispatches the same flow as Ctrl+G (wired via `handleInteractiveSubmit`).
- After editor closes with changes, input value reflects the saved file content.
- Editor exits non-zero (e.g., user kills it) → input unchanged.

**Verification:** Export `EDITOR=nano` (or any available editor), press Ctrl+G, type in the editor, save, confirm content loads in input.

---

### U4. Basic vim-mode input editing

**Goal:** Users who set `inputMode: "vim"` in preferences get a minimal normal/insert modal editing experience in `PromptInput`.

**Requirements:** R4

**Dependencies:** U1, U2 (share prompt-input.tsx)

**Files:**
- `src/ui/components/prompt-input.tsx` (modify)
- `src/preferences.ts` (modify — add `inputMode?: "standard" | "vim"` to `FurnacePreferences`)
- `src/config.ts` (modify — expose `inputMode` from preferences in `FurnaceConfig`)
- `src/ui/ink-terminal.tsx` (modify — pass `inputMode` prop through to `PromptInput`)

**Approach:** `PromptInput` gains an `inputMode?: "standard" | "vim"` prop (default `"standard"`). When `"vim"`, track `vimMode: "normal" | "insert"` (starts in insert mode when input is empty; enters normal mode via Esc). Normal-mode key bindings: `h`/`l` move cursor left/right; `i` enters insert before cursor; `a` enters insert after cursor; `x` deletes char at cursor; `dd` (two `d` presses detected via a `lastKey` ref) clears the entire value; `0` moves to start; `$` moves to end; `w` advances one word forward (find next space boundary); `b` moves one word back. All other keys in normal mode are no-ops. A small mode badge renders left of the prefix: `[N]` in normal mode (theme `warning` color), `[I]` in insert mode (theme `mutedForeground`). Enter submits from either mode. Tab / autocomplete behavior is unchanged (only active in insert mode).

**Patterns to follow:** existing Ctrl+W word-boundary logic in `prompt-input.tsx` for `w`/`b` word movement.

**Test scenarios:**
- With `inputMode: "standard"`, all existing key behaviors are unchanged (Esc clears, Up/Down history, etc.).
- With `inputMode: "vim"`, input starts in insert mode; Esc transitions to normal mode; `[N]` badge appears.
- Normal mode: `h`/`l` move cursor one character left/right.
- Normal mode: `i` returns to insert mode at cursor; `a` returns to insert mode one position right.
- Normal mode: `x` deletes the character at the cursor position.
- Normal mode: `dd` clears the entire input value.
- Normal mode: `0`/`$` jump to start/end of value.
- Normal mode: Enter submits current value (same as insert mode).
- Autocomplete dropdown is only shown and navigable while in insert mode.

**Verification:** Set `inputMode: "vim"` in `.furnace/preferences.json`, restart, verify `[I]` badge appears, press Esc, verify `[N]` badge, exercise each normal-mode binding.

---

### U5. /status command

**Goal:** Print a concise single-screen summary of session state inline in the transcript.

**Requirements:** R5

**Dependencies:** none

**Files:**
- `src/commands.ts` (modify — add `/status` to `slashCommandDefinitions`)
- `src/cli.ts` (modify — handle `/status` in `handleInteractiveSubmit` and `runPiped`)

**Approach:** In `handleInteractiveSubmit`, `/status` builds a formatted string from already-available runtime state and passes it to `terminal.setTranscript([...existing, { role: "assistant", content: statusText }])` — the same pattern as `/tasks`. Fields: session id, session title, cwd, model (display name if resolved), model settings summary, mode (agent/plan), context usage (tokens/window), theme name, active permission grant count, loaded skills count, custom commands count, current session cost if tracked. No new I/O or network calls.

**Test scenarios:**
- `/status` while idle renders all fields with non-empty values.
- `/status` while agent is running is blocked with a "available after the current turn finishes" notice (consistent with other commands).
- `/status` in piped (`-p`) mode prints status text to stdout.
- Output includes session id, model, mode, cwd, and context usage fields.

**Verification:** Run `/status` in an active session; verify all expected fields appear in the output.

---

### U6. /export command

**Goal:** Write the current conversation transcript to a file.

**Requirements:** R6

**Dependencies:** none

**Files:**
- `src/commands.ts` (modify — add `/export`)
- `src/session/export.ts` (create — `renderTranscriptMarkdown`, `renderTranscriptJson`)
- `src/cli.ts` (modify — handle `/export [json] [path]`)

**Approach:** `/export` parses its argument for an optional `json` token and an optional file path. Default format: markdown. Default path: `furnace-export-<ISO-timestamp>.md` (or `.json`) in `cwd`. `renderTranscriptMarkdown` produces a markdown document with session title as heading, each message as a block (user messages under `### You`, assistant messages under `### Furnace`), tool calls summarized as a single-line `> Tool: <name>(<args-summary>)`. `renderTranscriptJson` produces `{ sessionId, title, messages: [{role, content, model?, timestamp?}] }`. Writes via `writeFile`. On success, shows `showTransientStatus("Exported to <path>")`. On failure, shows the error.

**Test scenarios:**
- `/export` writes a `.md` file to cwd with session title and all visible messages.
- `/export json` writes a `.json` file with the expected envelope structure.
- `/export /tmp/out.md` writes to the explicitly specified path.
- Empty session (no messages yet) exports a file with the title heading and no message blocks.
- Export file path printed in the status notice after success.

**Verification:** Run `/export` in a session with a few exchanges, open the file, confirm content matches the conversation.

---

### U7. /diff and /undo commands (file snapshot tracking)

**Goal:** Show a unified diff of Furnace-edited files vs. their pre-session content; revert the most recent file edit.

**Requirements:** R7, R8

**Dependencies:** none (snapshot capture is independent; commands read the captured snapshots)

**Files:**
- `src/session/types.ts` (modify — extend `ToolCallEntryData` with `fileSnapshot?`)
- `src/cli.ts` (modify — capture snapshots in `onToolStart`; handle `/diff` and `/undo`)
- `src/commands.ts` (modify — add `/diff`, `/undo`)
- `package.json` (modify — add `diff` dependency)

**Approach:**

*Snapshot capture:* In `runSingleTurn`'s `onToolStart` callback (before `store.appendToolCall`), for calls where `call.name` is `"write"` or `"edit"`, parse the target path from `call.arguments` (JSON parse `args.path` for write, `args.patch` header for edit — reuse `patchTargetEntries` from `permissions.ts`). For each path, attempt `existsSync`/`readFileSync`; store as `fileSnapshot: { path, existed: boolean, previousContent?: string }` on the entry data passed to `appendToolCall`.

*`/diff`:* Walk `store.getActivePath(sessionId)`, collect all `tool_call` entries with `fileSnapshot` and `name` in `["write","edit"]` where `existed: true`. Group by path (keep earliest snapshot per path = the pre-session state). For each, read current file content, compute unified diff using the `diff` npm package (`createPatch`). Display in transcript. If no write/edit calls exist, show "No file changes this session."

*`/undo`:* Find the latest `tool_call` entry with a `fileSnapshot` not already marked undone (a `custom` entry with `kind: "undo"` referencing its `toolCallId`). If `existed`, restore `previousContent` via `writeFileSync`. If `!existed`, `unlinkSync` the file. Append `{ kind: "undo", toolCallId }` custom entry to prevent double-undo. Show status notice naming the path reverted.

**Test scenarios:**
- After a write tool call, `ToolCallEntryData` has `fileSnapshot.existed = false` and `previousContent = undefined` for a new file.
- After an edit tool call on an existing file, `fileSnapshot.existed = true` and `previousContent` equals the pre-edit file content.
- `/diff` with no write/edit calls shows "No file changes this session."
- `/diff` after one edit shows a unified diff between pre-edit and current content.
- `/diff` after multiple edits to the same file shows the cumulative diff (pre-session vs. current).
- `/undo` on a new file (existed: false) deletes the file and appends an undo entry.
- `/undo` on an edited existing file writes back `previousContent`.
- Calling `/undo` twice undoes two separate tool calls (stack behavior).
- `/undo` when no un-undone write/edit entries exist shows "Nothing to undo."

**Verification:** Run a session where the agent edits a file. Check `/diff` shows correct patch. Run `/undo`, confirm file is restored. Run `/diff` again — shows empty diff for the reverted file.

---

### U8. /copy command (clipboard)

**Goal:** Copy the most recent assistant response text to the system clipboard.

**Requirements:** R9

**Dependencies:** none

**Files:**
- `src/commands.ts` (modify — add `/copy`)
- `src/cli.ts` (modify — handle `/copy`; also wire Ctrl+O in `PromptInput` via a new `onCopy` prop or handle in the submit path)
- `src/ui/components/prompt-input.tsx` (modify — add Ctrl+O key binding that calls `onCopy`)

**Approach:** Shell out to `pbcopy` (macOS) or `xclip -selection clipboard` / `xsel --clipboard --input` (Linux) via `spawnSync` with the text piped to stdin. Detect platform via `process.platform`. For Ctrl+O in `PromptInput`: detect `key.ctrl && input === "o"` in `useInput`, call an `onCopy?: () => void` prop. `cli.ts` implements `onCopy` as: find the last assistant entry in the active path, call the clipboard helper with its content, then `showTransientStatus("Copied to clipboard.")`. `/copy` command does the same from the slash-command handler path.

**Test scenarios:**
- `/copy` with at least one assistant message copies the last assistant response text.
- `/copy` with no assistant messages yet shows "Nothing to copy yet."
- On macOS: `pbcopy` is invoked; on Linux: `xclip` or `xsel` is tried in order.
- Ctrl+O triggers the same copy behavior as `/copy`.
- `showTransientStatus("Copied to clipboard.")` appears after success.
- If clipboard tool is unavailable (neither pbcopy nor xclip/xsel found), shows "Clipboard tool not found on this platform."

**Verification:** Run a session, get a response, press Ctrl+O or type `/copy`, paste into another terminal window — confirm text matches last response.

---

### U9. /cost command (token and dollar accounting)

**Goal:** Show per-session and lifetime token counts and estimated USD cost.

**Requirements:** R10

**Dependencies:** none (can be developed independently; cost data accumulates naturally once U9 is deployed forward)

**Files:**
- `src/openrouter.ts` (modify — request `usage: {include: true}`; parse usage from final chunk; extend `OpenRouterAssistantResponse` and `OpenRouterModel`)
- `src/agent/loop.ts` (modify — accumulate usage across iterations; extend `RunAgentTurnResult`)
- `src/session/types.ts` (modify — extend `MessageEntryData` with optional `usage` field)
- `src/cli.ts` (modify — attach usage to assistant message entries; handle `/cost`)
- `src/commands.ts` (modify — add `/cost`)
- `src/session/store.ts` (modify — add `sumUsage(sessionId)` and `sumUsageForCwd(cwd)`)

**Approach:**

*Usage capture:* Add `"usage": {"include": true}` to `completeOpenRouterToolResponse` request body. Parse the final SSE chunk's `usage` field (`usage.prompt_tokens`, `usage.completion_tokens`) using a new `ChatCompletionUsage` type. Return `usage?` alongside `content`/`toolCalls` from `OpenRouterAssistantResponse`. In `runAgentTurn`, accumulate `promptTokens` across iterations (each iteration adds its `prompt_tokens`; `completionTokens` is from the final iteration). Return `usage?` in `RunAgentTurnResult`.

*Cost estimate:* Extend `OpenRouterModel` with `pricing?: { prompt: number; completion: number }` (USD per token). Parse from `/models` response `data[].pricing.prompt` / `data[].pricing.completion` (they arrive as numeric strings; `parseFloat`). In `runSingleTurn`, after the turn result, resolve `pricing` from the already-cached `modelListCache` (by matching `config.model`). Compute `costUsd = (promptTokens * pricing.prompt) + (completionTokens * pricing.completion)`. Append to `MessageEntryData` as `usage: { promptTokens, completionTokens, costUsd }` (all optional; undefined if OpenRouter did not return usage).

*`store.sumUsage`:* iterate `getActivePath` entries (or all entries for cwd lifetime), sum `data.usage` fields from assistant message entries. Return `{ promptTokens, completionTokens, costUsd, unknownTurns }` where `unknownTurns` counts entries where usage was absent.

*`/cost` command:* renders session total and cwd-lifetime total in transcript. Format: `Session: X prompt + Y completion = Z tokens, ~$A.BBBB USD`. Show `(N turns with unknown cost)` when applicable.

**Test scenarios:**
- After a turn where OpenRouter returns `usage`, the assistant `MessageEntryData` has non-null `usage.promptTokens`.
- After a turn where OpenRouter does not return `usage`, `usage` is `undefined`; no crash.
- `/cost` with no completed turns shows zero totals.
- `/cost` with one completed turn shows correct token sums and a non-zero cost when pricing is available.
- `sumUsageForCwd` aggregates across multiple sessions correctly.
- If pricing is unavailable for the current model, `costUsd` is `null` and `/cost` says "~$? (pricing unavailable for this model)".

**Verification:** Run a session with a real API call, type `/cost`, confirm token counts are close to what the OpenRouter dashboard shows for the same model.

---

### U10. Global preferences merge

**Goal:** `~/.furnace/preferences.json` serves as global defaults; project `.furnace/preferences.json` overrides.

**Requirements:** R11

**Dependencies:** none

**Files:**
- `src/preferences.ts` (modify — `loadPreferences` merges global + project; add `saveGlobalPreferences`; expose `globalPreferencesPath`)
- `src/cli.ts` (modify — `/model --global <name>` and `/theme --global <name>` detect `--global` prefix and call `saveGlobalPreferences`)
- `src/commands.ts` (modify — update usage strings for `/model` and `/theme`)

**Approach:** `loadPreferences(cwd)` first reads `~/.furnace/preferences.json` (global), then reads `.furnace/preferences.json` (project), merges with `Object.assign(globalPrefs, projectPrefs)` (project wins). Both reads are try/catch ENOENT-safe (identical to current). A new `globalPreferencesPath()` function returns `join(homedir(), ".furnace", "preferences.json")`. `saveGlobalPreferences(update)` reads the global file, merges, and writes it back — symmetric to `saveModelPreferences`. In `handleInteractiveSubmit`, when `/model`'s argument starts with `--global `, strip the flag and call `saveGlobalPreferences({ model })` instead of `saveModelPreferences(cwd, { model })`. Same for `/theme --global`.

**Test scenarios:**
- With only a global preferences file setting `theme: "nord"` and no project file, `loadPreferences` returns `theme: "nord"`.
- With both global `theme: "nord"` and project `theme: "gruvbox"`, result is `theme: "gruvbox"` (project wins).
- `/model --global anthropic/claude-opus-4` writes `model` to `~/.furnace/preferences.json`, not to the project file.
- `/theme --global nord` writes `theme` to the global file.
- Both global and project files missing → returns `{}` (same as today).
- `saveGlobalPreferences` creates `~/.furnace/` directory if it does not exist.

**Verification:** Set a global theme, switch to a project with no theme preference, start Furnace, confirm global theme is applied. Override at project level, confirm project preference wins.

---

### U11. Custom user-defined slash commands

**Goal:** `.furnace/commands/*.md` and `~/.furnace/commands/*.md` define user prompt templates discoverable and invocable as slash commands.

**Requirements:** R12

**Dependencies:** U10 (global path convention established)

**Files:**
- `src/custom-commands/loader.ts` (create)
- `src/custom-commands/types.ts` (create)
- `src/cli.ts` (modify — load custom commands alongside skills; dispatch via `runPromptQueue`; add to autocomplete items)
- `src/commands.ts` (no change needed — custom commands surface via autocomplete only)

**Approach:** `CustomCommand` type: `{ name: string; description: string; template: string; filePath: string; provenance: "project" | "global" }`. `loadCustomCommands(cwd)` scans `.furnace/commands/*.md` (project, higher precedence) and `~/.furnace/commands/*.md` (global). Filename minus `.md` is the command name; same validation rules as skills (lowercase, hyphens, 1-64 chars). File body is parsed for an optional front-matter block (`---\ndescription: ...\n---`); body below front-matter is the template. `$ARGUMENTS` in the template is replaced with the user's argument text; if absent, argument is appended with a newline separator.

In `cli.ts`, load custom commands alongside `loadSkills` at startup; merge into `slashAutocompleteItems` as `{ label: /name, description, value: /name, insertText: "/name " }`. In `handleInteractiveSubmit`, check `isCustomCommand(command.name)` before the unknown-command fallback; dispatch via `runPromptQueue` with the rendered template (hidden user message, `source: "custom_command"`).

**Test scenarios:**
- A file `.furnace/commands/greet.md` with body `Say hello to $ARGUMENTS warmly.` creates a `/greet` command.
- `/greet world` submits `Say hello to world warmly.` as the hidden user prompt.
- A template without `$ARGUMENTS` appends the argument: body `Summarize this:` + arg `main.ts` → `Summarize this:\nmain.ts`.
- Global `~/.furnace/commands/` commands appear in autocomplete.
- If both global and project define the same name, the project version wins (consistent with preference precedence).
- An invalid filename (e.g., `My Command.md`, `CMD.md`) is silently skipped with a diagnostic warning.
- Custom commands appear in the autocomplete dropdown alongside slash commands and skills.

**Verification:** Create a `.furnace/commands/` directory with a test command file, restart Furnace, type `/` and verify the command appears in autocomplete, invoke it, confirm it sends the rendered template.

---

### U12. CLI flags: --session and --output-format

**Goal:** `--session <id>` resumes a specific session by id; `--output-format json` wraps `-p` output in a JSON envelope.

**Requirements:** R13, R14

**Dependencies:** none

**Files:**
- `src/cli.ts` (modify — add `--session` and `--output-format` options to Commander; update session-resolution logic; wrap output in JSON when requested)

**Approach:**

*`--session <id>`:* Add `.option("--session <id>", "resume a specific saved session by id")` to the Commander program. In the action handler, if `options.session` is provided, attempt `store.getSession(options.session)` — throw if not found — then use that session id instead of creating new or getting latest. Mutually exclusive with `--continue` (last one wins, or flag error if both provided).

*`--output-format json`:* Add `.option("--output-format <format>", "output format for headless mode: text (default) or json")`. In `runSingleTurn` (the non-interactive path), after `renderDone()`, if `outputFormat === "json"`, suppress the existing `renderConversation` / `renderDone` calls and instead write `JSON.stringify({ content: result.content, model: config.model, sessionId, promptTokens: result.usage?.promptTokens ?? null, completionTokens: result.usage?.completionTokens ?? null }, null, 2) + "\n"` to stdout. Only applicable when running without a TTY or with `-p`.

**Test scenarios:**
- `furnace --session <valid-id>` opens that session and its transcript is loaded correctly.
- `furnace --session <invalid-id>` exits with a clear error message.
- `furnace -p "hello" --output-format json` prints a valid JSON object with `content` field.
- `furnace -p "hello"` (no `--output-format`) continues to print plain text as today.
- `furnace --output-format json` without `-p` in interactive TTY mode is a no-op (ignored or prints a notice that JSON format only applies to headless mode).

**Verification:** `furnace -p "what is 2+2" --output-format json | jq .content` produces the answer string without errors.

---

### U13. Housekeeping bundle: notifications, update check, /bug, shell completions

**Goal:** Desktop notifications on turn completion (opt-in); startup version check; `/bug` quick link; `furnace completion` shell script generation.

**Requirements:** R15, R16, R17, R18

**Dependencies:** U10 (notifications preference gated by global/project preferences)

**Files:**
- `src/cli.ts` (modify — notification logic, focus-reporting enable/disable, update check, `/bug` handler, `completion` subcommand)
- `src/commands.ts` (modify — add `/bug`)
- `src/ui/ink-terminal.tsx` (modify — expose `onFocusChange?: (focused: boolean)` callback wired to ANSI focus-reporting stdin events; clean up focus-reporting escape on `stop()`)

**Approach:**

*Desktop notifications (R15):* In `runInteractive`, write `\x1b[?1004h` to stdout after the terminal starts. Listen to raw stdin data events for `\x1b[I` (focus gain → `terminalFocused = true`) and `\x1b[O` (focus loss → `terminalFocused = false`). After each turn completes in `runPromptQueue`'s finally block (already where `\x07` bell is written), if `!terminalFocused && config.notifications` call `spawnSync("osascript", ["-e", `'display notification "Turn complete" with title "Furnace"'`])` on macOS (`process.platform === "darwin"`) or `spawnSync("notify-send", ["Furnace", "Turn complete"])` on Linux. Both wrapped in try/catch; failures are silent. Write `\x1b[?1004l` in the finally block of `terminal.run()`.

*Update check (R18):* In `runInteractive`, immediately after startup and before `terminal.run()`, spawn a non-blocking background fetch: `fetch("https://registry.npmjs.org/furnace/latest", { signal: AbortSignal.timeout(2000) }).then(r => r.json()).then(data => { if (semverGt(data.version, currentVersion)) terminal.setStatusNotice(`Furnace ${data.version} available — run npm i -g furnace to upgrade.`); }).catch(() => {})`. `currentVersion` is read from `package.json` via an import. `semverGt` is a small inline helper (split on `.`, compare numerically — no semver dep needed for this simple case). Notice auto-clears after 6 seconds.

*`/bug` (R17):* In `handleInteractiveSubmit`, `/bug` constructs `https://github.com/amoreX/furnace/issues/new` with optional `?title=<encodeURIComponent(argument)>` query param if argument provided. Calls `spawnSync("open", [url])` on macOS, `spawnSync("xdg-open", [url])` on Linux. Falls back to `showTransientStatus("File a bug at: <url>")` if neither opens successfully. Add to `slashCommandDefinitions` in `commands.ts`.

*Shell completions (R16):* Add a `completion` subcommand to the Commander program: `program.command("completion <shell>").action((shell) => { printCompletion(shell); })`. `printCompletion` emits a static bash/zsh/fish snippet that completes `furnace` flags (`--print`, `--continue`, `--session`, `--output-format`, `--new-session`, `--no-clear`, `--version`). Scripts are hardcoded string templates (no dynamic generation needed; the flag set is stable).

**Test scenarios:**
- R15: `preferences.notifications: true` + terminal sends `\x1b[O` → `terminalFocused = false`; after turn, osascript/notify-send is invoked. `notifications: false` (default) → never invoked.
- R15: ANSI focus events that arrive before the terminal is fully started are buffered and applied.
- R18: When fetched version > current version, a status notice appears; when equal or lower, no notice; when fetch times out, no error and no notice.
- R17: `/bug` opens a URL (or shows the URL string on fallback); `/bug memory leak` appends the title in the URL.
- R16: `furnace completion bash` prints a bash completion script containing `--print`, `--session`, `--output-format`.
- R16: `furnace completion zsh` prints a `#compdef furnace` script.
- R16: `furnace completion <unknown>` prints an error listing supported shells.

**Verification:** Set `notifications: true` in preferences, start Furnace, switch to another app, send a prompt, wait for the agent to finish — a desktop notification should appear. Run `furnace completion bash >> ~/.bash_completion`, open a new shell, type `furnace --<TAB>`, verify flags appear.

---

## Sources and Research

- Claude Code keybindings reference: `chat:newline` (Ctrl+J), `chat:imagePaste` (Ctrl+V), history search (Ctrl+R), `/editor` for `$EDITOR`.
- Codex CLI: `/diff`, `/status`, `/copy`, `--output-format json`, `resume <SESSION_ID>` flag, vim mode, Ctrl+G for `$EDITOR`.
- Gemini CLI: `/chat share` (export), `/chat restore` (undo via checkpoint), focus-detection for notifications.
- OpenCode: `/undo` (git-based), `stats` command (cost accounting), custom command templates, global preferences merge.
- OpenRouter API: `usage: {include: true}` request body param; `data[].pricing.prompt`/`.completion` in `/models` response.
- ANSI focus-reporting: `\x1b[?1004h` enable, `\x1b[I`/`\x1b[O` events, `\x1b[?1004l` disable.

---

## Verification Contract

- All existing tests pass (`npm test` → 80/80 or more after new tests are added).
- TypeScript compiles cleanly (`npm run typecheck`).
- New tests added for: preference merge (U10), custom commands loader (U11), file snapshot capture logic (U7), usage accumulation (U9), `/export` format rendering (U6), `slashAutocompleteMatches` with history-search mode (U2), CLI `--output-format json` output shape (U12), and completion script content (U13).
- Manual tuistory verification passes for each UI-touching unit (U1, U2, U3, U4, U5, U8, U13-notifications).

---

## Definition of Done

- All 18 requirements (R1–R18) have at least one passing test scenario and one manual-verification confirmation.
- `/diff` and `/undo` correctly handle both newly-created files and modified pre-existing files in a live session.
- `/cost` displays non-zero values after a real API turn with a model that returns usage data.
- Global preference merge is confirmed: set theme globally, override at project level, confirm project wins.
- Custom command invocation confirmed end-to-end with a template file and `$ARGUMENTS` substitution.
- `furnace --output-format json` piped through `jq` parses without error.
- Desktop notification fires after a turn when terminal is unfocused and `notifications: true` is set.
- `npm test` and `npm run typecheck` pass cleanly on the final commit.
