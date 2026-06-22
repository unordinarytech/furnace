# Plan Mode Research

This report inspects how Pi, OpenCode, and Hermes Agent implement plan-mode style workflows, then recommends the strongest design for Furnace. The goal is not "most compatible with Furnace today"; it is to pick the best ideas from the three systems and adapt them into a better Furnace-native design.

## Inspected Sources

- Pi: `/Users/nihal/code/test-repos/pi` at `4f71b2d3b7be1441dec4619ac19b3c2778b172a8`
- OpenCode: `/Users/nihal/code/test-repos/opencode` at `4ecc3ac6535316c481982c169ad943ceae91a44e`
- Hermes Agent: `/Users/nihal/code/test-repos/hermes-agent` at `065946d84f9ce31b7eb51380c9641c5038f291c4`

Before inspection, each repo was updated with `git pull --ff-only`.

## Summary

The three systems represent three different plan-mode philosophies:

- Pi treats plan mode as an extension. It is proof that plan mode can be built as a thin layer over a general extension/event system: toggle state, restrict tools, inject hidden context, prompt after the plan, then track execution progress.
- OpenCode treats plan mode as a first-class agent/mode. It has separate `build` and `plan` primary agents, permission rules that make plan mode enforceable, keyboard cycling between agents, and model-callable tools to enter/exit plan mode with user approval.
- Hermes treats plan mode as a skill. `/plan` loads a bundled `plan` skill that instructs the model to write a concrete markdown plan under `.hermes/plans/` and not execute. This is portable across CLI and messaging surfaces because every installed skill becomes a slash command.

Best Furnace direction: use OpenCode's first-class mode and permission model as the spine, Hermes' durable plan-file artifact as the deliverable, and Pi's post-plan UI flow/progress tracking as the optional execution bridge.

## Pi

### Relevant Files

- `packages/coding-agent/examples/extensions/plan-mode/index.ts`
- `packages/coding-agent/examples/extensions/plan-mode/utils.ts`
- `packages/coding-agent/examples/extensions/plan-mode/README.md`
- `packages/coding-agent/test/plan-mode-extension.test.ts`
- `packages/coding-agent/docs/extensions.md`
- `packages/coding-agent/docs/tui.md`
- `packages/coding-agent/CHANGELOG.md`

### Shape

Pi does not ship plan mode as a core feature. The coding-agent README explicitly frames plan mode as something to build or install through extensions. The inspected implementation is an example extension.

The extension registers:

- CLI flag: `--plan`
- Slash command: `/plan`
- Slash command: `/todos`
- Shortcut: `Ctrl+Alt+P`
- Event hooks: `tool_call`, `context`, `before_agent_start`, `turn_end`, `agent_end`, `session_start`

The TUI docs show the key system supports modified keys such as `shift+tab`, but the plan-mode example itself uses `Ctrl+Alt+P`, not Shift+Tab.

### Tool Restriction

Plan mode stores the active tool list before entering plan mode, then calls `pi.setActiveTools()`.

Plan tools:

- `read`
- `bash`
- `grep`
- `find`
- `ls`
- `questionnaire`

Disabled built-ins:

- `edit`
- `write`

The implementation preserves custom active tools. It removes managed write tools, adds the plan-mode read/search/question tools, then restores the exact previous list when plan mode exits. The regression test `preserves custom active tools while toggling plan mode` verifies this.

Bash is still available, but it is filtered by `utils.ts`:

- Destructive patterns deny `rm`, `mv`, `cp`, `mkdir`, redirection, installs, mutating git commands, `sudo`, process kills, editors, and similar commands.
- Safe patterns allow common inspection commands like `cat`, `head`, `grep`, `find`, `ls`, `pwd`, `git status`, `git log`, `git diff`, `npm list`, `rg`, `fd`, `bat`, and `eza`.
- The final rule is "not destructive and matches the safe allowlist."

### Prompting

On `before_agent_start`, if plan mode is enabled, the extension injects a hidden message:

- says `[PLAN MODE ACTIVE]`,
- describes read-only restrictions,
- says built-in edit/write are disabled,
- says bash is read-only allowlisted,
- asks the model to create a detailed numbered plan under a `Plan:` header,
- says not to make changes.

When not in plan mode, its `context` hook removes stale plan-mode context messages so future normal turns do not inherit plan instructions.

### Plan Extraction And Execution

After the agent ends, the extension extracts numbered plan steps from the latest assistant message using `extractTodoItems()`. It looks for a `Plan:` header and numbered lines.

If a plan exists, the UI asks:

- `Execute the plan (track progress)`
- `Stay in plan mode`
- `Refine the plan`

If the user executes:

- plan mode turns off,
- full tools are restored,
- execution mode turns on,
- the todo list is sent as a visible follow-up,
- a synthetic execution prompt is sent,
- the model is told to include `[DONE:n]` after completing each step.

During execution, a status widget shows `completed/total`. The extension scans assistant text for `[DONE:n]` markers and marks steps complete. When all are done, it posts a visible "Plan Complete" custom message.

### Persistence

Pi persists plan mode state by appending a custom session entry:

- `enabled`
- `todos`
- `executing`
- `toolsBeforePlanMode`

On session start/resume, it reads the latest custom `plan-mode` entry and restores mode state. If execution was in progress, it scans assistant messages after the latest `plan-mode-execute` marker to reconstruct completed steps.

### Strengths

- Cleanly proves plan mode can be implemented outside the core loop.
- Preserves custom tools instead of hard resetting to built-ins.
- Has a strong interactive post-plan bridge: execute, refine, or stay.
- Tracks execution progress with explicit markers.
- Persists mode state across session resume.

### Weaknesses

- It is extension-local state, not a first-class runtime invariant.
- Tool restriction is partly active-tool filtering and partly bash string heuristics.
- The plan itself is extracted from assistant text, not saved as a durable artifact.
- Execution progress depends on the model remembering `[DONE:n]`.
- The keyboard shortcut is not the user's expected Shift+Tab cycle.

## OpenCode

### Relevant Files

- `packages/core/src/agent.ts`
- `packages/core/src/config/agent.ts`
- `packages/core/src/plugin/agent.ts`
- `packages/core/src/permission.ts`
- `packages/core/src/permission/schema.ts`
- `packages/core/src/session.ts`
- `packages/opencode/src/agent/agent.ts`
- `packages/opencode/src/tool/plan.ts`
- `packages/opencode/src/tool/plan-enter.txt`
- `packages/opencode/src/tool/plan-exit.txt`
- `packages/opencode/src/session/prompt/plan-mode.txt`
- `packages/opencode/src/session/prompt/plan.txt`
- `packages/opencode/src/session/prompt/plan-reminder-anthropic.txt`
- `packages/tui/src/config/keybind.ts`
- `packages/tui/src/context/local.tsx`
- `packages/tui/src/app.tsx`
- `packages/tui/src/component/dialog-agent.tsx`
- `packages/tui/src/routes/session/index.tsx`
- `packages/core/test/session-create.test.ts`
- `packages/opencode/test/agent/agent.test.ts`
- `packages/opencode/test/acp/service-session.test.ts`

### Shape

OpenCode treats plan mode as an agent/mode, not just prompt text.

There are visible primary agents:

- `build`: default implementation agent.
- `plan`: plan mode agent.

Agent metadata has:

- `id`
- `description`
- `mode`: `subagent`, `primary`, or `all`
- `hidden`
- `permissions`
- optional model, system prompt, color, and step limit.

The default agent id is `build`.

The TUI exposes agents as an agent selector and also as keyboard cycling:

- `agent_cycle`: `tab`
- `agent_cycle_reverse`: `shift+tab`

`local.agent.move(1)` and `local.agent.move(-1)` cycle through visible primary agents. With the default visible agents, Tab/Shift+Tab effectively toggles between build and plan. This is the closest match to the interaction the user described.

### Permissions

OpenCode's strongest design point is that mode safety is enforced by permission rules.

V2 permissions are action/resource/effect rules:

