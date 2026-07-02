---
title: "feat: CLI quality-of-life improvements"
date: 2026-06-27
type: feat
status: active
---

# feat: CLI quality-of-life improvements

## Summary

Three focused CLI improvements that close gaps users expect from any modern terminal agent: shell-style input history so sent messages can be recalled with Up/Down, a `/clear` command to wipe the visible display without losing the session, and a live filter on the history screen so long session lists are navigable.

---

## Problem Frame

The interactive loop is missing standard shell ergonomics. Users cannot recall what they typed, cannot reset a cluttered display, and must scroll through an unbounded history list to find an old session. These gaps make the CLI feel incomplete relative to everyday terminal tools.

---

## Requirements

- R1: Pressing Up in an empty input field cycles through messages the user sent in the current session, newest-first, matching standard shell history behavior.
- R2: Pressing Down while cycling moves forward through history; reaching the present restores the original draft.
- R3: `/clear` clears the visible transcript display without ending the session or losing any session data.
- R4: The `/history` screen accepts typed characters as a live filter, narrowing the session list by title substring.
- R5: All three features work correctly during and between agent turns without corrupting session state.

---

## Key Technical Decisions

**KTD1 — History state lives in `PromptInput`, sourced from transcript prop.**
Keeping history cycling local to `PromptInput` avoids adding UI store state for a purely ephemeral interaction. The parent (`FurnaceApp`) derives the list from `state.transcript` via `useMemo` and passes it as a prop. This matches the existing `autocompleteItems` / `value` / `onEmptyUp` prop pattern.

**KTD2 — `/clear` uses a `transcriptOffset` integer, not a derived reset flag.**
Storing the current transcript length at the time `/clear` was called lets `ChatScreen` slice from that offset. The next `setTranscript` call (from the next agent turn) resets offset to 0, so cleared display restores automatically when a new response arrives. No extra state machine or boolean needed.

**KTD3 — History filter lives fully in `HistoryScreen` local state.**
The filter is ephemeral, session-scoped, and has no need to survive screen transitions. Mirrors the pattern in `ModelScreen`, which already has a working filter + `useInput` combination.

---

## Assumptions

- Hidden user messages (sent with `hidden: true` in `cli.ts`) may appear in `state.transcript`; they should be excluded from input history since the user never typed them. Filter on messages that appear in the transcript with `role === "user"` and whose content is not blank.
- The history screen's `SelectList` resets its active index when items change (existing behavior), so the filter resetting selection on each keystroke is correct.

---

## Implementation Units

### U1. Sent message history in PromptInput

**Goal:** Up/Down in an empty prompt field cycles through messages sent in the current session.

**Requirements:** R1, R2, R5

**Dependencies:** none

**Files:**
- `src/ui/components/prompt-input.tsx`
- `src/ui/ink-terminal.tsx`
- `test/smoke.test.mjs`

**Approach:**
Add an optional `historyItems?: string[]` prop to `PromptInput` (newest-first array of sent message strings). Add `historyIndex` state (number, default -1 meaning "not cycling") and a `historySavedDraft` ref.

In `useInput`, before the existing `key.upArrow && value.length === 0` check:
- If `historyItems` is non-empty and `historyIndex === -1` and value is empty and Up is pressed: save current draft (empty string) to ref, set `historyIndex = 0`, set value to `historyItems[0]`. Return early.
- If `historyIndex >= 0` and Up is pressed: advance to `historyIndex + 1` if not at end, or call `onEmptyUp()` (fall-through to panel focus) if already at oldest. Return early.
- If `historyIndex >= 0` and Down is pressed: go to `historyIndex - 1`; if reaching -1, restore draft from ref and reset index. Return early.
- If `historyIndex >= 0` and Esc is pressed: restore draft, reset index. Return early (do not propagate the existing Esc-clears-input logic).
- If `historyIndex >= 0` and any printable character is typed: reset index to -1, then fall through to normal character insertion.
- On submit: reset `historyIndex = -1` after submission.

Add a `useEffect` on `historyItems` reference to reset `historyIndex` to -1 and clear the saved draft ref when the session changes.

In `FurnaceApp` (`ink-terminal.tsx`), derive sent messages:
```
const sentMessages = React.useMemo(
  () => state.transcript.filter(m => m.role === "user" && m.content.trim()).map(m => m.content).reverse(),
  [state.transcript],
)
```
Pass as `historyItems={sentMessages}` to `<PromptInput>`.

**Patterns to follow:** Existing `cursorOffset` / `setValue` / `useInput` pattern in `prompt-input.tsx`. The `autocompleteActive` early-return structure for how to intercept Up/Down before normal handling.

**Test scenarios:**
- Up in empty input with history → value becomes most recent sent message; index becomes 0.
- Up again → value becomes second-most-recent; index becomes 1.
- Up at oldest item → `onEmptyUp` called; index stays at oldest.
- Down from index 1 → value becomes most recent; index becomes 0.
- Down from index 0 → value restores to "" (saved draft); index becomes -1.
- Esc while cycling → value restores to ""; index becomes -1.
- Typing a character while cycling → character appended normally; index resets to -1.
- Submit while cycling → message sent with the history value; index resets.
- Up in non-empty input → no history activation; existing onEmptyUp behavior unchanged.
- Session change (historyItems changes reference) → index resets to -1.
- Empty transcript → Up falls through to `onEmptyUp` as before.

