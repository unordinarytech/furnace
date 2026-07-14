# Session Management

Furnace stores conversation state locally in SQLite at `.furnace/furnace.sqlite`. The data model uses a Pi-style active-leaf tree for long conversations, compaction, and forked sessions.

## Current Scope

Implemented:

- Local SQLite storage through `better-sqlite3`.
- One `sessions` row per conversation.
- One `entries` row per conversation item.
- Pi-style parent links between entries.
- `active_leaf_id` tracking per session.
- Root-to-active-leaf transcript reconstruction.
- Persisted tool-call and tool-result entries.
- Replay of persisted tool calls/results back into model context.
- Persisted per-session file read tracking for read dedupe and stale-write warnings.
- Fresh sessions by default.
- `--continue` for the latest non-empty session.
- `/new` for a fresh chat.
- `/history` for arrow-key selection of saved non-empty conversations.
- Resume by explicit session id.
- New-session forks from the current tip or an earlier user prompt.
- Compaction entries with `firstKeptEntryId` replay semantics.
- Cheap-model title generation after the first user prompt.
- Cleanup of empty placeholder sessions.

Not implemented yet:

- Same-session branching from an old entry.
- SQLite FTS session search.
- `session_search` tool for old-session recall.
- Session memory or durable preference ledgers.

## Data Model

The schema lives in `src/session/store.ts`.

### `sessions`

Each row represents a conversation-level container.

Important fields:

- `id`: stable session id, currently generated with the `ses_` prefix.
- `title`: user-visible conversation title.
- `cwd`: workspace directory the session belongs to.
- `active_leaf_id`: the current tail entry for this session.
- `parent_session_id`: parent conversation for forks and subagent sessions.
- `forked_from_entry_id`: parent entry where a fork begins.
- `created_at`, `updated_at`, `archived_at`: lifecycle metadata.

Empty sessions have `active_leaf_id = null`. They can exist while the user is sitting in a new blank chat, but they are hidden from `/history` and deleted on startup/shutdown.

### `entries`

Each row represents a message or future runtime event.

Important fields:

- `id`: stable entry id, currently generated with the `ent_` prefix.
- `session_id`: owning session.
- `parent_entry_id`: previous entry on this branch.
- `type`: entry category, such as `message`, `tool_call`, `tool_result`, `compaction`, `branch_summary`, `model_change`, or `custom`.
- `role`: message role, such as `user`, `assistant`, `system`, `tool`, or `null`.
- `created_at`: entry timestamp.
- `data`: JSON payload for the entry.

For normal chat text, entries are appended as `type = "message"` with `role = "user"` or `role = "assistant"`. Tool activity is persisted as separate `tool_call` and `tool_result` entries so resume/debug/search can inspect what actually happened during a turn.

### Tool Entry Payloads

Tool calls use `type = "tool_call"` and `role = "assistant"`.

Payload:

```ts
type ToolCallEntryData = {
  arguments: string
  content?: string | null
  name: string
  toolCallId: string
}
```

Tool results use `type = "tool_result"` and `role = "tool"`.

Payload:

```ts
type ToolResultEntryData = {
  content: string
  name: string
  toolCallId: string
}
```

This mirrors OpenRouter/OpenAI tool-call threading: an assistant message contains `tool_calls`, then a later `role: "tool"` message references the matching `tool_call_id`.

### File Read Tracking Tables

Furnace persists file read tracking per session so resume/restart does not forget what the agent already read.

`file_read_files` stores the latest read snapshot per file:

- `session_id`: owning session.
- `cwd`: workspace where the tool ran.
- `file_path`: absolute file path.
- `mtime_ms`, `size`: snapshot used for stale-write checks.
- `updated_at`: last time this snapshot was recorded.

`file_read_ranges` stores returned read ranges:

- `session_id`, `cwd`, `file_path`: same identity fields as `file_read_files`.
- `offset_key`, `limit_key`: the requested read range, with empty strings representing omitted values.
- `mtime_ms`, `size`: snapshot used to decide whether the returned range is unchanged.
- `display_path`: user/model-facing path label for unchanged-read notices.
- `updated_at`: last time this range was returned.

`read` upserts both tables. `write` and `edit` clear returned ranges for modified files and update or remove the latest file snapshot.

## Active Leaf Flow

Every new entry becomes a child of the session's current active leaf.

For a normal linear chat:

```text
A(user) -> B(assistant) -> C(user) -> D(assistant)
                                      ^
                                      active_leaf_id
```

