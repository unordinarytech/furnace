# Design Choices

This file records small product and interface decisions that should stay stable unless we intentionally revisit them.

## History Relative Time Labels

`/history` should show human-friendly recency labels instead of raw session ids.

Rules:

- Show `just now` for sessions updated less than one minute ago.
- Show `N mins ago` for sessions updated less than one hour ago.
- Show `N hours ago` for sessions updated less than one day ago.
- If a session was updated on the previous calendar day, only show `yesterday` when it is also at least 15 hours old.
- If a session was updated on the previous calendar day but is less than 15 hours old, keep showing `N hours ago`.
- Show `N days ago` for older sessions.

Reasoning:

Near-midnight sessions can technically be "yesterday" while still feeling recent. Showing `2 hours ago` is more useful than `yesterday` in that case. The `yesterday` label should be reserved for sessions that feel meaningfully older.

Current implementation:

- Interactive history formatting lives in `src/ui/ink-terminal.tsx`.
- Piped `/history` formatting lives in `src/cli.ts`.

## Tool Registry Documentation

`docs/tools.md` is the canonical human-readable reference for the built-in tool structure, schemas, execution flow, and safety behavior.

Current implementation:

- Tool definitions and handlers live in `src/tools/registry.ts`.
- The tool-aware agent loop lives in `src/agent/loop.ts`.
- OpenRouter tool-call types live in `src/openrouter.ts`.

## Harness Influence Notes

When Furnace adopts an idea from another coding harness, document the source and the local adaptation.

Current influences:

- Pi: parent-linked session entries, `active_leaf_id`, future branching/forking semantics, and keeping the agent runtime independent of the terminal UI.
- Pi-style apply patch: Furnace exposes one model-facing `edit` tool but implements it as a structured apply-patch envelope.
- OpenCode: web search/fetch direction, MCP-style web provider calls, bounded tool-output previews saved under `.furnace/tool-output/`, and the allow/ask/deny permission rule model.
- Hermes Agent: durable tool-call/tool-result persistence, file read deduplication, stale-write warnings, session-scoped broad approval, and the future direction for SQLite FTS session search.

## Runtime Context Injection

Every model turn receives a transient runtime-context system message with the current date/time, ISO timestamp, current year, and workspace path.

Reasoning:

Models can answer stale facts from memory unless they know what "latest", "current", "recent", "today", or "now" means for this run. Sending fresh runtime context with each message lets the agent form correct web searches and date-sensitive answers without storing volatile timestamps in the session transcript.

Current implementation:

- `src/session/context.ts` builds the runtime context in `buildRuntimeContext()`.
- `entriesToModelMessages()` injects the runtime-context system message after the base system prompt.
- `src/cli.ts` passes the current workspace when building per-turn model messages.

## Tool Call Persistence

Tool calls and results are persisted as first-class session entries instead of being only transient UI state.

Reasoning:

The UI can show tool activity during a turn, but resume/debug/search need durable facts: which tool ran, what arguments it received, what output it returned, and where that happened in the conversation. Hermes Agent does this well, so Furnace adopted the same principle while keeping the Pi-style entry tree.

Current implementation:

- `src/session/types.ts` defines `tool_call` and `tool_result` entry data.
- `src/session/store.ts` appends tool entries through `appendToolCall()` and `appendToolResult()`.
- `src/cli.ts` persists tool entries from `onToolStart` and `onToolResult`.
- `src/session/context.ts` replays tool entries back into OpenRouter-compatible model messages.

## File Read Tracking

File reads are tracked by active session, workspace, absolute path, file size, mtime, and requested line range. In real sessions this state is persisted in SQLite so resume/restart keeps dedupe and stale-write behavior.

Reasoning:

Hermes Agent tracks file reads to reduce redundant unchanged output and warn before stale edits. Furnace implements the same safety signal in a lightweight in-memory tracker. This helps avoid read loops and flags cases where another process or user changed a file after the agent last saw it.

Current behavior:

- Re-reading the same unchanged path/range returns a short unchanged notice.
- Reading a different range still returns content.
- `write` and `edit` warn if a target previously read in the same session changed before the modification.
- Approval gates still run before the tool executes; stale warnings are advisory once the user has approved the requested modification.

Current implementation:

- Runtime checks live in `src/tools/registry.ts` alongside the file tool handlers.
- Persisted state lives in `file_read_files` and `file_read_ranges` tables in `.furnace/furnace.sqlite`.
- `src/cli.ts` and `src/agent/loop.ts` pass the active session id and `SessionStore` into tool execution. Direct tool calls without a session store fall back to workspace-scoped in-memory tracking for tests and simple harness usage.
- Regression coverage lives in `test/tools.test.mjs`.

## Tool Approvals

Furnace evaluates each model-requested tool call before execution through an allow/ask/deny permission layer.

Reasoning:

The approval design is intentionally a hybrid of the harnesses we inspected. OpenCode provides the general-purpose permission shape: policy evaluates to `allow`, `ask`, or `deny`, and the UI resolves asks with scoped choices. Hermes Agent contributes the distinction between one-off approval and broader session/conversation approval. Furnace combines those ideas but keeps denial scoped to the specific pending request, so rejecting one tool call does not reject every other pending or future request.

Current behavior:

- `allow`: execute the tool without prompting.
- `ask`: pause the turn and show an approval prompt.
- `deny`: block only that specific tool call and return a denied tool result to the model.
- The interactive prompt offers `Allow once`, `Allow <tool> for conversation`, `Allow all tools for conversation`, and `Deny`.
- Conversation-scoped grants are keyed by the Furnace session id. Switching to another conversation does not share those grants.
- `/reset-perms` clears grants for the current conversation only.
- `Allow all tools for conversation` applies only to the current conversation and is not persisted globally.

Current implementation:

- `src/permissions.ts` owns permission rules, default actions, and session-scoped approvals.
- `src/agent/loop.ts` checks permission before calling `executeToolCall()`.
- `src/ui/ink-terminal.tsx` renders the themed approval prompt and resolves the pending request.
- `src/cli.ts` keeps one `SessionPermissionStore` for the interactive run and routes `/reset-perms` to the active conversation id.
