# Ask Question And Prompt Queue Research

This report compares how Pi, OpenCode, and Hermes Agent handle model-initiated clarification prompts and user prompts submitted while an agent turn is already running. The goal is to decide the right Furnace shape before implementing an `ask_question` tool and queued prompts.

## Sources Inspected

| Harness | Local source | Commit inspected |
| --- | --- | --- |
| Pi | `/Users/nihal/code/test-repos/pi` | `a1da88aed4a1584f4ad4e58bba2e3391760785a7` |
| OpenCode | `/Users/nihal/code/test-repos/opencode` | `009f3799cd6d28cad5a3e1b3902a80f60f93122e` |
| Hermes Agent | `/Users/nihal/code/test-repos/hermes-agent` | `5a53e0f0f487d3d383e2a7b2eae8f260e9bf1090` |

## Short Version

OpenCode is the strongest reference for the core `question` tool: the model calls a tool, runtime creates a pending question request, UI resolves or rejects it, and the tool returns the answer to the model.

Pi is the strongest reference for the questionnaire UI shape and queue semantics: its example `questionnaire` tool supports multiple questions, tab/left/right navigation, options, custom text, and cancellation. Pi also distinguishes mid-run steering from follow-up queueing.

OpenCode's newer CLI has the strongest local queued-prompt manager: submitted prompts are queued, displayed in a truncated/searchable menu, can be edited by removing and restoring them into the composer, and can be removed before they run.

Hermes validates the product need from another angle: it has a `clarify` tool with MCQ plus "Other", timeouts, platform callbacks, prompt persistence, and configurable busy-input behavior (`interrupt`, `queue`, `steer`). It is less directly reusable for Furnace's terminal UI because much of it is split across gateway/platform adapters.

## Comparison Table

| Area | Pi | OpenCode | Hermes Agent | Furnace recommendation |
| --- | --- | --- | --- | --- |
| Model-facing clarification tool | Example extension `questionnaire`, not necessarily a built-in core tool. Schema accepts an array of questions with options and `allowOther`. | Built-in `question` tool for app/cli/desktop clients. Schema accepts `questions`, each with `question`, `header`, `options`, and optional `multiple`. | Built-in `clarify` tool. One question at a time, optional up-to-4 choices, UI auto-adds "Other". | Add built-in `ask_question` to Furnace's core tool registry. Use OpenCode's pending request pattern, but use a Pi-like multi-question schema. |
| Runtime primitive | Extension calls `ctx.ui.custom()` and blocks until the custom UI returns a result. | `Question.ask()` stores a pending request with a deferred, publishes `question.asked`, and resolves through `reply` or `reject`. | `clarify_tool()` delegates to a platform callback. Gateway stores pending clarify entries and blocks on an event with timeout. | Add `ToolQuestionPrompt` service to `ToolContext`, likely `askQuestions(request): Promise<AskQuestionReply>`. The tool should be normal tool execution, but it waits for terminal UI response. |
| User answer shape | Returns structured details: original questions, selected answers, whether custom, and cancelled status. | Tool metadata stores `answers: string[][]`; tool output summarizes `"question"="answer"`. Reject raises `QuestionRejectedError`. | Returns JSON with `question`, `choices_offered`, and `user_response`; timeout tells the agent to decide itself. | Return structured JSON/text: answer per question, `kind: "option" | "custom" | "refuse"`, and a concise model-facing summary. Treat refusal as a successful answer, not a tool failure. |
| Multiple questions | Yes, tab bar navigation and submit tab. | Yes, multiple questions plus confirm tab unless it is a single select. | No, schema is one question per tool call. | Support multiple questions in one tool call. Use left/right to switch question, Enter to select/toggle, and a review/submit state for multi-question flows. |
| Custom answer | Yes, "Type something" option opens a mini editor. | Yes, if `custom !== false`, "Type your own answer" uses a textarea. | Yes, UI appends "Other (type your answer)" or captures open-ended text. | Always include "Other / type answer" unless the tool explicitly disables it. Store custom text per question. |
| Refuse / dismiss | Pi example has cancellation. | `escape` rejects the whole question request. | Timeout or dismissal makes the agent decide or returns a message. | Add explicit "Refuse to answer" as a selectable answer per question. Also keep Esc as reject/cancel for the whole request if needed. |
| UI focus model | Custom UI owns input while active. | Question mode owns keybindings while visible; normal prompt is disabled while permissions/questions are pending. | Clarify modal owns the prompt toolkit focus, but it persists a summary to scrollback. | Do not fully disable prompt input. Keep the normal input bar active for queued prompts, and add a focus switch: when a question panel exists, Up from an empty input focuses the question panel; Esc returns focus to input. |
| Busy prompt submission | During streaming, Enter queues a steering message; Alt+Enter queues a follow-up. Without explicit behavior in SDK, `prompt()` throws while streaming. | Direct interactive queue serializes prompts. Prompts behind an active turn stay queued and visible until they begin. | `busy_input_mode` can be `interrupt`, `queue`, or `steer`; gateway has FIFO queue helpers with a cap. | Add a per-conversation prompt queue. When Furnace is busy, Enter should queue by default. Later we can add explicit "interrupt now" and "follow-up" modes. |
| Queue display | Pending messages show truncated "Steering:" and "Follow-up:" rows plus a restore hint. | Footer exposes queued prompts; queued user messages get a `QUEUED` badge. New CLI queue manager shows prompt text and footer hints. | Status output can show queue depth; gateway sends queued acknowledgements. | Show a compact `Queued` strip above the input: truncated first few prompts and count. Hints should show Up/manage when queue exists. |
| Queue edit/remove | Alt+Up restores all queued messages into the editor and clears the queues. | `<leader>q` opens queued prompt manager. It supports search, `ctrl+e` edit, `ctrl+d` remove. Edit removes the queued prompt and restores it into composer. | FIFO helpers support clear/reset; richer edit UI is not the main focus. | Implement queue manager in the fixed lower panel. Up can select queued prompts when no ask-question is focused. `e` edits selected queued prompt in the input. `d` removes. Enter can promote selected prompt to run next or interrupt, depending on UX choice. |
| Interrupt behavior | Escape aborts and restores queued messages to editor. Steering is delivered after current tool calls; follow-up after all work. | Session interrupt exists; direct queue drains one prompt at a time. The local manager does not make every queued prompt an immediate interrupt by default. | Default busy mode is interrupt, but it demotes to queue around subagents to avoid destroying work. | Be conservative: queued prompts should not interrupt by default. Provide an explicit action on selected queued prompt: Enter = run next by interrupting current turn only after confirmation or clear visual hint. |

