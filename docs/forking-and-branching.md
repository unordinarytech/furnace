# Forking And Branching

Furnace supports conversation forking as a first branch-aware session primitive. A fork creates a new conversation from the current session's active path or from a prior user prompt.

## Commands

### `/fork`

`/fork` opens a fork-point picker through slash autocomplete.

The first option is always:

```txt
current · <current title>
```

Selecting `current` forks through the current active leaf.

The remaining options are prior user prompts on the active path, newest first. Each row includes a short entry id, prompt preview, relative timestamp, and fork count when that prompt already has branches.

```txt
/fork current
/fork ent_abc123...
/fork abc123
```

When a user prompt is selected, Furnace forks **before** that prompt and restores the selected prompt into the input draft so it can be edited and resubmitted.

Example source path:

```txt
A user: add auth
B assistant: implemented middleware
C user: try sqlite session storage
D assistant: implemented sqlite
```

Selecting `C` creates a fork with copied context through `B`, then places `try sqlite session storage` back in the composer.

### `/clone`

`/clone` is shorthand for:

```txt
/fork current
```

It copies through the current active leaf and starts the fork at the same conversation point.

## History / Resume Presentation

`/history` and `/resume` are branch-aware.

Forked sessions appear in the recent list like normal conversations, with a label showing the parent conversation. They also appear under a branch grouping so lineage is visible.

```txt
Recent
1. main auth work (4 min ago)
2. Fork: SQLite schema (9 min ago)      fork of main auth work
3. TUI sidebar polish (1 hour ago)

Branches
main auth work
├─ Fork: SQLite schema (9 min ago)
└─ Fork: middleware rewrite (22 min ago)
```

This intentionally shows forks twice: once as normal resumable conversations, and once as branch children of their parent. The duplicate presentation is labeled so it is useful rather than ambiguous.

Subagent sessions are hidden from normal history by default. They still exist as session rows but use a separate `relationType`.

## Storage Model

Furnace keeps its Pi-style entry tree:

- `entries.parent_entry_id` links entries into a tree.
- `sessions.active_leaf_id` points at the current path tip.
- `getActivePath()` reconstructs root-to-leaf context.

Forking creates a new session row with explicit relationship metadata:

- `relationType: "fork"`
- `parentSessionId: <source session id>`
- `forkedFromEntryId: <selected source entry id>`
- `rootSessionId: <root conversation id>`

Subagents now use:

- `relationType: "subagent"`

This prevents manual forks, subagents, future delegation sessions, and other child session types from all overloading `parentSessionId` with no way to tell them apart.

## Fork Boundary Rules

- `/fork current` and `/clone` copy through the current active leaf.
- `/fork <prompt preview>` copies through the selected user prompt's parent.
- Fork selection shows prompt previews rather than internal entry ids.
- After a fork is created, the composer stays empty instead of restoring the forked prompt.
- Fork sessions show their parent conversation in the terminal status/header area.
- Forking only works once the source chat has a real conversation: at least one user prompt and one assistant response.
- The prompt picker only offers user prompts that have prior conversation context to preserve.
- Level-one forks are supported. Forking from an already forked session is intentionally blocked for now.
- Forking before a non-user message is rejected.
- Fork boundaries are based on the active path and parent pointers, not lexicographic id ordering.
- Fork creation runs in a SQLite transaction so a partial copy does not leave a broken fork.

## Harness Provenance

This design combines lessons from the reference harnesses inspected while building Furnace.

- **Pi** influenced the core architecture: append-only entry trees, active-leaf paths, and the distinction between same-session branching and new-session forking.
- **OpenCode** influenced the UX: choose a prior user prompt, fork before it, and put that prompt back in the composer for editing.
- **Hermes Agent** influenced presentation: fork children remain visible under their parent in branch-aware history, while non-user-facing child sessions stay hidden from normal history.

Furnace intentionally diverges from those harnesses in a few places:

- Unlike OpenCode's manual fork, Furnace stores durable fork lineage.
- Unlike Hermes, Furnace does not use a single ambiguous parent relation for every child type; `relationType` distinguishes forks from subagents.
- Unlike older Pi code paths, branch/fork behavior should remain durable across process restarts and should not depend on in-memory-only leaf movement.

## Current Scope

Implemented now:

- `/fork` picker/autocomplete.
- `/fork current`.
- `/clone`.
- Transactional new-session forks from the active path.
- User-prompt fork behavior with composer prefill.
- Branch-aware `/history` and `/resume` display.
- Explicit `relationType` session metadata.
- History hides `subagent` sessions while showing forks.

Not implemented yet:

- Same-session `/tree` branch navigation.
- Durable `leaf` entries for active-leaf movement.
- Branch summaries projected into model context.
- Branch merge/compare/checkpoint commands.
