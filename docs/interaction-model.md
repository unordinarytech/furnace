# Interaction Model

This document explains how Furnace handles user interaction while an agent turn is running: clarification questions, queued prompts, and tool permissions.

## Harness Provenance

Furnace intentionally combines a few proven patterns from other coding harnesses:

- OpenCode influenced the pending request architecture for `ask_question`: the model calls a tool, runtime creates a pending UI request, the user replies or rejects it, and the answer returns to the model as a normal tool result.
- Pi influenced the `ask_question` terminal UX: multiple questions, left/right navigation, option selection, custom answers, cancellation/refusal, and a compact focused panel.
- OpenCode CLI influenced queued prompt management: queued prompts are visible, selectable, editable, removable, and promotable.
- Hermes Agent influenced clarify semantics and busy-input framing: "Other" custom answers, explicit refusal/dismissal handling, and the future `interrupt | queue | steer` distinction.
- OpenCode and Hermes Agent both influenced permissions: OpenCode's `allow | ask | deny` policy shape plus Hermes-style conversation-scoped broad approval.

The design-specific credit trail is also recorded in `docs/design-choices.md`.

## `ask_question`

`ask_question` is a model-callable tool for ambiguity and user decisions. It is not a permission gate; it is a normal tool result that gives the model user-provided information before it continues.

Use it when:

- The prompt is vague enough that proceeding would be guesswork.
- There are meaningful tradeoffs or mutually exclusive choices.
- The user needs to choose scope, style, target, or a preference that cannot be safely inferred.

Avoid it when:

- A low-stakes sensible default is enough.
- The task is already clear.
- The question is really a safety approval for a side-effecting tool; permissions handle that.

Runtime flow:

1. The model calls `ask_question` with one or more questions.
2. Furnace shows a question panel above the input.
3. The input bar remains available, so the user can still type follow-up prompts while the question is open.
4. The user presses Up from an empty input to focus the question panel.
5. The user selects options, types a custom answer, or chooses `Refuse to answer`.
6. Furnace returns the answers as a tool result.
7. The model continues the turn with those answers.

Question panel controls:

```text
left/right question · up/down option · enter select · esc input
```

For multi-select questions, selected options are toggled with Enter. A `Continue` row appears and is disabled until at least one answer is selected. Selecting `Continue` advances to the next question or submits the answer.

Refusal is answer data, not a tool failure. The model sees that the user refused and should proceed accordingly.

## Queued Prompts

Queued prompts keep the TUI responsive while Furnace is already working.

Runtime flow:

1. If Furnace is idle, submitting the input starts a normal turn.
2. If Furnace is busy, submitting the input appends the prompt to the current conversation queue.
3. Queued prompts render in a compact panel.
4. Furnace drains queued prompts in FIFO order after the active turn finishes.
5. Draining stalls while a panel is focused or while the input has an edited draft, so queued prompts are not sent out from under the user.

Queue panel controls:

```text
up/down select · e edit · d remove · enter run next · esc input
```

Behavior:

- `e` removes the selected queued prompt and restores it into the input for editing.
- `d` removes the selected queued prompt.
- Enter promotes the selected queued prompt to run next and attempts to interrupt the current model request.
- If the queue disappears, focus automatically returns to the input so the UI cannot get stranded on a missing panel.

Current limitation:

Furnace passes an `AbortSignal` into the model request path, so promoting a queued prompt can interrupt a waiting model call. Some already-running tools may still finish until every tool supports cancellation.

## Tool Permissions

Permissions guard side-effecting or risky tools before execution. They are separate from `ask_question`.

Permission policy uses three actions:

- `allow`: execute without prompting.
- `ask`: pause and show a permission prompt.
- `deny`: block the current tool call.

Current defaults:

- Low-risk tools are allowed by default: `read`, `ls`, `find`, `glob`, `grep`, `ask_question`, `websearch`, and `webfetch`.
- Modifying or shell tools ask first: `write`, `edit`, and `bash`.
- Unknown tools default to `ask`.

Permission prompt choices:

- `Allow once`: approve only this call.
- `Allow <tool> for conversation`: approve future calls of that tool in the current conversation.
- `Allow all tools for conversation`: approve future tool calls in the current conversation.
- `Deny`: deny only this specific call.

Conversation scope:

- "Conversation" means the active Furnace session id.
- Grants do not carry to other conversations.
- Grants are held in memory for the interactive run.
- `/reset-perms` clears permission grants for the current conversation only.

Denied calls:

If the user denies a permission prompt, Furnace does not execute that tool. It returns a denied tool result to the model, and denial does not persist unless a future rule explicitly says so.
