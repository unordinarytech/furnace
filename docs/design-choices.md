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
- Pi-style questionnaire UX: Furnace's `ask_question` panel adapts Pi's multi-question tab navigation, option selection, custom answer, and cancellation/refusal direction.
- Pi-style skills: Furnace uses `SKILL.md` directories, explicit `/skill:<name>` invocation, and `disable-model-invocation` manual-only behavior.
- OpenCode: web search/fetch direction, MCP-style web provider calls, bounded tool-output previews saved under `.furnace/tool-output/`, the allow/ask/deny permission rule model, the pending question-request architecture, queued-prompt manager behavior, the idea that subagents are launched through a normal model-callable task tool linked to child sessions, and compact skill guidance plus a `skill` tool.
- Hermes Agent: durable tool-call/tool-result persistence, file read deduplication, stale-write warnings, session-scoped broad approval, clarify-tool semantics, busy-input modes, subagent batching/fan-out, background completion re-entry, hidden/scaffolded explicit skill invocation, guarded skill management, and the future direction for SQLite FTS session search.
- Headroom: content-type-aware tool-output compression, CCR-style local artifact handles, and request-local compression transforms for oversized tool results.
- Cursor and Claude Code: Furnace discovers their existing user, managed, and plugin-cache skill roots so installed skills can be reused locally.

## Headroom-lite Context Compression

Furnace adapts Headroom's core context-compression lesson without cloning its proxy or ML stack.

Reasoning:

Coding agents waste context on large tool outputs: test logs, search matches, diffs, JSON, and fetched pages. Plain head/tail truncation can drop the actual failure. Headroom's better pattern is to classify content, preserve important or anomalous lines, store the full original, and give the model a retrieval handle. Furnace implements that local-first in TypeScript as Headroom-lite.

Harness provenance:

- Headroom contributed the ContentRouter idea: detect content shape before choosing how to shrink it.
- Headroom contributed the CCR pattern: compress/cache/retrieve rather than permanently discard omitted content.
- Headroom contributed the request-transform direction: compress oversized tool results before provider requests while preserving the durable transcript.

Current behavior:

- Oversized tool outputs are stored under `.furnace/context-store/ctx_<sha>.txt`.
- The model receives a compressed summary with the artifact id and a `context_retrieve` call hint.
- `context_retrieve` returns full or ranged artifact content by id.
- The router handles JSON, logs/test output, search-style output, diffs, and generic text.
- A request-local transform compresses oversized historical tool messages before model calls.

Current implementation:

- `docs/headroom-lite.md` is the canonical design reference.
- `src/compression/artifacts.ts` stores and retrieves full originals.
- `src/compression/router.ts` detects content kind and renders compressed summaries.
- `src/compression/request-transform.ts` runs pre-model request compression.
- `src/tools/registry.ts` integrates oversized tool-output compression and registers `context_retrieve`.

## Runtime Context Injection

Every model turn receives a transient runtime-context system message with the current date/time, ISO timestamp, current year, and workspace path.

Reasoning:

Models can answer stale facts from memory unless they know what "latest", "current", "recent", "today", or "now" means for this run. Sending fresh runtime context with each message lets the agent form correct web searches and date-sensitive answers without storing volatile timestamps in the session transcript.

Current implementation:

- `src/session/context.ts` builds the runtime context in `buildRuntimeContext()`.
- `entriesToModelMessages()` injects the runtime-context system message after the base system prompt.
- `src/cli.ts` passes the current workspace when building per-turn model messages.

## Skills

Furnace treats skills as progressive-disclosure instruction packages.

Reasoning:

Many useful workflows are too specific for the base prompt but too important to rediscover every session. Skills let Furnace keep a compact name/description index in context, then load full instructions only when a task needs them. This keeps token use controlled while still making specialized behavior reusable.

Harness provenance:

- Pi contributed the Agent Skills-compatible shape: `SKILL.md` directories, slash invocation as `/skill:<name>`, and `disable-model-invocation` for manual-only skills.
- OpenCode contributed the split between compact skill guidance and a model-facing `skill` tool that loads full content with base-directory context and supporting-file samples.
- Hermes Agent contributed the hidden/scaffolded explicit invocation pattern and the idea that agent-created skills need a dedicated guarded management flow instead of casual file writes.
- Cursor and Claude Code contributed the practical discovery roots: Furnace reads their existing user, managed, and plugin-cache skill directories so installed skills are reusable.

Current behavior:

- Furnace discovers project, user, Cursor, Claude Code, plugin-cache, and configured extra skill roots.
- Automatic model guidance includes only skills that are not marked `disable-model-invocation: true`.
- `/skill:<name>` autocomplete includes every discovered skill, including manual-only skills.
- `/skills`, `/skills view <name>`, and `/skills reload` expose inspection and reload controls.
- The `skill` tool is read-only and allowed by default.
- The `skill_manage` tool can create or update `SKILL.md` files only in approved writable roots and asks before writing.
- Explicit skill invocation is hidden from the visible transcript but preserved for model replay.

