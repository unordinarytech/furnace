# Sessions

> Sessions preserve an append-only conversation tree and project only the active path into the model and terminal.

## Overview

Each workspace stores local state in `.furnace/furnace.sqlite`. A session points to an active leaf in a tree of entries. Messages, tool calls, tool results, compactions, mode changes, todos, and other runtime events are appended rather than rewritten.

Forks are separate sessions related to a parent session and a source entry. Subagent sessions use the same storage model but stay out of normal history.

## How It Works

1. `SessionStore.open()` creates or migrates the workspace database.
2. New entries reference the previous active leaf, then become the new leaf.
3. `getActivePath()` walks parent links to reconstruct the current branch.
4. `entriesToTranscript()` creates user-visible rows.
5. `entriesToModelMessages()` creates provider messages and inserts runtime context.
6. Forking creates a related session whose history ends at a valid source entry.
7. Compaction adds a summary entry that changes model projection without deleting old entries.

Image attachments and usage data live on message entries. File-read receipts and snapshots are stored separately so write and edit tools can warn when files changed after being read.

## Key Paths

| Path | Responsibility |
| --- | --- |
| `src/session/store.ts` | SQLite schema, migrations, entries, forks, todos, and file-read state |
| `src/session/types.ts` | Persisted session and entry shapes |
| `src/session/context.ts` | Transcript and model-message projection |
| `src/session/navigation.ts` | Valid fork-point resolution |
| `src/session/compaction.ts` | Summary entries and active-context reduction |
| `src/session/title.ts` | Session title generation |
| `src/session/usage-cost.ts` | Usage aggregation |
| `src/interactive-session-controller.ts` | Interactive session switching and resume flow |

## Invariants

- Never rewrite earlier entries to implement undo, fork, mode, or compaction behavior.
- The active leaf defines the active conversation branch.
- Tool calls and their results must remain paired in model projection.
- Hidden runtime messages may affect the model but must not leak into the visible transcript.
- Empty placeholder sessions must not appear in normal history.
- Subagent sessions remain hidden unless a feature explicitly surfaces them.
- Compaction must preserve the full stored history.

## Changing This Area

- Add schema changes through idempotent migrations in `SessionStore`.
- Update both transcript and model projections when introducing an entry type.
- Test reopen behavior; persistence bugs often appear only after process restart.
- Cover forks and active-leaf movement in session-store and session-context tests.
- Preserve file-read state semantics when changing file tools or compaction.
