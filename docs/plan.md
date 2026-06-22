# Plan Mode

Plan mode is Furnace's read-only planning workflow. It is a first-class session mode, not just a phrase in the prompt.

## User Experience

Interactive controls:

- Press `Tab` or `Shift+Tab` from the prompt to cycle between `agent` and `plan`.
- Use `/plan [prompt]` to enter plan mode. If a prompt is provided, Furnace immediately plans that request.
- Use `/agent` to return to normal implementation mode.
- Use `/mode`, `/mode plan`, or `/mode agent` to inspect or switch modes.

When plan mode is active, the header shows `plan` and the active plan artifact path. The prompt prefix changes to `plan>` so the current mode is visible while typing.

## Durable Plan Artifact

Entering plan mode creates a target artifact path:

```text
.furnace/plans/YYYY-MM-DD_HHMMSS-<slug>.md
```

The model is instructed to save the final plan there. The plan file is the handoff between planning and execution; the assistant's chat response should only summarize the saved path and any blockers.

Good plans should include:

- The proposed approach and important tradeoffs.
- Exact files likely to change.
- Bite-sized implementation steps.
- Commands and tests to run.
- Risks, open questions, and rollback notes when relevant.

## Safety Policy

Plan mode is enforced by the permission layer. It is not voluntary prompt discipline.

Allowed by default in plan mode:

- `read`, `ls`, `find`, `glob`, and `grep`.
- `ask_question`.
- `skill`.
- `task` and `task_status`; child subagents inherit the parent plan mode.
- `websearch` and `webfetch`.
- Read-only `bash` commands such as `git status`, `git diff`, `ls`, `rg`, and `sed -n`.

Denied in plan mode:

- Writes or edits outside the active `.furnace/plans/...` artifact.
- Mutating `bash` commands, including package installs, git mutations, redirects, and destructive filesystem commands.
- `skill_manage`.
- Unknown or side-effecting tools.

Conversation-scoped permission grants cannot bypass plan-mode denies. Even `Allow all tools for conversation` is clamped by the active mode.

## Execute Bridge

After a plan-mode turn completes, Furnace shows a compact choice panel:

```text
Execute · Refine · Stay in plan mode
```

Behavior:

- `Execute` switches to agent mode and injects a hidden follow-up that tells the agent to read the plan file and implement it.
- `Refine` keeps plan mode and pre-fills the input with a refinement prompt for the plan artifact.
- `Stay in plan mode` dismisses the panel and leaves mode unchanged.

## Harness Provenance

Furnace combines the strongest pieces from the researched harnesses:

- OpenCode: first-class mode state, mode-visible UX, and permission-policy enforcement.
- Hermes Agent: a durable markdown plan artifact as the primary handoff.
- Pi: a compact post-plan choice that bridges planning into execution.

Progress tracking from plan files, such as todo extraction and `[DONE:n]` markers, is intentionally deferred until a later phase.
