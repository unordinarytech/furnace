# Interaction Model

This document explains how Furnace handles user interaction while an agent turn is running: clarification questions, queued prompts, lofi mode, and tool permissions.

## Harness Provenance

Furnace intentionally combines a few proven patterns from other coding harnesses:

- OpenCode influenced the pending request architecture for `ask_question`: the model calls a tool, runtime creates a pending UI request, the user replies or rejects it, and the answer returns to the model as a normal tool result.
- Pi influenced the `ask_question` terminal UX: multiple questions, left/right navigation, option selection, custom answers, cancellation/refusal, and a compact focused panel.
- OpenCode CLI influenced queued prompt management: queued prompts are visible, selectable, editable, removable, and promotable.
- OpenCode influenced plan mode as runtime state with keyboard/slash switching and policy enforcement; Hermes Agent influenced the durable markdown plan artifact; Pi influenced the execute/refine/stay bridge.
- Hermes Agent influenced clarify semantics, busy-input framing, and subagent batching/background completion: "Other" custom answers, explicit refusal/dismissal handling, the future `interrupt | queue | steer` distinction, and grouped task completion re-entry.
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

Question options should be concrete choices only. The model should not include meta-options such as `Let me specify`, `Type my own`, `Other`, `Skip`, or `Refuse`, because Furnace already renders custom input and refusal controls separately. If free-form input is acceptable, the tool should set `allowCustom: true`.

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

When multiple lower panels are visible, focus moves layer by layer. Up from the input focuses the closest panel first, so queued prompts are focused before the subagent task panel. If the transcript can still scroll upward, Up keeps scrolling the chat instead of focusing a panel. Arrowing past the top or bottom of a focused panel moves to the adjacent panel instead of jumping over it.

Behavior:

- `e` removes the selected queued prompt and restores it into the input for editing.
- `d` removes the selected queued prompt.
- Enter promotes the selected queued prompt to run next and attempts to interrupt the current model request.
- If the queue disappears, focus automatically returns to the input so the UI cannot get stranded on a missing panel.

Current limitation:

Furnace passes an `AbortSignal` into the model request path, so promoting a queued prompt can interrupt a waiting model call. Some already-running tools may still finish until every tool supports cancellation.

## Slash Command Autocomplete

Typing an incomplete slash command in the input opens a command autocomplete panel above the prompt.

Behavior:

- `/` shows the available built-in commands.
- `/skill:` shows explicit skill commands for every discovered local skill, including manual-only skills.
- Typing a prefix filters the list, for example `/mo` shows `/model`.
- Up/down selects a command in the autocomplete panel.
- Tab or Enter completes the selected command into the input.
- Exact commands are submitted normally, so `/theme` followed by Enter still opens the theme picker instead of getting trapped in autocomplete.
- Commands that commonly take an argument can insert a trailing space, for example `/theme `.
- Slash commands submitted while Furnace is busy are handled as commands, not queued as model prompts. Safe commands like `/tasks`, `/reset-perms`, and `/theme <name>` run immediately; commands that would disrupt the active turn show a short status and can be retried after the turn finishes.

## Split Mode Beta

`/split` is a beta interactive TUI feature for showing two conversations side by side.

Runtime behavior:

1. `/split` opens a new empty chat in the right pane and focuses it.
2. `/split left` and `/split right` focus a pane; `Ctrl+K` toggles focus between panes.
3. `Ctrl+Shift+Left` and `Ctrl+Shift+Right` focus the left or right pane directly.
4. Mouse wheel over the chat scrolls the focused pane; each pane keeps its own scroll position when focus switches.
5. `Esc` returns the focused pane to live content.
6. `/split close` closes the inactive pane and keeps the active pane as the single visible chat.
7. Split mode only opens or changes focus while both pane sessions are idle. If an agent turn is running, Furnace shows a retry-after-work status instead of changing split state.
8. `/resume` and pinned chat selection replace the active pane when split mode is open.
9. The same chat cannot be open in both panes. If `/resume` or pinned selection targets the other pane's chat, Furnace reports that the chat is occupied instead of duplicating it.

Because split mode is beta, keep changes conservative and preserve normal single-pane session switching semantics outside split mode.

## Chat Scroll

The chat region uses the mouse wheel for in-view scrolling. Wheel up scrolls back into history; wheel down scrolls toward live content. In split mode, the cursor's horizontal position determines which pane scrolls: the left half of the chat scrolls the left pane, and the right half scrolls the right pane.

Mouse support is enabled by default when stdin is a TTY. To disable it, run `/mouse off` or start Furnace with `FURNACE_MOUSE=0`. The `/mouse` command also accepts `on` and `toggle`. `PageUp` and `PageDown` are not used for chat scroll.

## Plan Mode

Plan mode is a first-class session mode for research and implementation planning.

Controls:

- Press `Tab` or `Shift+Tab` from the prompt to cycle between `agent` and `plan`.
- `/plan [prompt]` switches to plan mode. With a prompt, Furnace immediately plans that request.
- `/agent` switches back to normal implementation mode.
- `/mode`, `/mode plan`, and `/mode agent` inspect or switch the current mode.

Runtime behavior:

1. Entering plan mode creates a target artifact path under `.furnace/plans/YYYY-MM-DD_HHMMSS-<slug>.md`.
2. The model gets plan-specific guidance that asks for exact files, commands, tests, risks, and bite-sized implementation steps.
3. The permission layer allows exploration and denies side effects outside the active plan file.
4. After a plan-mode turn finishes, Furnace shows `Execute`, `Refine`, and `Stay in plan mode`.
5. `Execute` switches to agent mode and injects a hidden follow-up telling the agent to read and implement the plan file.