Current implementation:

- `docs/skills.md` is the canonical skills design and behavior reference.
- `report/skills.md` is the inspected-source research snapshot.
- `src/skills/loader.ts` handles discovery, validation, provenance, and configured paths.
- `src/skills/context.ts` renders guidance, loaded skill output, and hidden invocation messages.
- `src/skills/manage.ts` constrains agent-created skill writes.
- `src/tools/registry.ts` registers `skill` and `skill_manage`.
- `src/cli.ts` wires slash commands, reload, and hidden invocation.

## Plan Mode

Furnace treats planning as a first-class session mode.

Reasoning:

Planning should not depend only on the model remembering to be careful. A real mode lets the runtime change permissions, UI labels, system guidance, and execution handoff behavior together. The durable plan artifact also gives users and future turns a concrete object to review before implementation starts.

Harness provenance:

- OpenCode contributed the spine: a mode visible in runtime state, discoverable mode switching, and permission-policy enforcement instead of prompt-only safety.
- Hermes Agent contributed the durable markdown plan artifact as the main planning output.
- Pi contributed the compact bridge from planning to execution through an explicit user choice.

Current behavior:

- Sessions can be in `agent` or `plan` mode.
- Mode changes are stored as `custom` session entries, so active mode is reconstructed from the session path.
- `Tab` and `Shift+Tab` cycle mode in the TUI.
- `/plan`, `/agent`, and `/mode [agent|plan]` expose the same controls through slash commands.
- Plan mode writes only to `.furnace/plans/YYYY-MM-DD_HHMMSS-<slug>.md`.
- Plan mode allows read/search/web/question/subagent exploration and denies side-effecting tools.
- After a plan turn, the TUI offers `Execute`, `Refine`, or `Stay in plan mode`.
- `Execute` switches back to agent mode and injects a hidden follow-up that points to the plan file.

Current implementation:

- `docs/plan.md` is the canonical plan-mode behavior reference.
- `report/plan-mode.md` is the inspected-source research snapshot.
- `src/plan-mode.ts` owns mode reconstruction, plan path generation, plan guidance, and execution handoff text.
- `src/permissions.ts` enforces the mode-aware safety clamp.
- `src/cli.ts` wires slash commands, mode entries, subagent inheritance, and the execute/refine/stay bridge.
- `src/ui/ink-terminal.tsx` and `src/ui/components/prompt-input.tsx` render mode labels, Tab cycling, and the post-plan action panel.

## Tool Call Persistence

Tool calls and results are persisted as first-class session entries instead of being only transient UI state.

Reasoning:

The UI can show tool activity during a turn, but resume/debug/search need durable facts: which tool ran, what arguments it received, what output it returned, and where that happened in the conversation. Hermes Agent does this well, so Furnace adopted the same principle while keeping the Pi-style entry tree.

Current implementation:

- `src/session/types.ts` defines `tool_call` and `tool_result` entry data.
- `src/session/store.ts` appends tool entries through `appendToolCall()` and `appendToolResult()`.
- `src/cli.ts` persists tool entries from `onToolStart` and `onToolResult`.
- `src/session/context.ts` replays tool entries back into OpenRouter-compatible model messages.

## Compaction

Furnace treats compaction as durable session context projection, not transcript deletion.

Reasoning:

Long coding sessions need to preserve continuity without sending every historical tool result back to the model forever. The safest local design is to keep the SQLite entry tree append-only, add a compaction marker, and change only the model-facing replay view. Clearing file-read state after compaction is part of that invariant: once file contents have been summarized, future reads should be allowed to return fresh content instead of being suppressed by stale dedupe receipts.

Harness provenance:

- Pi contributed the storage shape: a `compaction` entry with `summary` and `firstKeptEntryId`, while keeping full history durable.
- OpenCode contributed the trigger shape: check before model requests and retry once after context-overflow rejection.
- Hermes Agent contributed summary hardening: latest-user-message-wins wording, reference-only summaries, tool boundary protection, secret redaction, and deterministic fallback when summarization fails.
- Headroom contributed the later direction for live-zone/tool-output compression, but Furnace does not use it as the primary session compactor.

Current behavior:

- `/compact [focus]` manually compacts older session history.
- Before every model request, Furnace estimates the full request and compacts when it reaches `context window - reserve`.
- If OpenRouter rejects a request for context length, Furnace compacts and retries once.
- Normal contexts reserve `16K` tokens and keep about `20K` recent tokens.
- Contexts at `64K` or smaller reserve `8K` tokens and keep about `25%` of the context, with a `4K` minimum.
- Successful compaction clears persisted file-read receipts for the session.

Current implementation:

