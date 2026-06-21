# Skills Research And Furnace Plan

Inspected references:

- Pi: `bc0db643502ba0bf1b227a97d9d5885cefc2b909`
- OpenCode: `823d327401ba93d24174c9feb50b5dbe4f60f646`
- Hermes Agent: `d0de4601d204d13c68f76fa2ed5fb99d841048fc`

## Summary

All three systems treat skills as progressive-disclosure knowledge packages: keep only names/descriptions in context, then load the full instructions only when a task matches. The split is important for Furnace because a terminal coding harness can accumulate many skills, but the model should not pay the token cost for all of them on every turn.

Recommended Furnace direction:

1. Implement local skill discovery for `SKILL.md`.
2. Inject a compact available-skills block into the system context.
3. Add a model-facing `skill` tool to load full skill content on demand.
4. Add explicit `/skill:<name>` slash commands that wrap the next user message with a hidden skill invocation.
5. Add skill management and hub-style installation later, behind approvals.

## Pi

Pi implements the Agent Skills standard with a local resource loader.

Key behavior:

- Discovers skills from global, project, package, settings, and CLI paths.
- Supports both `SKILL.md` directories and some direct root `.md` skill files.
- Respects ignore files while scanning.
- Validates frontmatter but stays lenient: warnings for most standard violations, hard failure for missing descriptions.
- Tracks provenance through `sourceInfo` so autocomplete/config views can show where a skill came from.
- Adds skills to slash autocomplete as `/skill:<name>` commands.
- Uses progressive disclosure:
  - Startup/system context lists names and descriptions.
  - The model can read the full skill file when needed.
  - Explicit `/skill:name args` forces skill loading and appends user args.
- Supports `disable-model-invocation` so a skill can be hidden from automatic model choice while still available via explicit slash command.

Useful files:

- `packages/coding-agent/src/core/skills.ts`
- `packages/coding-agent/src/core/resource-loader.ts`
- `packages/coding-agent/docs/skills.md`
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`

What Furnace should borrow:

- Simple Agent Skills-compatible `SKILL.md` discovery.
- Project and user skill locations.
- Diagnostics instead of hard failure for non-critical validation problems.
- `/skill:<name>` explicit invocation.
- `disable-model-invocation` equivalent.

## OpenCode

OpenCode V2 models skills as a plugin/domain service with sources, permissions, guidance, and a model-facing tool.

Key behavior:

- `SkillV2.Service` owns skill sources and lists materialized skills.
- Sources can be directories, URLs, or embedded skills.
- Config contributes default sources:
  - `<config directory>/skill`
  - `<config directory>/skills`
  - configured `skills` entries, including URLs.
- Skills parse frontmatter fields:
  - `name`
  - `description`
  - `slash`
- `SkillGuidance` injects a compact available-skills section into system context.
- The `skill` tool loads full skill content by name.
- Tool output wraps content with:
  - skill name,
  - skill body,
  - base directory URL,
  - sampled supporting-file list.
- Skill loading goes through permission evaluation: `action: "skill"`, resource skill name.
- Skills are filtered per selected agent permissions.
- TUI command autocomplete intentionally skips server commands sourced from skills in the generic server-command list, while skill loading is still available through the skill domain/tool path.

Useful files:

- `packages/core/src/skill.ts`
- `packages/core/src/skill/guidance.ts`
- `packages/core/src/tool/skill.ts`
- `packages/core/src/config/plugin/skill.ts`
- `packages/core/test/tool-skill.test.ts`
- `packages/tui/src/component/prompt/autocomplete.tsx`

What Furnace should borrow:

- A real `skill` tool instead of relying only on file reads.
- Permission action/resource shape for skill loading.
- Per-agent filtering later when Furnace has agent profiles.
- Base-directory instructions and supporting-file sampling in tool output.
- Source abstraction that can later support URLs/hubs without rewriting the runtime.

## Hermes Agent

Hermes has the most complete skill lifecycle. Skills are procedural memory, user-extensible packages, and agent-managed artifacts.

Key behavior:

- Primary skill root is `~/.hermes/skills/`.
- Bundled, hub-installed, external, and agent-created skills all participate.
- Every installed skill becomes a slash command, for example `/github-pr-workflow`.
- Supports natural-language skill discovery through tools.
- Uses progressive disclosure:
  - `skills_list()` returns summaries.
  - `skill_view(name)` loads full content.
  - `skill_view(name, path)` loads a supporting file.
- Skill frontmatter supports richer Hermes metadata:
  - platform restrictions,
  - conditional activation by available tools/toolsets,
  - required environment variables,
  - skill config settings,
  - tags/category.
- Skill invocation expands into a scaffolded model-facing message with the full skill body and user instruction.
- Memory ingestion strips skill scaffolding back to the user's actual instruction to avoid polluting memory with giant skill bodies.
- `skill_manage` lets the agent create/edit/patch/delete skills and supporting files.
- Skill writes can be protected by:
  - optional guard scanning,
  - write approval,
  - pending review directories,
  - pinned-skill delete protection,
  - safe recursive-delete guards.
- Skills Hub adds browse/install/inspect flows and quarantine/audit state.

Useful files:

- `agent/skill_commands.py`
- `agent/skill_bundles.py`
- `tools/skills_tool.py`
- `tools/skill_manager_tool.py`
- `tools/skills_guard.py`
- `hermes_cli/subcommands/skills.py`
- `website/docs/user-guide/features/skills.md`

What Furnace should borrow later:

- Agent-managed skill creation only after strong approvals exist.
- Hidden/scaffolded skill invocation messages so the model sees the skill but the UI/memory do not show or store noisy wrapper text.
- Skill config/env declaration support.
- Guardrails for skill writes and deletes.
- Optional hub/install flows after local skills are stable.

## Proposed Furnace Design

### Phase 1: Local Skill Runtime

Add:

- `src/skills/types.ts`
- `src/skills/loader.ts`
- `src/skills/context.ts`
- `src/tools/skill.ts` or registry entry in `src/tools/registry.ts`

Skill locations:

- Project: `.furnace/skills/`
- Project/shared: `.agents/skills/`
- User: `~/.furnace/skills/`
- Shared user: `~/.agents/skills/`
- Configured extra paths later.

Discovery rules:

- A directory containing `SKILL.md` is a skill root.
- Do not recurse below a skill root.
- Ignore `node_modules`, `.git`, `.furnace`, and ignore-file patterns.
- Validate `name` and `description`.
- Missing description should prevent model-visible loading.
- Unknown frontmatter fields should be preserved but ignored by v1.

Frontmatter:

```yaml
---
name: code-review
description: Review code changes for bugs, regressions, and missing tests.
disable-model-invocation: false
---
```

### Phase 2: System Guidance And Tool

Inject compact context:

```xml
<available_skills>
  <skill>
    <name>code-review</name>
    <description>Review code changes for bugs, regressions, and missing tests.</description>
  </skill>
