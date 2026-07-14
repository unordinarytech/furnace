# Tools and Permissions

> Tools expose typed runtime capabilities; permissions decide whether each call may execute.

## Overview

Every built-in tool has a provider-facing schema, a handler, and bounded output. The registry is the only dispatch point used by the agent loop.

Built-in groups are:

- Files and search: `read`, `ls`, `find`, `glob`, `grep`, `write`, `edit`
- Execution and interaction: `bash`, `ask_question`
- Planning: `todoread`, `todowrite`
- Extensions: `skill`, `skill_manage`, `task`, `task_status`
- Web: `websearch`, `webfetch`
- Retrieval: `context_retrieve`

## How It Works

1. The provider receives definitions from `toolDefinitions`.
2. A model tool call becomes a `PermissionRequest`.
3. `SessionPermissionStore` checks plan mode, session grants, explicit rules, then defaults.
4. Allowed calls dispatch through `executeToolCall()`.
5. The handler returns structured status, bounded content, and optional control signals.
6. The result is persisted and returned to the model as a tool message.

Read, search, question, todo, task, skill, and web tools are allowed by default. Write, edit, shell, and skill-management tools ask by default. Unknown tools also ask.

Plan mode allows safe read-oriented tools, limits writes and edits to the active plan artifact, and denies mutating shell commands.

## Key Paths

| Path | Responsibility |
| --- | --- |
| `src/tools/registry.ts` | Built-in schemas, registration, and dispatch |
| `src/tools/types.ts` | Tool contracts and execution results |
| `src/tools/file.ts` | Read, write, edit, and compressed-content retrieval |
| `src/tools/search.ts` | File and text search |
| `src/tools/bash.ts` | Bounded shell execution |
| `src/tools/tasks.ts` | Questions, todos, and task delegation |
| `src/tools/skills.ts` | Skill loading and management |
| `src/tools/web.ts` | Search and fetch integrations |
| `src/tools/common.ts` | Path, secret, schema, and output helpers |
| `src/tools/patch.ts` | Furnace patch parsing |
| `src/permissions.ts` | Defaults, grants, patterns, and plan-mode policy |

## Invariants

- No tool may bypass `SessionPermissionStore`.
- Secret-like `.env` files are denied except `.env.example`.
- Relative paths resolve from the workspace; external paths require explicit intent and approval.
- Write and edit must preserve stale-read warnings.
- Model-facing output must be bounded; omitted originals need retrieval artifacts.
- A denied or failed call must still produce a valid tool result.
- Plan-mode mutations stay confined to the active plan file.

## Changing This Area

- Add a tool by registering its schema and handler together.
- Choose the narrowest useful permission pattern.
- Test allowed, denied, malformed, external-path, and oversized-output cases.
- Update this document's tool groups when the public tool surface changes.
- Run `test/tools.test.mjs`, permission tests, and `npm run verify`.
