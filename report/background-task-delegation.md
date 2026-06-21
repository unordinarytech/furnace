# Background Task Delegation And Subagents

This report compares how Pi, OpenCode, and Hermes Agent handle subagents, background work, and task delegation. The goal is to decide the right Furnace design before adding model-callable delegation.

## Sources Inspected

| Harness | Local source | Commit inspected |
| --- | --- | --- |
| Pi | `/Users/nihal/code/test-repos/pi` | `bc0db643502ba0bf1b227a97d9d5885cefc2b909` |
| OpenCode | `/Users/nihal/code/test-repos/opencode` | `ca006a2d206370365c10793a89da486d1a7497fc` |
| Hermes Agent | `/Users/nihal/code/test-repos/hermes-agent` | `5aec00f7a908b948a547c88675176dd5c02cc195` |

## Short Version

OpenCode is the strongest reference for Furnace's first implementation. Its `task` tool creates child sessions, can run foreground or background, returns structured task output, and has a process-local `BackgroundJob` registry with promotion, cancellation, wait, and extension semantics.

Hermes is the strongest reference for mature multi-agent operations. Its `delegate_task` isolates child agents, restricts tools, supports parallel batches, caps concurrency and spawn depth, mirrors subagent progress into the UI, and has a separate async delegation rail that re-enters the parent conversation later.

Pi does not appear to ship a first-class subagent scheduler in the coding agent. Its useful pieces are architectural: sessions are runtime objects that can be created, forked, switched, and driven through RPC; extensions can register tools/commands and send queued user messages. For Furnace, Pi argues for keeping delegation as a reusable runtime primitive rather than baking it only into the TUI.

## Comparison Table

| Area | Pi | OpenCode | Hermes Agent | Furnace recommendation |
| --- | --- | --- | --- | --- |
| Model-facing primitive | No obvious built-in subagent tool. Extensions can register tools and commands. | Built-in `task` tool with `description`, `prompt`, `subagent_type`, optional `task_id`, and experimental `background`. | Built-in `delegate_task` tool with single or batch tasks, context, toolsets, role, model, and background mode. | Add a built-in `task` tool first. Keep the schema close to OpenCode because it maps cleanly to Furnace sessions. |
| Child context | New/forked sessions are runtime primitives, but not packaged as subagents. | Child session is created with `parentID`, title, selected agent, inherited model unless overridden, and derived permissions. | Child gets a fresh conversation, own task id/session, restricted toolsets, focused prompt from goal/context. Parent sees only summary/result. | Child sessions should be real `sessions` rows with `parentSessionId` and a focused first user prompt. Do not copy the whole parent transcript by default. |
| Foreground behavior | Normal prompt/follow-up runtime; no nested child runner found. | Foreground task runs in a background job then parent waits. If promoted to background, it returns a running handle instead. | Synchronous `delegate_task` blocks parent until all children finish. Batch mode runs children in parallel. | Foreground task can still use the job runner internally, but the tool should await completion and return a compact child summary. |
| Background behavior | Process suspend and prompt queues exist, not subagent background work. | `background=true` starts an async job and returns immediately; completion is later injected into the parent as a synthetic prompt/tool result block. | Async delegation uses daemon worker threads and pushes completion events into a shared queue that the CLI/gateway drains when idle. `/background` starts a separate background session. | Use an in-process `TaskManager` for v1. Background completions should enqueue a synthetic follow-up turn or notification only after the parent turn is not mid tool-call. |
| Job lifecycle | Session runtime can abort, fork, switch, and queue messages. | `BackgroundJob` supports `list`, `get`, `start`, `extend`, `wait`, `waitForPromotion`, `promote`, and `cancel`. It is explicitly process-local and not durable. | Active subagents are tracked in module-level registries; async delegation keeps recent records, capacity checks, interrupts, and completion events. | Start process-local and explicit. Store final child sessions durably, but be honest that live background jobs do not survive process exit until a later durable worker exists. |
| Parallelism | No built-in subagent fan-out found. | Tool description tells the model to launch multiple agents concurrently in one assistant message; implementation can handle separate task tool calls. | Batch `delegate_task(tasks=[...])` runs children in a thread pool; default max concurrent children is 3. Async batch occupies one async slot. | Let one assistant response contain multiple `task` tool calls and execute them concurrently only for `task` calls. Keep normal tools sequential. Add an explicit concurrency cap. |
| Permissions | Tool availability is controlled by selected/allowed/excluded tools and extensions. | Parent/subagent permissions are merged; primary tools and disallowed recursive tools can be denied for children. | Children have restricted toolsets and hard-blocked tools like delegation, clarify, memory, send_message, execute_code. Dangerous approvals in worker threads auto-deny by default. | Children need their own permission policy. Default read/search/web allowed, write/edit/bash ask or deny unless the parent explicitly approves that child profile. |
| Nested delegation | Not found as a built-in concept. | Agents can be mode `subagent`; task permission can deny task recursion. | Flat by default; `role="orchestrator"` plus `max_spawn_depth` opt-in enables deeper trees. | Disable nested task calls by default. Add `role: "orchestrator"` and `maxSpawnDepth` later. |
| UI visibility | Extension widgets and session switching are flexible; no subagent tree found. | Task tool metadata includes child session id, model, parent id, background flag, and title. | Rich `subagent.*` events feed a tree UI with start/tool/thinking/complete, cost, tokens, files touched, and child watch windows. | V1 UI should show a compact task card: title and status only. Keep opaque child session ids internal unless the user explicitly opens child details later. |
| Message-order safety | Prompt/follow-up queues preserve session flow. | Background result injection is an effect that prompts the parent later, avoiding illegal tool-result interleaving. | Async completion queue re-enters as a new turn when idle, explicitly avoiding splicing between a tool result and assistant message. | Never insert background completion as a raw `tool` message into an already-finished parent turn. Re-enter through a synthetic user/internal message or visible notification. |

