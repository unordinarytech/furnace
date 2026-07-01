---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# fix: inline, auto-opening pickers for /theme, /model, and /resume

## Summary

`/theme`, `/model`, and `/resume` (and its `/history` alias) currently only reveal their pickers after the user types the full command and presses Enter, at which point the picker replaces the entire chat transcript as a full-screen swap — including `/model`'s secondary Tab-triggered per-model settings editor, which is itself a nested full-screen swap. This reads as disconnected and jarring: nothing happens while typing, then the whole screen jumps. This plan makes all three pickers (and the model settings editor) open automatically, inline, below the input the instant the bare command is typed — matching the pattern already used for approval/question/task/queue panels — with live keyboard navigation, live-preview where applicable, and type-to-filter for the remaining argument text, while leaving the chat transcript visible at all times and preserving today's non-interactive/piped and fast-typed direct-argument behavior unchanged.

**Product Contract preservation:** No upstream Product Contract exists for this work (`product_contract_source: ce-plan-bootstrap`) — this plan originates directly from a user bug report, confirmed via clarifying questions (see Sources & Research).

---

## Problem Frame

`FurnaceApp`'s render tree (`src/ui/ink-terminal.tsx`) currently treats `state.screen.kind` as mutually exclusive with the chat transcript: when it's `"history"`, `"model"`, or `"theme"`, the corresponding screen component (`HistoryScreen`, `ModelScreen`, `ThemeScreen`) replaces `LiveChat` entirely. These screens only ever become visible after `cli.ts`'s `handleInteractiveSubmit` processes a full `Enter`-submitted command (`src/cli.ts` lines ~273-341), which calls `terminal.showHistory`/`showModelPicker`/`showThemePicker`. Because of this, typing `/theme` produces no feedback at all until Enter is pressed, at which point the whole layout swaps — the input box (now showing a fresh empty draft) stays anchored at the bottom while a completely different screen appears above it, which reads as the menu popping up "on top of" the input rather than growing out of it. `ModelScreen` compounds this with its own nested `editing` state: pressing Tab on a highlighted model swaps in `ModelEditorScreen`, a second full-screen replacement for per-model settings (reasoning effort, context length, fast routing).

Every other transient UI in this app (`ApprovalPrompt`, `QuestionPrompt`, `TaskPanel`, `QueuedPromptPanel`) already uses a different, better pattern: they render as an additional bordered panel below `LiveChat` and above `PromptInput`, while the transcript stays mounted and visible, and Ink's flex layout (`flexGrow`/`overflow: hidden` on `LiveChat`) automatically shrinks the transcript to make room — no manual row-budget math needed. `/theme`, `/model`, and `/resume` are the only three screens that don't follow this pattern.

## Scope Boundaries

**In scope:**
- Auto-opening `/theme`, `/model`, `/resume`/`/history` pickers the instant the bare command is typed (no Enter required), as an inline below-input panel, not a full-screen replacement
- Moving `HistoryScreen`, `ModelScreen` (including its nested per-model settings editor), and `ThemeScreen` to render inline alongside `LiveChat` instead of replacing it
- Adding type-to-filter to `ThemeScreen` (the one screen that currently lacks it), for parity with `HistoryScreen`/`ModelScreen`
- Proactively prefetching the OpenRouter model list at startup so the `/model` picker has data ready by the time it opens in the common case
- Preserving existing piped/non-interactive `/theme <slug>` behavior and the interactive fast-typed/pasted `/theme <slug>` + Enter direct-apply path, unchanged
- Preserving the existing "unavailable while a turn is running" guard already applied to `/model`, `/resume`, and bare `/theme` today

**Deferred to Follow-Up Work:**
- Any other slash commands not currently backed by a `UiScreen` (e.g. `/tasks`, `/skills`, `/compact`) — they don't have a full-screen-swap problem today and are out of scope
- Redesigning `ModelScreen`'s or `ThemeScreen`'s visual layout beyond what's needed to render inline and support filtering
- A generic, reusable "inline picker" abstraction shared by all three screens — each screen keeps its own component and `useInput` hook; only their render position and trigger timing change (see KTD-B)

---

## Requirements