```ts
{ action: string, resource: string, effect: "allow" | "deny" | "ask" }
```

The permission evaluator checks the current session's selected agent, then evaluates rules. Missing agent permissions deny everything.

Default rules deny:

- `question`
- `plan_enter`
- `plan_exit`

The `build` primary agent allows:

- `question`
- `plan_enter`

The `plan` primary agent allows:

- `question`
- `plan_exit`
- external plan storage paths
- editing plan markdown files only

The `plan` primary agent denies:

- all general `edit`
- the `general` subagent by default in the older agent config

But it allows:

- `.opencode/plans/*.md`
- the data-dir plan path
- `explore` and custom subagents in tests

This is much stronger than "tell the model not to edit." The model may try to edit files, but the plan agent's permissions reject it except for the plan artifact.

### Plan Enter And Exit

The older/opencode package includes tool text for `plan_enter` and `plan_exit`.

`plan-enter.txt` instructs the build agent to call plan-enter when:

- the user explicitly wants a plan,
- the task is complex,
- the agent wants to research and design before making changes,
- multiple files or architecture are involved.

It says not to call it for simple tasks or when the user explicitly wants immediate implementation.

`plan-exit.txt` instructs the plan agent to call plan-exit after:

- a complete plan has been written,
- clarifying questions are resolved,
- the plan is ready for implementation.

It says not to call it before finalizing the plan or while questions remain.

The `PlanExitTool` asks the user:

> Plan at `<path>` is complete. Would you like to switch to the build agent and start implementing?

Options:

- Yes: switch to build agent and start implementing.
- No: stay with plan agent to refine.

If approved, it creates a synthetic user message with agent `build`:

> The plan at `<path>` has been approved, you can now edit files. Execute the plan

The TUI listens for completed `plan_exit` and `plan_enter` tool parts and updates the local agent selection:

- `plan_exit` -> `build`
- `plan_enter` -> `plan`

### Plan Prompt

OpenCode has strict plan-mode reminder files.

`plan.txt` is a hard read-only reminder:

- Plan mode active.
- No edits.
- No mutating commands.
- No system changes.
- Read/search/delegate only.

`plan-mode.txt` is richer:

- Plan mode is active and the user does not want execution yet.
- Only the plan file may be edited.
- Phase 1: understand the request and use explore agents, up to 3 in parallel.
- Phase 2: design with a planning/general agent.
- Phase 3: review and clarify.
- Phase 4: write the final plan to the plan file.
- Phase 5: call `plan_exit`.
- The model should end only by asking a real question or calling `plan_exit`.
- It should not ask "is this plan okay?" through the question tool because `plan_exit` handles approval.

`plan-reminder-anthropic.txt` is similar and shows the plan file path explicitly.

### ACP / Editor Mode Support

OpenCode's ACP service exposes modes as config options.

On new/load session, ACP snapshots available modes and default mode id. Tests verify that loaded sessions restore mode `plan` from message history. `setSessionMode` validates the requested mode id and stores it in session state.

This matters because plan mode is not just TUI state. It is externally addressable for editor integrations and durable session replay.

### Strengths

- Best safety model: plan mode is a separate primary agent with permission rules.
- Best UI toggle: Tab/Shift+Tab cycles visible primary agents.
- Plan mode can still write a plan file, but only that file/path.
- Enter/exit plan mode is a model-callable but user-approved flow.
- The TUI and ACP/editor integrations both understand mode as session configuration.
- Mode switches are durable session events.

### Weaknesses

- Some inspected plan tooling exists in older/opencode paths while V2 core has TODOs for porting `plan_exit`; the design spans generations.
- Plan mode safety depends on the permission system being complete for every side-effecting tool.
- The plan prompt is very strong but large; it can become heavyweight if injected every turn without caching/compaction strategy.

## Hermes Agent

### Relevant Files