- `docs/compaction.md` is the canonical compaction behavior reference.
- `report/compaction.md` is the inspected-source research snapshot.
- `src/session/compaction.ts` owns token estimation, cut selection, summary prompting, fallback, and redaction.
- `src/session/context.ts` projects latest compaction summary plus the kept suffix into model messages.
- `src/session/store.ts` persists compaction entries and clears session file-read state.
- `src/agent/loop.ts` provides preflight and one-shot overflow hooks.
- `src/cli.ts` wires `/compact`, parent turns, and subagent turns.

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

## Ask Questions

Furnace exposes `ask_question` as a model-callable clarification tool.

Reasoning:

Clarifying questions are different from permission prompts. Permissions protect the user before side effects; `ask_question` is a normal agent capability for ambiguous requirements or meaningful tradeoffs. The model should be able to ask one or more structured questions, receive the answer as a tool result, and continue the same turn with that information.

Harness provenance:

- OpenCode influenced the runtime shape: the tool creates a pending question request, the UI resolves it, and the model receives the result as a tool response.
- Pi influenced the terminal interaction: multiple questions, left/right navigation, selectable options, custom answers, and a focused question panel.
- Hermes Agent influenced the user-answer semantics: an explicit "Other" custom answer path, refusal/dismissal handling, and the broader `interrupt | queue | steer` framing for busy input.

Current behavior:

- The tool accepts one or more questions with option arrays.
- The UI adds custom-answer and refusal paths.
- The input bar remains available while a question is open; pressing up from an empty input focuses the question panel.
- Refusal is returned as answer data, not as a tool failure.

Current implementation:

- `src/questions.ts` owns request normalization and result formatting.
- `src/tools/registry.ts` registers `ask_question`.
- `src/agent/loop.ts` passes the question prompt callback into tool execution.
- `src/ui/ink-terminal.tsx` renders the question panel and resolves the pending request.

## Queued Prompts

Interactive Furnace queues user prompts submitted while a turn is already running.

Reasoning:

The terminal should stay responsive during long agent turns. Users often think of the next instruction while tools are running; losing that text or forcing them to wait makes the TUI feel brittle. Queueing gives the user a visible backlog and lets Furnace drain prompts in order.

Harness provenance:

- Pi influenced the idea that mid-run input is first-class queue state rather than a blocked prompt box.
- OpenCode CLI influenced the visible queued-prompt manager with truncated rows plus edit/remove/promote actions.
- Hermes Agent influenced the future direction for busy input modes, especially distinguishing interrupt, queue, and steer semantics.

Current behavior:

- Submitting while Furnace is busy appends a conversation-local queued prompt.
- Queued prompts render in a compact panel.
- Queue focus supports up/down selection, `e` to edit by restoring the prompt into the input, `d` to remove, and Enter to promote/run next.
- Furnace attempts to interrupt the current model request when a queued prompt is promoted, but full hard interruption of already-running tools depends on future `AbortSignal` plumbing through every tool.

Current implementation:

- `src/cli.ts` owns the interactive queue and drains it FIFO.
- `src/ui/ink-terminal.tsx` renders the queue panel and input focus switching.
- `src/ui/components/prompt-input.tsx` supports controlled drafts so queued prompts can be restored for editing.

## Subagent Delegation

Furnace exposes subagent delegation through a normal `task` tool.

Reasoning:

Delegation should not be a hidden side channel. If the model creates child agents through a normal tool call, the parent transcript keeps valid tool ordering and replay remains understandable after resume. Child sessions use `parentSessionId` so background completions can return to the correct conversation even if the user switches chats.

Harness provenance:

- OpenCode influenced the core shape: a `task` tool creates child sessions and returns compact task results to the parent.
- Hermes Agent influenced the batch-first design, active task tracking, explicit background promotion, and grouped completion re-entry after all children for a parent session finish.
- Pi influenced the local adaptation: keep the runtime reusable outside the TUI, use session primitives rather than a gateway-specific scheduler, and keep UI panels as thin views over runtime state.

Local changes:

- Furnace does not expose `subagent_type` in the first version. Children are prompt-only and use one default subagent runtime.
- Children use the same model as the parent and the same tools except `task`, which prevents recursive subagent spawning.
- Permission grants are inherited from the parent conversation through an explicit child-to-parent session link, not copied globally.
- Background promotion is user-driven from the TUI (`Ctrl+B` in the task panel). The model can start background tasks, but the expected default is synchronous execution.

Current implementation:

- `src/tasks/manager.ts` owns process-local task groups, foreground/background state, and completion callbacks.
- `src/tasks/types.ts` defines task records and runner interfaces.
- `src/tools/registry.ts` registers `task` and `task_status`.
- `src/cli.ts` wires child session creation, inherited permissions, child `runAgentTurn()` execution, and background completion prompts.
- `src/ui/ink-terminal.tsx` renders the subagent panel and background-promotion hints.
- `src/prompts/subagent-system.md` is the child system prompt.