- **R1**: Typing the bare command `/theme`, `/model`, or `/resume`/`/history` (exact match, no trailing text) immediately opens its picker as an inline panel below the input, without requiring Enter.
- **R2**: The inline picker keeps its existing keyboard navigation (up/down, Enter to select, Esc to cancel) and live preview (theme).
- **R3**: Continuing to type after auto-open acts as a live filter over the picker's own choices, consistent with `HistoryScreen`/`ModelScreen`'s existing filter behavior; `ThemeScreen` gains this same capability.
- **R4**: No screen (history, model, theme, or the model's per-model settings editor) replaces the chat transcript; `LiveChat` remains mounted and visible at all times.
- **R5**: The OpenRouter model list is prefetched proactively at startup so the `/model` picker opens with data ready in the common case; a brief inline loading message covers the rare case where the prefetch hasn't resolved yet.
- **R6**: Non-interactive/piped-mode `/theme <slug>` and the interactive fast-typed/pasted `/theme <slug>` + Enter direct-apply path continue to work unchanged.
- **R7**: The auto-trigger respects the same "unavailable while a turn is running" guard that already blocks `/model`, `/resume`, and bare `/theme` via Enter today (no auto-open mid-turn).

## Assumptions

- "Bare command" means the input text is exactly `/theme`, `/model`, `/resume`, or `/history` with no trailing argument text — as soon as a space or further characters follow, the text no longer matches and no (further) auto-trigger fires for that keystroke.
- Ink calls every currently-mounted, active `useInput` hook for each keypress; since `PromptInput`'s own hook already short-circuits when `disabled` is true (`enabled = active && !disabled`), an auto-opened picture screen's own `useInput` hook can safely receive all subsequent keystrokes with no extra plumbing.
- `chatViewportRows`/Ink's existing `flexGrow`+`overflow: hidden` sizing on `LiveChat` already auto-shrinks the transcript to make room for sibling panels (this is how `ApprovalPrompt`/`TaskPanel`/`QueuedPromptPanel` already coexist with `LiveChat` today) — no new row-budget arithmetic is needed for the picker panels.

---

## Key Technical Decisions

**KTD-A — Auto-trigger is driven by a new `onInputChange` hook on `FurnaceTerminal`, decided in `cli.ts`, not inside the UI layer.** `ink-terminal.tsx` is a thin rendering shell; all command routing and business logic already lives in `cli.ts`'s `handleInteractiveSubmit`. Rather than teaching the UI layer to recognize command names, `PromptInput`'s existing `onChange` is forwarded through a new `onInputChange` option to `cli.ts`, which reuses its own bare-command detection and, on an exact match, calls the same `terminal.showHistory`/`showModelPicker`/`showThemePicker` methods it already calls from the Enter path, then clears the draft via the already-existing `terminal.setInputDraft("")`. This keeps command semantics in one place and requires no new command-name knowledge in the UI layer.

**KTD-B — Reuse the existing `UiScreen` variants and screen components unchanged in behavior; only change where they render and when they open.** `HistoryScreen`, `ModelScreen` (with its nested `editing` sub-state), and `ThemeScreen` already have working keyboard handling, filtering (except Theme), and selection logic. Rewriting them onto a shared "inline picker" abstraction would be a bigger, riskier change for no behavioral benefit. Instead: (1) `FurnaceApp` renders `LiveChat` unconditionally and renders whichever screen is active as an *additional* panel in the same conditional stack as `ApprovalPrompt`/`QuestionPrompt`/`TaskPanel` (right after `LiveChat`, before `ApprovalPrompt` so approval still visually wins if both were ever somehow pending); (2) the trigger moves from "only after Enter" to "also on the instant the bare command is typed," via KTD-A. Because `ModelScreen`'s per-model editor (`ModelEditorScreen`) is already just a conditional branch *within* `ModelScreen`'s own render (not a separate `UiScreen` kind or a separate full-screen swap call), it automatically becomes inline as soon as `ModelScreen` itself is inline — no separate work needed to satisfy "nothing should be a full-screen subscreen."

**KTD-C — `ThemeScreen` gains a filter state + `useInput` hook mirroring `HistoryScreen`'s existing pattern, not a new filtering mechanism.** `HistoryScreen` and `ModelScreen` already filter their choices as the user types (backspace/delete edits the filter, plain characters append to it, arrows/enter/escape are excluded so they don't leak into the filter text). `ThemeScreen` is the one holdout with no filter at all. Copying the same shape (filter state, matching against `displayLabel`/`name`/`description`) keeps all three screens' typing behavior consistent, which is what makes "type `/theme tokyo-night`" work uniformly across all three commands via the same mechanism (open the picker on bare match, then live-filter as further characters arrive), rather than inventing a parallel "direct argument" code path for the newly-inline flow.