- `skills/software-development/plan/SKILL.md`
- `website/docs/user-guide/skills/bundled/software-development/software-development-plan.md`
- `website/docs/user-guide/features/skills.md`
- `website/docs/reference/slash-commands.md`
- `agent/skill_commands.py`
- `tools/skills_tool.py`
- `agent/prompt_builder.py`
- `hermes_cli/commands.py`
- `ui-tui/src/app/slash/commands/core.ts`
- `ui-tui/src/__tests__/createSlashHandler.test.ts`

### Shape

Hermes implements plan mode as a bundled skill.

The `plan` skill frontmatter:

```yaml
name: plan
description: "Plan mode: write an actionable markdown plan to .hermes/plans/, no execution. Bite-sized tasks, exact paths, complete code."
```

Installed skills become slash commands, so `/plan <request>` loads the `plan` skill.

Hermes documentation explicitly says installed skills are exposed as dynamic slash commands in both interactive CLI and messaging surfaces. `/plan` opens plan mode and saves markdown plans under `.hermes/plans/` relative to the active workspace/backend working directory.

### Plan Skill Behavior

The plan skill says:

- For this turn, planning only.
- Do not implement code.
- Do not edit project files except the plan markdown file.
- Do not run mutating terminal commands, commit, push, or perform external actions.
- Read-only repo/context inspection is allowed.
- The deliverable is a markdown plan under `.hermes/plans/`.

Save path:

- `.hermes/plans/YYYY-MM-DD_HHMMSS-<slug>.md`

The path is relative to the active backend workspace so it works across local, Docker, SSH, Modal, Daytona, and other backend-aware file tools.

The plan should include:

- Goal
- Current context / assumptions
- Proposed approach
- Step-by-step plan
- Files likely to change
- Tests / validation
- Risks, tradeoffs, open questions

The extended body is very opinionated about plan quality:

- complete enough for an implementer with little context,
- bite-sized tasks,
- exact file paths,
- complete code examples where helpful,
- exact commands and expected output,
- TDD,
- frequent commits,
- execution handoff to `subagent-driven-development`.

After saving, it should reply with what it planned and the saved path.

### Skill Dispatch

`agent/skill_commands.py` scans installed skills into slash commands.

`build_skill_command_message()`:

- resolves the slash command to a skill,
- loads full skill content through `skill_view`,
- bumps skill usage,
- builds a model-facing message:
  - `[IMPORTANT: The user has invoked the "<skill>" skill...]`
  - full skill body,
  - skill directory,
  - relative path guidance,
  - resolved skill config,
  - setup notes,
  - supporting files,
  - user instruction,
  - runtime note.

Hermes also includes `extract_user_instruction_from_skill_message()` so memory providers can strip giant skill scaffolding and keep only the user's actual instruction. That is an important operational detail for any skill-based plan mode.

`tools/skills_tool.py` provides progressive-disclosure tools:

- `skills_list`
- `skill_view`

The skill system supports platform/environment gating, external directories, linked files, setup notes, and prompt-injection checks.

### Safety

Hermes' plan mode safety is mostly skill-instruction safety, not a separate permission mode.

The skill tells the model not to edit except the plan file and not to run mutating commands. Unlike OpenCode, the inspected plan skill itself does not define a separate permission policy that rejects edits outside `.hermes/plans/`.

Hermes does have broader approval and tool safety infrastructure, but `/plan` as inspected is primarily a skill workflow.

### Strengths

- Very simple user mental model: `/plan whatever`.
- Works anywhere skills work: CLI, TUI, gateway/messaging platforms.
- Produces a durable artifact in the workspace.
- Best plan-writing craft: concrete, exact files, exact commands, TDD, bite-sized steps.
- The skill system handles slash discovery, full skill loading, supporting files, setup notes, and memory cleanup.

### Weaknesses

- Not a true mode toggle by itself.
- No inspected Shift+Tab build/plan switching.
- Safety relies more on prompt discipline than hard mode-level permission rules.
- No built-in post-plan "execute / refine / stay" UI like Pi.
- No plan-enter/plan-exit approval tool like OpenCode.

## Comparison

