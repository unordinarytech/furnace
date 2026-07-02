---
title: "feat: /settings TUI panel for app-level preferences"
date: 2026-07-03
sequence: "002"
type: feat
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
product_contract_source: ce-plan-bootstrap
---

# feat: /settings TUI panel for app-level preferences

## Goal Capsule

Add a `/settings` slash command that opens an interactive TUI panel listing all app-level preferences — sidebar visibility, input mode, and notifications — with immediate persistence on change. Settings are navigated with arrow keys and toggled with Enter, following the same UX pattern as the existing model editor panel.

## Problem Frame

There is no unified place to view or change app preferences from the TUI. Sidebar visibility is only toggled via `Ctrl+/`; input mode (standard vs. vim) has no runtime toggle at all; notifications have no UI surface. The `/model` and `/theme` commands each have dedicated UIs but leave the remaining preferences inaccessible mid-session without restarting.

## Requirements

- R1: `/settings` (alias `/prefs`) opens a settings panel above the chat input, following the screen-based pattern used by the model editor and permissions panel.
- R2: The panel lists three toggleable preferences: **Sidebar** (on/off), **Input mode** (standard/vim), **Notifications** (on/off).
- R3: Pressing Enter on a setting cycles its value immediately; the change takes effect in the running session and is saved to global preferences (`~/.furnace/preferences.json`).
- R4: The panel renders the current value of each setting, visually distinguished (selected row highlighted in primary color).
- R5: Esc or `/settings` a second time closes the panel and returns focus to the chat input.
- R6: `/settings` in headless (non-interactive) CLI mode prints current values as key=value pairs and exits, consistent with how `/status` works.

## Scope Boundaries

### In scope
- `/settings` slash command + `/prefs` alias
- `SettingsPanel` TUI component (sidebar, input mode, notifications)
- Persistence via `saveGlobalPreferences` on each toggle
- Headless mode text output for `/settings`

### Deferred to Follow-Up Work
- Skill paths editor (string list editing is a separate UI challenge)
- Per-project preference overrides
- Model-level settings (already covered by `/model`)
- Theme selection (already covered by `/theme`)
- Lofi toggle in settings (already available via `/lofi` command)

### Out of scope
- Any new preference not already in `FurnacePreferences`
- A standalone settings file separate from `~/.furnace/preferences.json`

---

## Key Technical Decisions

**KTD1 — Screen-based panel, not inputOverride**
`/settings` follows the `{ kind: "settings" }` `UiScreen` pattern introduced for model editor and permissions, not `inputOverride`. This makes the panel appear above the chat input (per the layout refactor already shipped), keeps it modal (disables the text input while open), and uses the existing `showSettings` / `store.update({ screen: { kind: "chat" } })` lifecycle.

**KTD2 — Immediate save on toggle**
Each Enter keystroke fires `saveGlobalPreferences` and updates `UiStore` state in one step — no separate "apply" or "save" button. Consistent with how model editor writes back on each selection (`screen.onSelect` is called per change).

**KTD3 — `showSettings` on `FurnaceTerminal` interface**
The CLI layer calls `terminal.showSettings(currentPrefs, onSave)` when `/settings` is parsed. This follows the `showModelEditor` / `showPermissions` pattern: the terminal owns the UI; cli.ts owns persistence. The `onSave` callback receives the full updated `FurnacePreferences` and calls `saveGlobalPreferences`.

**KTD4 — Row model with typed values**
Each settings row carries `{ label, key, value, options[] }`. The panel cycles `options` on Enter and derives the display value from the current index. This avoids hardcoding toggle logic per row and makes adding a new setting a one-liner in the row array.

**KTD5 — inputMode change takes effect immediately via `setSidebarEnabled`/`setInputMode` equivalents**
The panel calls the appropriate `UiStore` setters (`store.update({ inputMode })`, `store.update({ sidebarEnabled })`, `store.update({ notifications })`) on each toggle so the session reflects the change without restart.

---

## High-Level Technical Design