</available_skills>
```

Add a `skill` tool:

```json
{
  "name": "code-review"
}
```

Tool output should include:

- full `SKILL.md` content without frontmatter,
- base directory,
- a short supporting-file list,
- explicit relative-path guidance.

This is the most important design point: the model should choose from descriptions, then call `skill` to load the heavy content only when relevant.

### Phase 3: Slash Commands

Add `/skill:<name>` commands to slash autocomplete.

Behavior:

- `/skill:name` loads the skill into a hidden user message and asks the model to proceed.
- `/skill:name extra args` appends `User instruction: extra args`.
- Skills with `disable-model-invocation: true` are hidden from automatic guidance but still appear in slash autocomplete.

This mirrors Pi's explicit invocation path and Hermes' hidden/scaffolded skill message approach.

### Phase 4: Permissions And Safety

Add permission action:

```ts
permission: "skill"
pattern: skillName
```

Default can be `allow` for local trusted user/project skills, but Furnace should still show provenance in the UI and docs. For remote/hub skills later, use `ask`.

Do not add `skill_manage` in the first pass. Skill writes are high leverage and should wait for:

- write approval,
- diff preview,
- path safety,
- optional scan,
- pending review storage.

### Phase 5: Skill Management And Hub

After local skills work:

- Add `skills_list`/`skills_view` commands for user inspection.
- Add `/skills reload`.
- Add config-driven extra skill paths.
- Add agent-created skills with explicit approval.
- Add a skills hub/install flow.

## Open Questions

- Should Furnace support root `.md` skills, or only `SKILL.md` directories? Recommendation: start with `SKILL.md` directories only.
- Should project `.agents/skills` require trust? Recommendation: yes, same as project instructions.
- Should subagents inherit available skills? Recommendation: yes, but child prompts should get the same compact skill guidance and can call `skill`; do not eagerly inject full skill bodies into every child.
- Should skills be visible in `/history` transcripts? Recommendation: no for explicit skill wrappers; use hidden messages like background subagent completions, while preserving model replay.

## First Implementation Cut

Build this first:

1. Loader for local `SKILL.md` directories.
2. Compact system guidance.
3. `skill` tool.
4. `/skill:<name>` autocomplete and hidden invocation.
5. Docs and tests.

Skip for now:

- remote skill sources,
- skill hub,
- agent-managed skill writes,
- platform/toolset conditional activation,
- env/config prompting.
