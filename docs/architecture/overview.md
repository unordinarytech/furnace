# Architecture Overview

> Furnace is a local-first coding-agent runtime with multiple terminal surfaces over one session and tool engine.

## Overview

Furnace is organized as a set of narrow layers:

```text
CLI
 └─ session controller
     ├─ session store and context projection
     ├─ agent loop
     │   ├─ provider
     │   ├─ permission engine
     │   └─ tool registry
     ├─ tasks, skills, plans, and compaction
     └─ interactive or headless interface
```

The reusable runtime does not depend on the Ink TUI. Interactive, piped, and headless modes share configuration, persistence, model projection, tools, and permissions.

## How It Works

1. `src/cli.ts` parses arguments and loads configuration.
2. A workspace-local `SessionStore` opens `.furnace/furnace.sqlite`.
3. `src/interactive-session-controller.ts` selects interactive, headless, or piped execution.
4. Stored entries are projected into model messages by `src/session/context.ts`.
5. `src/agent/loop.ts` calls the selected provider, executes approved tools, and repeats until the model returns text.
6. Messages, tool calls, tool results, usage, modes, and compactions are appended to the session tree.
7. The active interface renders the resulting state.

## Key Paths

| Path | Responsibility |
| --- | --- |
| `src/cli.ts` | Process entrypoint and command-line arguments |
| `src/interactive-session-controller.ts` | Session-level orchestration |
| `src/agent/loop.ts` | Provider and tool-call loop |
| `src/providers/` | Provider definitions, credentials, model catalogs, and adapters |
| `src/tools/` | Tool schemas and handlers |
| `src/permissions.ts` | Tool authorization policy |
| `src/session/` | Persistence, projection, compaction, titles, and navigation |
| `src/ui/` | Interactive and plain terminal interfaces |
| `src/tasks/` | Delegated task lifecycle |
| `src/compression/` | Request-local tool-output compression |

## Invariants

- Keep provider-specific behavior out of terminal components.
- Keep tool execution behind the permission engine.
- Treat session entries as append-only history.
- Preserve assistant tool-call and tool-result pairings.
- Keep `.furnace/` as local workspace state.
- Keep runtime behavior usable without the interactive TUI.

## Changing This Area

- Put new behavior in the narrowest owning module instead of expanding `src/cli.ts`.
- Add a boundary type when data crosses runtime, storage, or UI layers.
- Test the reusable layer directly; add UI tests only for interface behavior.
- Run `npm run verify` before publishing or merging architectural changes.