| Feature | Pi | OpenCode | Hermes |
|---|---|---|---|
| Representation | Extension state | First-class agent/mode | Skill slash command |
| Toggle | `/plan`, `--plan`, `Ctrl+Alt+P` | `Tab` next agent, `Shift+Tab` previous, agent dialog, ACP mode | `/plan` skill command |
| Write prevention | Active tools + bash allowlist | Permission rules on plan agent | Skill instructions plus broader approvals |
| Plan artifact | Assistant text parsed into todos | Dedicated plan file path with edit exception | `.hermes/plans/*.md` plan file |
| Plan approval | UI select after plan response | `plan_exit` asks user and switches to build | Final response asks/offers execution approach |
| Execution bridge | Synthetic follow-up + `[DONE:n]` | Synthetic build-agent message after approval | Suggests subagent-driven-development |
| Persistence | Custom session entries | Session agent switch events / message mode | Durable plan file and skill invocation in transcript |
| Editor/API mode | Extension-local | ACP mode support | Slash/skill surfaces |
| Best idea | Post-plan UI and progress | First-class safe mode | Durable high-quality plan artifact |

## Recommendation For Furnace

Furnace should not copy any one system wholesale.

The best design is:

1. **OpenCode spine:** represent plan mode as a first-class session mode, not just prompt text.
2. **OpenCode safety:** enforce mode through permission policy. In plan mode, deny `write`, `edit`, `bash` mutations, `skill_manage`, commits, and any side-effecting tool. Allow read/search/web/ask/subagent exploration. Allow writes only to a plan artifact path.
3. **OpenCode UX:** use `Shift+Tab` / `Tab` to cycle between `Agent` and `Plan` modes. Also expose `/plan` and `/agent` or `/mode` commands for discoverability.
4. **Hermes artifact:** write a markdown plan under `.furnace/plans/YYYY-MM-DD_HHMMSS-<slug>.md`. The plan file is the durable handoff, not an ephemeral assistant block.
5. **Hermes plan quality:** use a dedicated plan prompt/skill-like template that demands exact files, commands, tests, risks, and bite-sized steps.
6. **Pi bridge:** after a plan is ready, show a compact UI choice: `Execute`, `Refine`, `Stay in plan mode`. If executing, switch back to normal agent mode and inject a hidden/visible follow-up pointing to the plan file.
7. **Pi progress, later:** optionally track execution progress from the plan file with todo extraction and `[DONE:n]` markers, but do not make this required for the first cut.

## Proposed Furnace Design

### Session Mode State

Add a mode field to the active interactive session state:

```ts
type AgentMode = "agent" | "plan"
```

Persist mode changes as session entries, similar to model changes:

```ts
type ModeChangeEntryData = {
  from: AgentMode
  to: AgentMode
  reason: "user" | "tool" | "resume"
}
```

Why session-scoped: plan mode must survive redraws and resume, and switching chats should not leak mode to another conversation.

### Toggle UX

Recommended controls:

- `Tab`: next mode (`agent` -> `plan` -> `agent`) if only two primary modes exist.
- `Shift+Tab`: previous mode.
- `/plan [prompt]`: switch to plan mode and optionally send/queue the prompt.
- `/agent` or `/mode agent`: switch back to normal mode.
- Status label near input/model: `Plan` or `Agent`.

For compatibility with terminals where Shift+Tab is flaky, keep slash commands as the reliable path.

### Permission Policy

Plan mode should change the active permission layer before tools execute.

Allow:

- `read`
- `ls`
- `find`
- `glob`
- `grep`
- `websearch`
- `webfetch`
- `ask_question`
- `skill`
- `task` with restricted child tools or explicit "explore only" wording
- `task_status`

Ask or deny:

- `bash`: allow read-only commands only, or ask for every bash command with a plan-mode warning.
- `write` and `edit`: deny except the plan file path.
- `skill_manage`: deny.
- any future mutation tools: deny by default in plan mode.

Best version: make permission evaluation mode-aware rather than editing `toolDefinitions`. The model may still see tools, but execution policy enforces the invariant. A future enhancement can hide denied mutation tools from schemas to reduce bad calls.

### Plan File

Plan files should live at:

```text
.furnace/plans/YYYY-MM-DD_HHMMSS-<slug>.md
```

Plan mode should create a plan file path when entering mode and inject it into the plan system reminder.

Only this path should be writable in plan mode. It should render in tool previews like normal `write`/`edit` but with clear "Plan file" provenance.

Plan file shape:

```markdown
# <Task> Plan

## Goal

## Context And Assumptions

## Recommended Approach

## Steps

## Files Likely To Change

## Verification

## Risks And Open Questions
```

### Prompting

When mode is `plan`, inject a hidden runtime reminder after the base system prompt:

- Plan mode active.
- Do not implement.
- Do not edit except the plan file.
- Use read/search/web/ask/subagents to understand.
- Ask real clarifying questions when needed.
- Write/update the final recommendation in the plan file.
- End by either asking a blocking question or calling/triggering "plan ready."

Avoid injecting a huge prompt every turn if the context gets long. Keep the mode reminder compact, and put the richer planning craft in a local `plan` skill or prompt file that can be loaded once per plan session.

### Enter/Exit Tools

Add two small tools later, modeled after OpenCode:

- `plan_enter`: model asks to switch to plan mode when a task is complex.
- `plan_exit`: model asks to approve the plan and switch to agent mode.

First cut can rely on user controls (`Tab`, `Shift+Tab`, `/plan`, `/agent`). The tool path is useful once mode switching should be agent-initiated.

### Post-Plan UI

When the plan file is saved and the assistant finishes in plan mode, show a small panel:

- `Execute plan`
- `Refine plan`
- `Stay in plan mode`

If `Execute`:

- switch mode to `agent`,
- inject a follow-up:

```text
The user approved the plan at .furnace/plans/<file>.md. Read it and implement it.
```

If `Refine`:

- keep plan mode,
- restore an input/editor prompt asking for refinement text.

If `Stay`:

- keep plan mode and return to input.

This borrows Pi's best interaction without adopting its todo extraction as a hard dependency.

### Subagents In Plan Mode

Plan mode should prefer exploration subagents.

For Furnace's existing `task` tool:

- Allow `task` in plan mode, but child tools should inherit plan-mode restrictions.
- The plan prompt should say to delegate independent read-only exploration/review/design work.
- Child subagents should not write code in plan mode.

This is closer to OpenCode's plan prompt and safer than a free normal subagent.

### What Not To Copy

Do not copy Pi's bash regex allowlist as the only safety mechanism. It is useful as a defense-in-depth layer, but Furnace should enforce tool-level permission policy first.

Do not copy Hermes' plan mode as only a skill. Furnace already has skills, but plan mode should be a runtime state because it changes permissions, UI, and allowed writes.

Do not copy OpenCode's full heavy planning prompt verbatim. Use its structure, but keep Furnace's prompt concise and terminal-friendly.

## First Implementation Cut

1. Add `AgentMode = "agent" | "plan"` to interactive session/UI state.
2. Add `Tab`/`Shift+Tab` mode cycling with a visible status label.
3. Add `/plan [prompt]` and `/agent` commands.
4. Inject a compact plan-mode hidden system/user reminder.
5. Make permissions mode-aware:
   - deny mutation tools in plan mode,
   - allow only `.furnace/plans/*.md` writes/edits.
6. Create a plan file path on entering plan mode and expose it to the prompt.
7. Add `/plans` or `/plan open` later for browsing saved plans.
8. Add post-plan execute/refine/stay panel after the first stable version.

## Why This Is Best For Furnace

Furnace is becoming a layered agent runtime, not just a TUI wrapper. Plan mode should therefore be an enforceable runtime mode, visible to the UI, persisted in sessions, and respected by tools. OpenCode has the best core safety model for that. Hermes has the best user-facing plan artifact and plan-writing craft. Pi has the best simple post-plan interaction.

The best Furnace version is the intersection of those strengths:

- first-class mode,
- hard permissions,
- durable markdown plan,
- skill-quality planning instructions,
- easy keyboard toggle,
- clear execute/refine/stay transition.