When appending `E(user)`, Furnace sets:

```text
E.parent_entry_id = D.id
session.active_leaf_id = E.id
```

This makes the current implementation behave like a normal chat array while preserving the ability to branch later.

For a tool-using turn, the same active-leaf rule applies:

```text
A(user) -> B(tool_call) -> C(tool_result) -> D(assistant)
                                                ^
                                                active_leaf_id
```

The TUI still renders this as a normal conversation timeline, while the database keeps the real call/result sequence.

## Prompt Reconstruction

The model does not receive every row in the database. It receives only the active path for the selected session.

`SessionStore.getActivePath(sessionId)` does this:

1. Read the session.
2. Start from `active_leaf_id`.
3. Walk backward through `parent_entry_id`.
4. Reverse the collected entries.
5. Convert message and tool entries into model messages.

So the model context is:

```text
system prompt
runtime context
root-to-active-leaf user/assistant/tool-call/tool-result messages
```

The conversion code lives in `src/session/context.ts`.

Human-visible transcripts still filter to user/assistant chat text for history display. Model reconstruction keeps tool entries so resumed sessions remember previous tool behavior.

## Harness Provenance

The session shape combines ideas from multiple harnesses:

- Pi influenced the parent-linked entry tree and `active_leaf_id` model. Furnace keeps this because it gives us a clean path to same-session branching, forks, and compaction.
- Hermes Agent influenced persisting real tool calls/results instead of only final assistant text. Furnace adopted that because resume, search, and debugging are much stronger when tool names, arguments, and outputs are durable.
- Hermes Agent also influenced the future session-search direction: FTS over messages plus tool metadata, with a model-callable `session_search` tool.

## `/new`

`/new` switches to a fresh chat.

If the current session is still blank, Furnace reuses it instead of creating another empty row. If the current session already has entries, Furnace creates a new blank session.

This prevents `/new` or repeated launches from filling `/history` with empty `New Chat` rows.

## `/history`

`/history` lists only non-empty, non-archived sessions for the current `cwd`.

In interactive mode, the list is rendered with Pi TUI's `SelectList`, so the user can move with arrow keys and press Enter to switch sessions.

In piped mode, history is printed as numbered text for scripts.

## Future Session Search

Session search is a major future feature. The intended direction is:

- Add SQLite FTS tables over message content, tool names, and tool-call/tool-result payloads.
- Keep FTS rows updated when entries are appended.
- Add a `session_search` tool that can search old sessions and return surrounding context around a match.
- Let the interactive UI scroll around matches inside old conversations.

This is based on Hermes Agent's stronger old-session recall. Furnace has only `/history` browsing today.

## Titles

New sessions begin as `New Chat`.

After the first user prompt, Furnace tries to generate a short title using `OPENROUTER_TITLE_MODEL` and the prompt in `src/prompts/title-system.md`. If title generation fails, Furnace falls back to a local title derived from the first user message.

## Forking Semantics

`/fork current` copies the active path into a new fork session. Selecting an earlier user prompt forks immediately before that prompt, preserving the completed conversation that precedes it.

```text
Parent session:
A -> B -> C -> D
          ^
          forked_from_entry_id

Forked session:
A' -> B' -> C'
```

Fork creation copies only the selected root-to-boundary path. It does not pull unrelated siblings or future parent entries.

Same-session branching should not set `parent_session_id`. It should create another child under an older entry and move `active_leaf_id` to the selected branch.

## Compaction Semantics

Automatic, overflow-triggered, and manual compaction append a compaction entry:

```text
A -> B -> C -> D -> E(compaction) -> F(user)
```

The compaction entry should store a summary plus Pi-style metadata such as:

- `summary`
- `firstKeptEntryId`
- `tokensBefore`

`firstKeptEntryId` matters because the compacted prompt should include:

```text
summary of older context
raw entries from firstKeptEntryId onward
```

That preserves recent raw context while allowing older turns to be summarized. See `docs/compaction.md` for trigger, fallback, and replay details.

## Where To Look

- `src/session/types.ts`: TypeScript session and entry records.
- `src/session/store.ts`: SQLite schema and append/path logic.
- `src/session/context.ts`: transcript/model-message conversion.
- `src/session/title.ts`: title generation.
- `src/interactive-session-controller.ts`: `/new`, `/history`, forks, compaction, and session lifecycle wiring.
- `test/session-store.test.mjs`: current session-store regression tests.
- `test/session-context.test.mjs`: model-message reconstruction tests, including tool-call replay.