**Verification:** Up arrow in an empty prompt cycles through sent messages in order; Down arrow reverses; Esc cancels; normal typing cancels cycling; submitting a history item works normally.

---

### U2. `/clear` display command

**Goal:** Typing `/clear` wipes the visible chat transcript without ending or mutating the session.

**Requirements:** R3, R5

**Dependencies:** none

**Files:**
- `src/commands.ts`
- `src/ui/ink-terminal.tsx`
- `src/cli.ts`
- `test/smoke.test.mjs`

**Approach:**
Add `{ name: "/clear", description: "Clear the conversation display" }` to `slashCommandDefinitions` in `commands.ts`.

Add `transcriptOffset: number` (default 0) to `UiState` in `ink-terminal.tsx`. In `createFurnaceTerminal`, add a `clearTranscriptDisplay()` method that sets `transcriptOffset` to the current transcript length. In `setTranscript`, reset `transcriptOffset` to 0 so the next turn's streaming output starts from a clean slate.

In `FurnaceApp`, pass `state.transcript.slice(state.transcriptOffset)` to `ChatScreen` instead of the raw transcript. No other ChatScreen changes.

In `cli.ts` `handleInteractiveSubmit`, add handling for `/clear` before the running-guard check:
```
if (command.name === "/clear") {
  terminal.clearTranscriptDisplay()
  return
}
```

**Patterns to follow:** `showTransientStatus` / `clearTransientStatus` for ephemeral state mutations that don't persist to the session store. `FurnaceTerminal` interface extension pattern (add to interface + `createFurnaceTerminal` return object).

**Test scenarios:**
- `/clear` while idle → `transcriptOffset` equals current transcript length; ChatScreen receives empty slice.
- Next agent turn after `/clear` → `setTranscript` resets `transcriptOffset` to 0; full transcript visible again.
- `/clear` with empty transcript → no-op effectively (offset=0=length, display already empty).
- `/clear` registered as a known slash command → `isKnownSlashCommand("/clear")` returns true.
- `/clear` appears in slash autocomplete menu when typing `/cl`.
- Session switch after `/clear` → `setTranscript` resets offset, old session display is clean.

**Verification:** Typing `/clear` wipes visible messages; the next assistant response causes them to reappear from the new turn onward; session SQLite data is unaffected.

---

### U3. History screen live filter

**Goal:** Typing in the history screen filters sessions by title substring.

**Requirements:** R4

**Dependencies:** none

**Files:**
- `src/ui/ink-terminal.tsx` (`HistoryScreen` component only)
- `test/smoke.test.mjs`

**Approach:**
In `HistoryScreen`, add `const [filter, setFilter] = React.useState("")`. Add a `filteredChoices` memo that returns all choices when filter is empty, or choices whose `title.toLowerCase().includes(normalized)` when non-empty. Rebuild `items` from `filteredChoices`.

Add a `useInput` hook that appends printable characters to `filter` and handles Backspace to trim. Use the same guard pattern as `ModelScreen`: skip if `key.ctrl`, `key.meta`, or key.escape/arrow/return. Pass `selectedValue={filter ? null : screen.currentSessionId}` so the active-session highlight resets when filtering.

Add a filter display line below the heading: `Filter: {filter || "type to search"}`, matching `ModelScreen`'s style.

**Patterns to follow:** `ModelScreen`'s `filter`, `filteredChoices`, `useInput`, and `activeIndex` reset pattern in `ink-terminal.tsx`. `SelectList`'s `emptyLabel="No matches"` default handles zero results.

**Test scenarios:**
- No filter input → all sessions shown; current session highlighted.
- Type "pro" → only sessions with "pro" in title (case-insensitive) shown.
- Backspace → removes last character from filter; list updates.
- Filter reduces to zero matches → SelectList shows "No matches".
- Esc → exits history screen (filter discarded on unmount); existing cancel behavior unchanged.
- Filter is cleared when history screen is re-entered (local state resets on unmount/remount).
- Filter display shows "type to search" when empty, typed characters when non-empty.

**Verification:** Typing in the history screen narrows the session list in real time; Backspace removes characters; Esc exits; no sessions are deleted or mutated.

---

## Scope Boundaries

### In scope
- Sent message history cycling in `PromptInput` for the current session.
- `/clear` display reset (visual only, no session mutation).
- History screen substring filter.

### Deferred to Follow-Up Work
- Persistent history across sessions (localStorage / SQLite).
- Regex or fuzzy matching for the history filter.
- History deduplication (consecutive identical messages).
- `/clear` working during an active agent turn without triggering display reset from the next streaming `setTranscript`.
- OSC 8 hyperlinks for file paths in tool output.
- Context window usage percentage in the header.

### Out of scope
- Multi-line input (`react-ink-textarea` adoption).
- Session branching or history editing.

---

## Risks & Dependencies

- **`useInput` ordering in `HistoryScreen`**: Ink calls all `useInput` hooks registered in the component tree. Adding one inside `HistoryScreen` alongside the one inside `SelectList` is safe — Ink does not deduplicate or gate these.
- **Transcript hidden messages**: Messages with `hidden: true` stored via `appendMessage(..., { hidden: true })` must be checked against the transcript surface. If they appear in `state.transcript` with role `"user"`, they must be excluded from `sentMessages` (filter by checking `m.content.trim()` — hidden prompts are often non-empty, so a more robust check may be needed at implementation time if hidden messages leak through).
