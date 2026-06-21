# Delegation And Subagents

Furnace treats subagent creation as a normal model-callable tool. This keeps the parent transcript ordered:

```text
user -> assistant tool_call(task) -> tool_result(task) -> assistant
```

## Tool Shape

The parent agent delegates work with `task`:

```ts
task({
  tasks: [
    {
      prompt: "Inspect the session store and report risks in child session linking.",
      description: "Review session linking"
    }
  ],
  background: false
})
```

Only `prompt` is required. `description` is an optional short label for the UI, task status, and child session title. If omitted, Furnace derives a label from the first non-empty line of the prompt.

There is no subagent type in the first implementation. Every child uses the same default subagent runtime, the same model as the parent, the same runtime context shape, and the same tool set as the parent except `task` is removed so children cannot create their own subagents. `task_status` remains available so agents can inspect running/recent work.

## Child Sessions

Each delegated task creates a real child session:

- `parentSessionId` points at the parent conversation.
- The child has its own session id and active entry chain.
- The child receives a dedicated subagent system prompt from `src/prompts/subagent-system.md`.
- The child receives only the delegated prompt and runtime context, not the full hidden parent transcript.
- Runtime context includes the same current date/time, current year, and workspace path information that the parent receives.
- Child tool calls and tool results are persisted in the child session.

The parent receives a compact combined tool result with each child task's id, status, and final output. Child session ids stay internal so the terminal UI is not cluttered with opaque session labels.

## Batching

`task.tasks` is an array so the parent can delegate several independent subtasks in one ordered tool call. Furnace returns results in the same order as the input tasks.

The first implementation runs the child tasks as one managed group. This gives the UI a single group to promote to background and one grouped completion to send back to the parent later.

## Synchronous By Default

Task groups run synchronously by default. The parent waits until every child finishes, then continues with the combined tool result.

If the user interrupts the parent while the group is still foregrounded, Furnace aborts the child tasks. Once a group is moved to background, parent interruption no longer cancels those children.

## Background Promotion

The TUI shows active subagents in a focused task panel. Press up from an empty input to focus the panel when tasks are visible, then press `Ctrl+B` to move the active foreground task group to background. If the transcript can scroll upward, Up scrolls the chat before it focuses panels. Completed tasks are removed from the panel immediately; if the panel was focused on the last task, focus returns to the input.

Backgrounded groups render as `Subagents (backgrounded)` with task titles underneath. The background state is group-level, so Furnace does not repeat `backgrounded` on every row.

When promoted:

1. The running `task` tool returns a `backgrounded` result to the parent.
2. The parent agent can continue normal work.
3. The child tasks keep running under their original parent session id.
4. When every active/backgrounded child for that parent session finishes, Furnace queues one hidden synthetic parent prompt containing the grouped results.
5. If the user is currently in a different chat, the completion waits for the original parent chat instead of entering the wrong conversation.

The hidden completion message is persisted and replayed to the model, but `entriesToTranscript()` omits it so the terminal does not show a giant synthetic `user` block.

Background jobs are process-local in this version. The child sessions and completed outputs are durable in SQLite, but a live background task does not survive exiting the Furnace process.

## Permissions

Subagents inherit the parent conversation's permission policy and current conversation grants. The inheritance is explicit: a child session can evaluate grants from its parent session, but unrelated chats do not share grants.

Unapproved operations still prompt normally. If a subagent calls `edit`, `write`, or `bash` without an inherited grant, the same permission UI appears and the result goes back to the child agent.

## User-Facing Controls

- `/tasks`: show active and backgrounded tasks for the current conversation.
- `task_status`: model-callable status check for the current parent conversation.
- Task panel: shows subagent status and supports `Ctrl+B` background promotion.

## Current Limits

- No nested subagents: child agents do not receive the `task` tool.
- No named subagent profiles yet.
- No durable worker process yet; live background work is tied to the current Furnace process.
- Concurrent file edits by sibling subagents are not serialized beyond normal file stale-read warnings.