## Suggested Furnace Design

### 1. Add `ask_question` As A Tool

Use a built-in tool rather than a slash command because the model needs to ask for clarification during a turn and then continue with the answer as a tool result.

Proposed schema:

```json
{
  "questions": [
    {
      "id": "scope",
      "prompt": "Which scope should I implement first?",
      "options": [
        { "id": "minimal", "label": "Minimal", "description": "Smallest useful version" },
        { "id": "complete", "label": "Complete", "description": "Full requested behavior" }
      ],
      "allowMultiple": false,
      "allowCustom": true
    }
  ]
}
```

Furnace should append implicit options in the UI:

- `Other`: lets the user type a custom answer for that question.
- `Refuse to answer`: records a refusal for that question and lets the agent proceed with that fact.

The tool result should be concise but structured enough for the model:

```json
{
  "answers": [
    {
      "questionId": "scope",
      "answer": "Minimal",
      "kind": "option",
      "optionId": "minimal"
    }
  ]
}
```

### 2. Reuse The Existing Permission-Prompt Shape

Furnace already has `terminal.requestApproval(request): Promise<PermissionDecision>`. Add a sibling terminal method:

```typescript
requestQuestions(request: AskQuestionRequest): Promise<AskQuestionResponse>
```

Then thread it through:

- `runAgentTurn()` accepts `onQuestionRequest`.
- `executeToolCall()` receives `questionPrompt` in `ToolContext`.
- `ask_question` calls that prompt service and waits.
- Non-interactive mode should return a clear unavailable result or use a text fallback later.

This mirrors OpenCode's pending request service without forcing Furnace to build an event server first.

### 3. Question Panel UX

The question panel should live above the input, similar to the approval prompt, but unlike approvals it should not disable the input bar.

Recommended controls:

| Key | When input focused | When question focused |
| --- | --- | --- |
| Enter | Submit current input. If busy, queue it. | Select/toggle current option, or submit on review tab. |
| Up | If input is empty and question exists, focus question. Otherwise normal input/history behavior later. | Previous option. |
| Down | No-op for now, or queue manager focus when queue strip exists. | Next option. |
| Left/Right | Move cursor in input. | Previous/next question. |
| Esc | Clear input. | Return focus to input, or reject only with a second Esc/explicit dismiss. |
| Type while question visible | Edits normal input and queues on Enter if busy. | Only types into custom-answer editor when "Other" is selected. |

This satisfies the requirement that the input bar remains usable while the question UI is present.

### 4. Prompt Queue UX

Furnace currently blocks submissions by setting `busy`. Change the interactive path so the prompt input stays enabled while a turn is running:

- If not busy: `onSubmit(prompt)` starts a turn as today.
- If busy: append `{ id, text, createdAt, mode: "queue" }` to an in-memory conversation queue and show it in the UI.
- After the active turn completes, drain the queue FIFO by starting the next prompt automatically.

Initial UI:

- Show `Queued: <truncated first prompt>` plus `+N more` above hints or above the input.
- Up from an empty input can focus the queued prompt strip when there is no question prompt, or cycle focus between question and queue if both exist.
- In queue focus: Up/Down selects queued prompts, `e` removes the selected prompt and loads it into the input for editing, `d` removes, Enter promotes it.

For "Enter promotes it", use a conservative first version:

- If no turn is running, Enter sends the selected queued prompt immediately.
- If a turn is running, Enter should mark it as `runNext` and interrupt only if we have an abort path wired. Furnace does not currently pass an `AbortSignal` into `runAgentTurn()`, so true interrupt should be a second implementation step.

### 5. Implementation Order

1. Add prompt queue state to `runInteractive()` and `FurnaceTerminal`.
2. Keep `PromptInput` enabled while busy, and make busy submissions queue instead of erroring.
3. Drain queued prompts after `runSingleTurn()` completes.
4. Add queue strip and queue selection/edit/remove UI tests.
5. Add `ask_question` types, tool schema, and terminal `requestQuestions()`.
6. Add question panel UI with focus switching and tests.
7. Wire `ask_question` through `ToolContext` and `runAgentTurn()`.
8. Update `docs/tools.md`, `docs/design-choices.md`, and `todo.txt` if any follow-up scope remains.

## Design Notes For Furnace

- Keep ask-question separate from permissions. Permissions are safety gates; ask-question is model-to-user clarification and should produce a normal tool result.
- Treat "Refuse to answer" as data, not failure. The model can continue with "user refused to answer scope".
- Do not block typing while a question is open. The queued-prompt feature is what makes this feel smooth.
- Do not implement true interruption until `runAgentTurn()` and provider calls accept an `AbortSignal`. Queue/promotion can exist first without pretending to cancel work.
- Record tool call/result entries as usual. If the user answered/refused, the session should replay that tool result like any other tool.