**KTD-D — The OpenRouter model list is prefetched once at `runInteractive` startup into a cached promise, reused by both the auto-trigger and the manual `/model` Enter path.** Today, `/model`'s Enter handler calls `listOpenRouterModels(input.config)` fresh every time, showing a transient "Loading OpenRouter models..." message while it awaits. Since the auto-trigger needs to open instantly on a keystroke (no perceptible delay), the fetch is kicked off once, early, as soon as `runInteractive` starts (in parallel with other init work), and both call sites await the same cached promise. If a user types `/model` fast enough that the prefetch hasn't resolved yet, the existing "Loading OpenRouter models..." transient message is shown as a fallback while the shared promise settles — no new UI component needed for this rare path.

**KTD-E — The auto-trigger only fires when `!running`, matching the existing Enter-time guard exactly.** `handleInteractiveSubmit` already blocks `/model`, bare `/resume`, and bare `/theme` while a turn is in flight (`running && prompt.startsWith("/")` branch), showing `"<command> is available after the current turn finishes."` The new `onInputChange` handler checks the same `running` flag before auto-opening a picker, so typing `/theme` mid-turn does not pop open a picker that would be immediately confusing to interact with; the existing transient-status guidance still applies once Enter is pressed.

---

## Implementation Units

### U1. Wire `onInputChange` end-to-end and extract shared picker-opening logic

**Goal:** `cli.ts` learns about every keystroke change to the input draft and can react by opening a picker on an exact bare-command match, respecting the same `running` guard used today.

**Requirements:** R1, R7

**Dependencies:** None