See `docs/plan.md` for the full behavior and safety policy.

## Skills

Furnace discovers local skills from `SKILL.md` files under project roots like `.furnace/skills` and `.agents/skills`, user roots like `~/.furnace/skills` and `~/.agents/skills`, Cursor roots like `~/.cursor/skills-cursor`, `~/.cursor/skills`, and `~/.cursor/plugins/cache`, and Claude Code roots like `~/.claude/skills` and `~/.claude/plugins/cache`.

Runtime behavior:

1. Each model turn receives compact guidance listing skills that are available for automatic model invocation.
2. The model can call the `skill` tool to load the full content for a matching skill.
3. Skills with `disable-model-invocation: true` are excluded from automatic guidance.
4. Explicit `/skill:<name>` slash commands still appear for every discovered skill.
5. Extra roots can be configured in `.furnace/preferences.json` with `skillPaths: ["path/to/skills", "~/shared-skills"]`.

Explicit slash invocation:

- `/skill:name` loads that skill as a hidden user message and asks the model to proceed.
- `/skill:name extra args` appends `User instruction: extra args` to the hidden message.
- The hidden invocation is persisted for model context but omitted from the visible transcript.
- If Furnace is busy, `/skill:name` is treated as a command and shows a transient retry message instead of becoming a queued prompt.

Inspection and reload:

- `/skills` or `/skills list` shows every discovered skill with provenance and whether it is auto-guided or manual-only.
- `/skills view <name>` shows the description, provenance, file path, and full loaded `SKILL.md` content.
- `/skills reload` refreshes discovery and slash autocomplete after files are added or changed.

Agent-created skills:

- The model can call `skill_manage` to create or update a `SKILL.md`.
- This tool requires explicit approval and renders a diff-style preview before writing.
- Writes are restricted to approved writable roots: project `.furnace/skills`, `~/.furnace/skills`, `~/.cursor/skills`, and `~/.claude/skills`.
- Managed roots such as `~/.cursor/skills-cursor` and plugin caches are discoverable but not writable.
- New skills default to `disable-model-invocation: true`; after approval, run `/skills reload` to refresh autocomplete/model guidance.

## Subagent Tasks

Subagent tasks are model-callable through `task` and visible in the TUI as a task panel.

Runtime flow:

1. The parent model calls `task` with one or more delegated prompts in `tasks`.
2. Furnace creates one child session per task and links each child to the parent session id.
3. Each child runs with the same model and runtime context shape as the parent, including date/time, current year, and workspace path.
4. Each child gets the same tools except `task`.
5. Foreground tasks block the parent until every child finishes.
6. The parent receives one combined tool result in the same order as the input tasks.

Task panel controls:

```text
up/down select · ctrl+b background · esc input
```

Background behavior:

- Press Up from an empty input to focus the task panel when tasks are visible.
- Press `b` to move the active foreground task group to background.
- Completed tasks disappear from the task panel. If the focused task panel becomes empty, focus returns to the input.
- Backgrounded groups show as `Subagents (backgrounded)` with their task titles underneath, instead of repeating `backgrounded` on every row.
- Once backgrounded, the parent model can continue.
- When every active/backgrounded child for the parent session finishes, Furnace queues one grouped completion prompt for the original parent session.
- That grouped completion prompt is a hidden session message: the parent model sees it, but the TUI transcript does not render it as a visible `user` message.
- If the user switched chats, the completion waits for the original parent session instead of entering the current chat.

## Tool Permissions

Permissions guard side-effecting or risky tools before execution. They are separate from `ask_question`.

Permission policy uses three actions:

- `allow`: execute without prompting.
- `ask`: pause and show a permission prompt.
- `deny`: block the current tool call.

Current defaults:

- Low-risk tools are allowed by default: `read`, `ls`, `find`, `glob`, `grep`, `ask_question`, `skill`, `task`, `task_status`, `websearch`, and `webfetch`.
- Modifying, shell, or persistent-skill authoring tools ask first: `write`, `edit`, `bash`, and `skill_manage`.
- Unknown tools default to `ask`.

Permission prompt choices:

- `Allow once`: approve only this call.
- `Allow <tool> for conversation`: approve future calls of that tool in the current conversation.
- `Allow all tools for conversation`: approve future tool calls in the current conversation.
- `Deny`: deny only this specific call.

Conversation scope:

- "Conversation" means the active Furnace session id.
- Grants do not carry to other conversations.
- Child subagent sessions explicitly inherit the parent conversation's current grants.
- Grants are held in memory for the interactive run.
- `/reset-perms` clears permission grants for the current conversation only.

Denied calls:

If the user denies a permission prompt, Furnace does not execute that tool. It returns a denied tool result to the model, and denial does not persist unless a future rule explicitly says so.

## Lofi Mode

`/lofi` toggles a lightweight ambience mode for the interactive TUI.

Behavior:

- The TUI renders a tiny terminal-native chibi animation in the corner above the input.
- The chibi animation is original text UI, not a downloaded or vendored image asset.
- Furnace starts a free online radio stream using the best available local player.
- Running `/lofi` again turns the chibi off and stops the player when Furnace owns the player process.

Playback fallback order:

1. `mpv`
2. `ffplay`
3. macOS `afplay` through `curl`
4. `open` in the default browser/player

If Furnace has to use the browser fallback, `/lofi` can hide the UI but cannot close the external browser tab. The user should close that tab/player manually.

Configuration:

- `FURNACE_LOFI_URL` can override the default radio stream.
- The built-in default is a stable public SomaFM MP3 stream.

`/lofi` is an immediate slash command. It is handled by the TUI and is not queued as a model prompt while Furnace is busy.
