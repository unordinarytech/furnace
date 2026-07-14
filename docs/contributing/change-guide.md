# Change Guide

> Use this map to find the owning module, preserve runtime invariants, and verify a Furnace change.

## Overview

Prefer small changes in the layer that owns the behavior. The session controller coordinates many systems, but new logic should usually live in a focused module and expose a narrow interface to the controller.

Node.js 22 is required. Use the repository scripts so native dependencies such as `better-sqlite3` use the pinned runtime.

## How It Works

Start with the user-visible behavior, trace it to the owning layer, then identify the persisted and model-facing effects:

1. Does it change CLI parsing, runtime orchestration, or only presentation?
2. Does it append or project session state?
3. Does it expose a tool or require permission?
4. Does it alter provider messages or context size?
5. Does it need parity across interactive and headless modes?
6. Which failure and resume paths need tests?

## Key Paths

| Area | Source | Primary tests |
| --- | --- | --- |
| Agent turns | `src/agent/loop.ts` | `test/agent-loop.test.mjs` |
| Providers | `src/providers/`, `src/openrouter.ts` | `test/providers*.test.mjs`, `test/providers/` |
| Tools | `src/tools/` | `test/tools.test.mjs` |
| Permissions | `src/permissions.ts` | `test/permissions.test.mjs` |
| Sessions | `src/session/` | `test/session-store.test.mjs`, `test/session-context.test.mjs`, `test/session/` |
| Compaction | `src/session/compaction.ts` | `test/compaction.test.mjs` |
| Compression | `src/compression/` | `test/compression.test.mjs` |
| Interactive UI | `src/ui/pi-terminal.ts`, `src/ui/pi/` | `test/ui/` |
| Commands | `src/commands/` | command behavior in smoke and UI tests |
| Skills | `src/skills/` | `test/skills.test.mjs` |
| Subagents | `src/tasks/` | task coverage in `test/tools.test.mjs` and UI bridge tests |
| Plans | `src/plan-mode.ts` | `test/plan-mode.test.mjs` |
| Evolve | `src/evolve/` | `test/evolve/` |
| Repository index | `src/repo-index/` | `test/repo-index/` |

## Invariants

- Session history is append-only.
- Stored data and model-facing projections are separate concerns.
- Tool calls always pass through permissions.
- Full compressed output remains retrievable.
- Secret-like files stay protected.
- Background work cannot mutate the wrong visible session.
- Interactive features do not become provider dependencies.
- User-visible behavior and documentation change together.

## Changing This Area

Use the smallest relevant checks while iterating:

```bash
npm run check-node
npm run typecheck
npm run build
./scripts/with-node22.sh node --test test/path/to/test.mjs
```

Before pushing:

```bash
npm run verify
npm run start -- --help
```

If `better-sqlite3` reports a `NODE_MODULE_VERSION` mismatch:

```bash
nvm use
./scripts/with-node22.sh npm rebuild better-sqlite3
```

Keep documentation current-behavior only. Use the shared format described in `DOCS.md`, update its table when adding or moving a guide, and put release history in `CHANGELOG.md`.
