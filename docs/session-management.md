# Session Management

Furnace currently stores conversation state locally in SQLite at `.furnace/furnace.sqlite`. The implementation is intentionally small, but the data model is already shaped around the Pi-style session tree we chose for long conversations, future compaction, and forks.

## Current Scope

Implemented:

- Local SQLite storage through `better-sqlite3`.
- One `sessions` row per conversation.
- One `entries` row per conversation item.
- Pi-style parent links between entries.
- `active_leaf_id` tracking per session.
- Root-to-active-leaf transcript reconstruction.
- Fresh sessions by default.
- `--continue` for the latest non-empty session.
- `/new` for a fresh chat.
- `/history` for arrow-key selection of saved non-empty conversations.
- Cheap-model title generation after the first user prompt.
- Cleanup of empty placeholder sessions.

Not implemented yet:

- Resume by explicit session id.
- Same-session branching from an old entry.
- Forking into a new session from an old entry.
- Compaction entries.
- `firstKeptEntryId` handling.
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
- `parent_session_id`: reserved for future forked sessions.
- `forked_from_entry_id`: reserved for the parent entry where a future fork begins.
- `created_at`, `updated_at`, `archived_at`: lifecycle metadata.

Empty sessions have `active_leaf_id = null`. They can exist while the user is sitting in a new blank chat, but they are hidden from `/history` and deleted on startup/shutdown.

### `entries`

Each row represents a message or future runtime event.

Important fields:

- `id`: stable entry id, currently generated with the `ent_` prefix.
- `session_id`: owning session.
- `parent_entry_id`: previous entry on this branch.
- `type`: entry category, such as `message`, `compaction`, `branch_summary`, `model_change`, or `custom`.
- `role`: message role, such as `user`, `assistant`, `system`, `tool`, or `null`.
- `created_at`: entry timestamp.
- `data`: JSON payload for the entry.

For normal chat today, entries are appended as `type = "message"` with `role = "user"` or `role = "assistant"`.

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

## Prompt Reconstruction

The model does not receive every row in the database. It receives only the active path for the selected session.

`SessionStore.getActivePath(sessionId)` does this:

1. Read the session.
2. Start from `active_leaf_id`.
3. Walk backward through `parent_entry_id`.
4. Reverse the collected entries.
5. Convert message entries into transcript/model messages.

So the model context is:

```text
system prompt
root-to-active-leaf user/assistant messages
```

The conversion code lives in `src/session/context.ts`.

## `/new`

`/new` switches to a fresh chat.

If the current session is still blank, Furnace reuses it instead of creating another empty row. If the current session already has entries, Furnace creates a new blank session.

This prevents `/new` or repeated launches from filling `/history` with empty `New Chat` rows.

## `/history`

`/history` lists only non-empty, non-archived sessions for the current `cwd`.

In interactive mode, the list is rendered with Pi TUI's `SelectList`, so the user can move with arrow keys and press Enter to switch sessions.

In piped mode, history is printed as numbered text for scripts.

## Titles

New sessions begin as `New Chat`.

After the first user prompt, Furnace tries to generate a short title using `OPENROUTER_TITLE_MODEL` and the prompt in `src/prompts/title-system.md`. If title generation fails, Furnace falls back to a local title derived from the first user message.

## Future Forking Semantics

The fields `parent_session_id` and `forked_from_entry_id` are reserved for future new-session forks.

Expected behavior:

```text
Parent session:
A -> B -> C -> D
          ^
          forked_from_entry_id

Forked session:
A' -> B' -> C'
```

The fork should copy or replay only the root-to-`forked_from_entry_id` path from the parent. It should not pull unrelated siblings or future entries from the parent session.

Same-session branching should not set `parent_session_id`. It should create another child under an older entry and move `active_leaf_id` to the selected branch.

## Future Compaction Semantics

Compaction is not implemented yet, but the intended model is:

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

That preserves recent raw context while allowing older turns to be summarized.

## Where To Look

- `src/session/types.ts`: TypeScript session and entry records.
- `src/session/store.ts`: SQLite schema and append/path logic.
- `src/session/context.ts`: transcript/model-message conversion.
- `src/session/title.ts`: title generation.
- `src/cli.ts`: `/new`, `/history`, `--continue`, and session lifecycle wiring.
- `test/session-store.test.mjs`: current session-store regression tests.