```
/settings parsed in cli.ts interactive handler
  └─ terminal.showSettings(prefs, onSave)
       └─ store.update({ screen: { kind: "settings", prefs, onSave } })

SettingsPanel (above PromptInput, same stack as TaskPanel/ApprovalPrompt)
  ┌─────────────────────────────────────────┐
  │ Settings                   Esc to close │
  │ › Sidebar          [on]                 │  ← selected row (primary color)
  │   Input mode       [standard]           │
  │   Notifications    [off]                │
  └─────────────────────────────────────────┘
  ↑↓ navigate rows   Enter toggle + save

useInput (isActive: focus === "settings")
  ↑↓  → setSelectedIndex
  Enter → cycle value → store.update(field) → onSave(updatedPrefs)
  Esc  → store.update({ screen: { kind: "chat" }, focus: "input" })
```

---

## Implementation Units

### U1. Extend UiScreen and FurnaceTerminal with settings screen type

**Goal:** Add the `{ kind: "settings" }` variant to `UiScreen` and expose `showSettings` on the terminal interface and UiStore, wiring persistence to cli.ts.

**Requirements:** R1, R3

**Dependencies:** none

**Files:**
- `src/ui/ink-terminal.tsx`
- `src/cli.ts`

**Approach:**
- Add `{ kind: "settings"; prefs: FurnacePreferences; onSave: (prefs: FurnacePreferences) => void }` to the `UiScreen` union in `ink-terminal.tsx`.
- Add `showSettings(prefs: FurnacePreferences, onSave: (prefs: FurnacePreferences) => void): void` to the `FurnaceTerminal` interface; implement it in the `UiStore` method block as `store.update({ screen: { kind: "settings", prefs, onSave }, focus: "settings" })`.
- Add `"settings"` to the `UiFocus` union type.
- In `cli.ts`'s interactive command handler, when `command.name === "/settings"` call `terminal.showSettings(currentPrefs, async (updated) => { await saveGlobalPreferences(updated) })` where `currentPrefs` is built from `input.config` fields.
- Guard `disabled` on `PromptInput` to also include `state.screen.kind === "settings"`.

**Patterns to follow:** `showModelEditor` / `showPermissions` in UiStore method block; `/permissions` handler in cli.ts interactive loop.

**Test scenarios:**
- `showSettings(prefs, cb)` → `getSnapshot().screen.kind === "settings"` and `getSnapshot().focus === "settings"`
- Calling it a second time replaces the screen (idempotent open)
- `store.update({ screen: { kind: "chat" } })` returns focus to chat (existing pattern, no new logic needed)

**Verification:** Typecheck clean; no existing screen transitions broken.

---

### U2. Add SettingsPanel component

**Goal:** Implement the `SettingsPanel` React component that renders the three settings rows, handles keyboard navigation, and calls back on save.

**Requirements:** R2, R3, R4, R5

**Dependencies:** U1

**Files:**
- `src/ui/ink-terminal.tsx`

**Approach:**
- Define a `SETTINGS_ROWS` constant array: three entries — Sidebar (`sidebarEnabled`, `["on", "off"]`), Input mode (`inputMode`, `["standard", "vim"]`), Notifications (`notifications`, `["off", "on"]`). Each entry has `label`, `prefKey`, and `options`.
- `SettingsPanel` receives `{ screen, store }` where `screen` is the `settings` variant.
- Local state: `selectedIndex` (0-based row), and a mutable copy of `screen.prefs` derived via `React.useState`.
- `useInput` (isActive: `store.getSnapshot().focus === "settings"`):
  - `↑` / `↓` → cycle `selectedIndex`
  - `Enter` → advance the current row's value to the next option, call `store.update` for the corresponding field, call `screen.onSave(updatedPrefs)`
  - `Esc` → `store.update({ screen: { kind: "chat" }, focus: "input" })`
- Render: bordered box (`borderStyle="round"`, `borderColor=primary`), header row with title and "Esc to close" hint, one row per setting showing label and current value in brackets. Selected row uses primary color + `›` prefix.

**Patterns to follow:** `ModelEditorPanel` structure and `useInput` pattern; `QueuedPromptPanel` action display style.

**Test scenarios:**
- Panel renders with correct current values from `screen.prefs`
- `↑`/`↓` wraps around (first row up → last row; last row down → first row)
- Enter on Sidebar row: `store.getSnapshot().sidebarEnabled` flips; `screen.onSave` called with updated prefs
- Enter on Input mode row: `store.getSnapshot().inputMode` cycles `"standard" → "vim" → "standard"`
- Enter on Notifications row: cycles `false → true → false`
- Esc closes panel and returns `focus === "input"`
- Panel title and Esc hint are visible