## What To Borrow

Borrow from OpenCode:

- A `task` tool name, child sessions, compact task results, and optional background execution. Furnace intentionally drops `subagent_type` for v1.
- Child sessions linked to parent sessions.
- A job registry with `start`, `wait`, `cancel`, `list`, and `promote`.
- Background mode instructions that tell the model not to poll, sleep, or duplicate delegated work.
- A clear limitation that the first background registry is process-local.

Borrow from Hermes:

- Fresh child context by default. The parent must pass the needed context explicitly.
- Tool restriction for children, especially no user interaction, no memory writes, and no recursive delegation by default.
- Concurrency caps for fan-out.
- Structured completion records: goal, supplied context, model, status, duration, summary, error.
- Completion re-entry through a queue, not mutation of past context.

Borrow from Pi:

- Keep the runtime independent from the TUI.
- Treat session creation/forking as core runtime capabilities that CLI, TUI, print, and future RPC can share.
- Keep extension and custom-tool compatibility in mind; future custom subagent profiles should be configuration, not hard-coded UI branches.

## Proposed Furnace Design

### 1. Add A Core Task Runtime

Add `src/tasks/manager.ts` as a small in-process service:

```ts
type TaskStatus = "running" | "completed" | "failed" | "cancelled"

type TaskRecord = {
  id: string
  parentSessionId: string
  childSessionId: string
  title: string
  subagentType: string
  background: boolean
  status: TaskStatus
  startedAt: number
  completedAt?: number
  summary?: string
  error?: string
}
```

The manager should own:

- `start(input): TaskRecord`
- `wait(taskId): Promise<TaskRecord>`
- `cancel(taskId): void`
- `list(parentSessionId): TaskRecord[]`
- `resume(taskId, prompt): Promise<TaskRecord>` later, after child sessions can be resumed cleanly

For v1, the manager can live in memory inside `runInteractive()` and print/piped mode can create one per process. The durable source of truth is still the child session and final task result. Live task status after a process restart can honestly show as `unknown` or `not running`.

### 2. Keep Subagents Prompt-Only Initially

Do not add `subagent_type` or named profiles in the first implementation. A child subagent is just a child Furnace runtime with:

- a fresh child session,
- the same model as the parent,
- the same runtime context shape as the parent, including date/time, current year, and workspace path,
- the same tools as the parent except `task`,
- a dedicated subagent system prompt,
- and the delegated prompt supplied by the parent.

Named profiles can come later if they solve a real problem, but the first version should avoid routing complexity.

### 3. Add A `task` Tool

Schema:

```json
{
  "tasks": [
    {
      "prompt": "Detailed autonomous child prompt",
      "description": "Optional short UI/session label"
    }
  ],
  "background": false
}
```

Model-facing guidance should include:

- Use direct tools for simple file reads/searches.
- Use `task` for independent multi-step work.
- Use the `tasks` array for independent batch fan-out.
- Do not duplicate delegated work.
- For background tasks, continue only with non-overlapping work or report that the task is running.

### 4. Child Session Execution

When `task` starts:

1. Create a child session with `parentSessionId = parentSessionId` and title based on `description` or the first line of the prompt.
2. Append a user message containing the delegated prompt plus a compact task envelope:
   - parent cwd
   - explicit instruction that the child has no hidden parent history
   - expected final response shape
3. Run `runAgentTurn()` for the child using `entriesToModelMessages()` for the child session.
4. Persist child tool calls/results normally in the child session.
5. Return a task result to the parent containing:
   - task id
   - status
   - final summary
   - files changed/read if available later

This keeps parent context small and makes child work inspectable in history.

### 5. Foreground And Background Modes

Foreground:

- The parent `task` tool waits for the child to finish.
- The returned tool result is a compact summary, not the full child transcript.
- Interrupting the parent should abort all foreground child tasks.

Background:

- The parent `task` tool starts the child and returns immediately with `status: "running"`.
- The UI shows the running task card.
- On completion, the manager emits a completion event.
- The interactive loop should process completion events only between turns or after the current model turn finishes.

Completion re-entry should be one of:

1. V1: enqueue a synthetic parent prompt after all children in the background group finish.
2. Later: add manual controls for applying/ignoring completed background results.

```text
Background task completed: <description>
Task id: <id>
Result:
<summary>
```

The selected first version is automatic grouped re-entry, routed by `parentSessionId` so completions do not land in the wrong chat.

### 6. Concurrency And Scheduling

Default caps:

- Max concurrent foreground child tasks per parent turn: `3`.
- Max concurrent background tasks per Furnace process: `3`.
- Nested `task` calls inside child agents: denied by default.

Normal tools should stay sequential for now because file edits and shell commands have ordering hazards. A special case can execute multiple `task` tool calls concurrently because their contract is independent work.

### 7. Permissions

Add permission metadata to the task context:

Child sessions inherit the parent conversation's permission policy and current grants. Unapproved write/edit/bash calls still prompt normally inside the child. `task` is removed from child tools until nested orchestration is implemented.

### 8. UI Surface

Add a task strip/panel above the input or in the tool activity area:

```text
Tasks
running  review session linking  task_abc  00:42
```

Useful commands:

- `/tasks`: show active and backgrounded tasks.
- `Ctrl+B` while the task panel is focused: promote the active foreground task group to background.

The tool-call rendering should show `task` as a first-class call, not a JSON blob:

```text
> task tasks: 2
ok task -> completed
```

## Implementation Plan

### Phase 1: Foreground Subagents

1. Add `TaskManager`.
2. Add prompt-only `task` and `task_status` tools.
3. Create child sessions linked by `parentSessionId`.
4. Run child turns through existing `runAgentTurn()` with child tools excluding `task`.
5. Return compact child summaries to parent in input order.
6. Add tests for child session creation, task tool result shape, and inherited permissions.

This phase delivers useful delegation without lifecycle complexity.

### Phase 2: Background Jobs

1. Add `/tasks` and task cards in the TUI.
2. Add `Ctrl+B` task-group background promotion.
3. Add grouped completion prompt re-entry for the original parent session.
4. Add cancellation and shutdown behavior later.

This phase gives real background work while avoiding surprise model turns.

### Phase 3: Completion Re-Entry

1. Add manual controls for opening child sessions.
2. Add optional ignore/apply controls for completed background results.
3. Add richer task status history.

This matches Hermes/OpenCode's power but keeps the default behavior predictable.

### Phase 4: Rich Multi-Agent UX

1. Live subagent progress events: `task.started`, `task.tool`, `task.delta`, `task.completed`.
2. Child session watch mode.
3. Files-read/files-written rollups.
4. Optional nested orchestration with `role: "orchestrator"` and `maxSpawnDepth`.
5. Durable background workers that can survive CLI exit/restart.

## Recommended First Cut

Implement prompt-only `task` with synchronous default execution, then user-driven background promotion.

Do not start with durable worker processes. Furnace's current architecture is a single local Node runtime with SQLite session storage and an Ink TUI. A process-local manager keeps the first version small, testable, and aligned with the current code. The reportable artifact of every subagent should be durable because it lives in a child session; only live execution status can be process-local initially.

The first model-facing tool should be:

```ts
task({
  tasks: Array<{ prompt: string; description?: string }>,
  background?: boolean
})
```

Default behavior:

- `background` defaults to `false`.
- Child agents get fresh context.
- Parent gets only the final child summary.
- Children cannot call `task`.
- Children inherit the parent permission policy and current conversation grants.
- Background groups re-enter the parent conversation once all children finish.

This gives Furnace the core value of subagents without prematurely building a distributed scheduler.