**Files:**
- `src/ui/ink-terminal.tsx` (`CreateFurnaceTerminalOptions`, `createFurnaceTerminal`, `PromptInput`'s `onChange` wiring)
- `src/cli.ts` (register the new option; extract the body of the existing `/model`, `/theme`, and history Enter-branches in `handleInteractiveSubmit` into standalone functions callable from both the Enter path and the new auto-trigger path)

**Approach:**
- Add `onInputChange?: (value: string) => void` to `CreateFurnaceTerminalOptions`; in the `onChange` passed to `PromptInput` inside `FurnaceApp`/wherever the draft is set, call both `store.update({ inputDraft: value })` (existing) and the new `options.onInputChange?.(value)`.
- In `src/cli.ts`, pass `onInputChange: (value) => { ... }` when constructing the terminal. Implement bare-command detection using the same normalization `parseSlashCommand` already applies (trim, case handling) — the value must exactly equal one of `/theme`, `/model`, `/resume`, `/history` (reuse `isHistoryCommand` for the last two) with no argument.
- Guard: skip entirely if `running` is true, or if a screen other than `"chat"` is already active (defensive; in practice `PromptInput` would already be disabled and not fire `onChange` in that state).
- Extract the current Enter-branch bodies for `isHistoryCommand(command.name)`, `/model`, and `/theme` (no-argument case) in `handleInteractiveSubmit` into standalone functions (e.g. `openHistoryPicker()`, `openModelPicker()`, `openThemePicker()`) so both the Enter path and the new `onInputChange` handler call the same code — no duplicated picker-opening logic.
- On a match, call the corresponding `open*Picker()` function, then `terminal.setInputDraft("")` to clear the typed command text.

**Patterns to follow:** Existing `onQueueEdit`/`onModeCycle`-style optional callback options on `CreateFurnaceTerminalOptions`; existing `isHistoryCommand` usage in `src/commands.ts`.

**Test scenarios:**
- A pure bare-command-match helper (colocated with the new logic, exported for testing) returns true for `/theme`, `/model`, `/resume`, `/history` and false for prefixes (`/th`), trailing arguments (`/theme tokyo-night`), and unrelated text.
- `isHistoryCommand("/resume")` and `isHistoryCommand("/history")` both still resolve to the same picker-opening path (regression, already covered by existing tests — confirm no regression).

**Verification:** `npm run typecheck` and `npm run test` pass.

---

### U2. Render Theme/Model/History screens inline instead of as full-screen swaps

**Goal:** `LiveChat` stays mounted and visible at all times; the active picker screen (including the model editor sub-state) renders as an additional panel below it, in the same conditional stack as `ApprovalPrompt`/`QuestionPrompt`/`TaskPanel`.

**Requirements:** R4

**Dependencies:** U1 (so the panel can actually auto-open before this unit is manually tested end-to-end, though this unit's rendering change is independently testable via the existing Enter path)

**Files:**
- `src/ui/ink-terminal.tsx` (`FurnaceApp`'s render tree)

**Approach:**
- Change the `state.screen.kind === "history" ? ... : state.screen.kind === "model" ? ... : state.screen.kind === "theme" ? ... : <LiveChat .../>` ternary chain so `<LiveChat .../>` always renders, and the screen component renders as a separate conditional element placed right after `LiveChat` and before `ApprovalPrompt` in the panel stack (`{!state.approval && state.screen.kind !== "chat" ? <ScreenFor screen={state.screen} .../> : null}`).
- Confirm `disabled={state.screen.kind !== "chat" || Boolean(state.approval)}` on `PromptInput` is unchanged (it already correctly disables the input while any screen is active).
- No changes needed to `hintItems(state.screen.kind)` or the footer hint bar — they're already screen-position-agnostic.

**Patterns to follow:** The existing `{!state.approval && state.tasks.length > 0 ? <TaskPanel .../> : null}` / `{!state.approval && state.queuedPrompts.length > 0 ? <QueuedPromptPanel .../> : null}` conditional-panel pattern already in `FurnaceApp`.

**Test scenarios:**
- A structural test (string-matching the compiled/source render logic, mirroring the prior layout plan's approach) confirming `<LiveChat` is not gated behind a `state.screen.kind === "chat"` ternary — i.e. it renders unconditionally.

**Verification:** `npm run typecheck`, `npm run build`, `npm run test` pass; manual check (deferred to U5) that opening `/theme`/`/model`/`/resume` no longer blanks out the transcript.

---

### U3. Add type-to-filter to `ThemeScreen`

**Goal:** `ThemeScreen` filters its choices as the user types, matching `HistoryScreen`/`ModelScreen`'s existing behavior, so "type `/theme` then keep typing a slug" works the same way across all three commands.

**Requirements:** R2, R3

**Dependencies:** None (independent of U1/U2, but only meaningfully exercised once combined with them)

**Files:**
- `src/ui/ink-terminal.tsx` (`ThemeScreen`)
- `test/smoke.test.mjs`

**Approach:**
- Add `const [filter, setFilter] = React.useState("")` to `ThemeScreen`, mirroring `HistoryScreen`.
- Add a `useInput` hook (excluding up/down/return/escape, mirroring `HistoryScreen`'s exact exclusion list) that appends typed characters to `filter` and handles backspace/delete.
- Filter `screen.choices` by `displayLabel`, `name`, and `description` (case-insensitive substring match) before mapping to `SelectList` items, matching `filterModels`'s shape.
- Render a `Filter: {filter || "type to search"}` line, matching `HistoryScreen`'s existing filter-status line, for visual consistency.

**Patterns to follow:** `HistoryScreen`'s existing filter state/useInput/render pattern (this file, ~line 1982); `filterModels` (~line 2261) for the matching-predicate shape.

**Test scenarios:**
- A new exported/testable filter helper (e.g. `filterThemeChoices(choices, filter)`) returns all choices for an empty filter, and narrows correctly for a matching substring against `displayLabel`, `name`, or `description`.

**Verification:** `npm run typecheck` and `npm run test` pass.

---

### U4. Prefetch the OpenRouter model list proactively

**Goal:** The `/model` picker has data ready by the time it opens in the common case, whether opened via auto-trigger or Enter.

**Requirements:** R5

**Dependencies:** U1 (shares the extracted `openModelPicker()` function)

**Files:**
- `src/cli.ts`

**Approach:**
- Near the top of `runInteractive` (as early as possible, in parallel with other init work), kick off `listOpenRouterModels(input.config)` once and store the resulting promise in a local variable scoped to `runInteractive`.
- Update `openModelPicker()` (from U1) to await this cached promise instead of calling `listOpenRouterModels` fresh; if the promise is already resolved, the picker opens with no visible delay. If not yet resolved, keep the existing "Loading OpenRouter models..." transient-message behavior as a fallback while awaiting.
- No change to the shape of `showModelPicker`'s callback wiring (model/settings save, `refreshCurrentSession`, etc.).

**Patterns to follow:** Existing async init patterns already present in `runInteractive` (e.g. `let skillCatalog = await loadSkills(...)` at the top of the function) — the model-list fetch follows the same "kick off early, await where needed" shape, but as a non-blocking promise rather than an awaited value at startup (so it doesn't delay the terminal from becoming interactive).

**Test scenarios:**
- No new automated test is practical for network prefetch timing; covered by manual `tuistory` verification in U5 (typing `/model` shortly after the TUI is ready shows the picker with real choices, not a loading message, in the common case).

**Verification:** `npm run typecheck` and `npm run test` pass.

---

### U5. Regression sweep and manual verification

**Goal:** Confirm the full auto-open, inline-render, type-to-filter behavior works end-to-end for all three commands, the model editor is inline, existing direct-argument paths are unaffected, and the busy-state guard holds.

**Requirements:** R1-R7 (verification pass)

**Dependencies:** U1, U2, U3, U4

**Files:**
- `test/smoke.test.mjs` (any additional coverage gaps found during the sweep)

**Approach:**
- Run `npm run typecheck`, `npm run build`, `npm run test` and fix anything broken.
- Grep for any remaining references to the old full-screen-swap assumption (e.g. stale comments) and clean them up if trivial.
- Use the `tuistory` skill to manually verify, in a live session:
  - Typing bare `/theme` auto-opens the picker inline below the input (transcript still visible above); arrow keys live-preview the theme; typing a slug (e.g. `tokyo-night`) filters the list; Enter selects; Esc cancels back to the previous theme and plain input.
  - Typing bare `/model` auto-opens instantly (prefetched list, no loading flash in the common case); Tab on a highlighted model opens the per-model settings editor inline (not a full-screen swap); arrow/enter adjust a setting; Esc returns to the model list, then Esc again returns to plain input.
  - Typing bare `/resume` and `/history` both auto-open the session picker inline; typing narrows the list by title; Enter switches sessions.
  - Typing a full `/theme <slug>` fast enough to skip the bare-match instant (or pasting it) and pressing Enter still direct-applies the theme without opening the picker (existing behavior, unaffected).
  - Typing `/theme` while a turn is running does not auto-open the picker (matches the existing Enter-time guard message).
  - Piped/non-interactive `/theme <slug>` usage (headless mode) is unaffected.

**Verification:** All automated tests green; manual `tuistory` checklist above passes with no regressions.

---

## Sources & Research

- User bug report (this session): `/theme` shows nothing while typing, then swaps to a full-screen picker on Enter with the input jumping position; requested the same auto-opening, keyboard-linked, both-directions-typable behavior for `/model` and history/`/resume` as well.
- Clarifying questions (this session, via `AskUser`), all confirmed:
  1. Auto-open-on-bare-match + inline-below-input + live-filter-by-typing + Enter-to-apply + Esc-to-cancel — confirmed as the intended flow.
  2. Whether `/model`'s nested settings editor should also go inline — user corrected scope to: nothing should be a full-screen subscreen (not just the three top-level commands).
  3. Whether to prefetch the OpenRouter model list proactively vs. show a loading row each time — user chose proactive prefetch.
- Direct code reading (this session): `FurnaceApp`'s render tree, `HistoryScreen`/`ModelScreen`/`ModelEditorScreen`/`ThemeScreen`, `SelectList`'s `active`/`isActive`-gated `useInput`, `PromptInput`'s `disabled`-gated `useInput`, `chatViewportRows`/`LiveChat`'s `flexGrow`/`overflow: hidden` sizing, and `cli.ts`'s existing Enter-branch picker-opening code and `running`-guard logic — all in `src/ui/ink-terminal.tsx` and `src/cli.ts` in this repository, current branch `feat/tui-copy-command-markdown-revamp`.