**Verification:** Visual inspection confirms rows, values, and navigation work correctly.

---

### U3. Render SettingsPanel above input and add /settings to command list

**Goal:** Wire `SettingsPanel` into the above-input panel stack in `FurnaceApp` and register `/settings` (alias `/prefs`) as a slash command.

**Requirements:** R1, R5

**Dependencies:** U1, U2

**Files:**
- `src/ui/ink-terminal.tsx`
- `src/commands.ts`

**Approach:**
- In `FurnaceApp`'s above-input stack (the `<Box flexShrink={0} flexDirection="column">` section), add a conditional render for `state.screen.kind === "settings"`: `<SettingsPanel screen={state.screen} store={store} />`.
- Add to `slashCommandDefinitions` in `commands.ts`: `{ name: "/settings", aliases: ["/prefs"], description: "View and change app preferences" }`.
- Update `hintItemsForState` to return a settings-specific hint when `state.screen.kind === "settings"` (e.g., `["↑↓ navigate", "Enter toggle", "Esc to close"]`).

**Patterns to follow:** `ApprovalPrompt` and `TaskPanel` conditional renders in the above-input stack; existing `slashCommandDefinitions` entries with aliases.

**Test scenarios:**
- `/settings` appears in slash autocomplete list
- `/prefs` alias also resolves in autocomplete
- Typing `/settings` and submitting opens the panel (smoke: screen kind becomes `"settings"`)
- With panel open, hint bar shows settings navigation hints

**Verification:** Settings panel opens from `/settings` input, shows correct hints, closes cleanly on Esc.

---

### U4. Handle /settings in cli.ts interactive loop and headless output

**Goal:** Parse `/settings` in the interactive command handler and print current settings in headless (piped) mode.

**Requirements:** R1, R6

**Dependencies:** U1

**Files:**
- `src/cli.ts`

**Approach:**
- In the interactive TUI command handler (`runInteractiveMode`): when `command.name === "/settings"` (or `/prefs`), build a `FurnacePreferences` snapshot from the current `input.config` fields (`sidebarEnabled`, `inputMode`, `notifications`) and call `terminal.showSettings(prefs, async (updated) => { Object.assign(input.config, updated); await saveGlobalPreferences(updated) })`.
- The `onSave` callback also updates `input.config` in-place so subsequent reads (e.g., model selection, context estimation) see the new values.
- In the headless (`runHeadlessMode`) command handler: when `command.name === "/settings"`, print `sidebar=${input.config.sidebarEnabled}\ninputMode=${input.config.inputMode}\nnotifications=${input.config.notifications}\n` to stdout and continue.

**Patterns to follow:** `/permissions` TUI handler calling `terminal.showPermissions`; `/status` headless handler printing key-value output.

**Test scenarios:**
- Interactive mode: `/settings` → `terminal.showSettings` called with correct current prefs snapshot
- Toggle in panel → `onSave` called → `input.config` fields updated → `saveGlobalPreferences` called
- Headless mode: `/settings` → prints `sidebar=true`, `inputMode=standard`, `notifications=false` (or current values) to stdout
- `/prefs` alias works identically to `/settings`

**Verification:** `input.config` reflects toggled values after close; preferences file updated; headless output is machine-readable key=value.

---

## Verification Contract

- `npm run typecheck` passes with zero errors.
- Typing `/settings` in the TUI opens a panel above the chat input without replacing it.
- Navigating with arrow keys selects rows; Enter cycles each value and immediately saves to `~/.furnace/preferences.json`.
- Sidebar toggle in panel matches `Ctrl+/` shortcut effect (both drive the same `sidebarEnabled` state).
- Esc closes the panel; chat input is active again.
- `echo "/settings" | furnace --headless` (or equivalent) prints key=value pairs and exits.

## Definition of Done

- All four units implemented and typechecking clean.
- `/settings` and `/prefs` registered in command definitions and appear in autocomplete.
- SettingsPanel shows sidebar, input mode, and notifications with correct current values.
- Each toggle persists immediately to `~/.furnace/preferences.json`.
- Headless `/settings` prints current values.
- No regression to model editor, permissions panel, or approval panel rendering.
