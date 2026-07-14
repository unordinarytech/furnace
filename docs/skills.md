# Skills

Skills are reusable instruction packages that teach Furnace how to perform a specific workflow without putting every workflow into the base system prompt.

The core rule is progressive disclosure: Furnace shows the model a compact list of skill names and descriptions, then loads the full `SKILL.md` only when the model or user explicitly asks for that skill.

## Harness Provenance

Furnace's skill system is a hybrid of the harnesses we inspected:

- Pi influenced the Agent Skills-compatible `SKILL.md` directory shape, `/skill:<name>` explicit invocation, `disable-model-invocation`, and the idea that manual-only skills should still appear in slash autocomplete.
- OpenCode influenced compact available-skill guidance, a model-facing `skill` tool, permission-style skill loading, provenance/source awareness, and tool output that includes base-directory guidance plus supporting-file samples.
- Hermes Agent influenced hidden/scaffolded explicit skill invocation messages, user-inspection commands, agent-created skill management, and the safety stance that persistent skill writes need explicit approval and a preview.
- Cursor and Claude Code influenced the discovery roots. Furnace can read existing Cursor and Claude Code skill directories so the user's installed skills are available in Furnace too.

## Skill Format

Furnace discovers skills as directories containing `SKILL.md`:

```text
skill-name/
  SKILL.md
  reference.md
  examples.md
```

`SKILL.md` uses frontmatter:

```markdown
---
name: terminal-polish
description: Improves terminal interface spacing and copy. Use when polishing terminal UI.
disable-model-invocation: true
---

# Terminal Polish

Keep panels compact and readable.
```

Required fields:

- `name`: lowercase letters, numbers, and hyphens, max 64 characters.
- `description`: non-empty, max 1024 characters.

Optional field:

- `disable-model-invocation: true`: hide the skill from automatic model guidance while keeping explicit `/skill:<name>` available.

## Discovery

Furnace scans these roots:

- Project roots: `.furnace/skills`, `.agents/skills`
- User roots: `~/.furnace/skills`, `~/.agents/skills`
- Cursor roots: `~/.cursor/skills`, `~/.cursor/skills-cursor`, `~/.cursor/plugins/cache`
- Claude Code roots: `~/.claude/skills`, `~/.claude/plugins/cache`
- Configured roots from `.furnace/preferences.json`

Extra roots:

```json
{
  "skillPaths": ["custom-skills", "~/shared-skills"]
}
```

Project roots win on duplicate names because they are discovered first. Duplicate later skills are ignored with a diagnostic.

## Model Guidance

Each parent and subagent turn gets compact skill guidance appended to the system prompt.

Only skills without `disable-model-invocation: true` are included in automatic guidance:

```xml
<available_skills>
  <skill>
    <name>terminal-polish</name>
    <description>Improves terminal interface spacing and copy. Use when polishing terminal UI.</description>
    <provenance>project .furnace</provenance>
  </skill>
</available_skills>
```

The model can call `skill` to load the full content when a task matches a skill description.

## Slash Commands

Explicit skill invocation:

- `/skill:name` loads the skill into a hidden user message and asks the model to proceed.
- `/skill:name extra args` appends `User instruction: extra args`.
- Manual-only skills still appear in autocomplete.

Inspection and reload:

- `/skills` or `/skills list`: list discovered skills with provenance and auto/manual mode.
- `/skills view <name>`: show description, invocation mode, provenance, path, and full loaded content.
- `/skills reload`: refresh discovery and slash autocomplete after adding or editing skills.

Autocomplete supports multi-word skill commands such as `/skills reload` and `/skills view `.

## Tools

### `skill`

`skill` loads a full skill by name.

It returns:

- full `SKILL.md` body,
- provenance,
- base directory URL,
- relative-path guidance,
- sampled supporting files.

Local skill loading is allowed by default because it is read-only.

### `skill_manage`

`skill_manage` creates or updates a local `SKILL.md`.

Writable targets:

- `project`: `.furnace/skills/<name>/SKILL.md`
- `user`: `~/.furnace/skills/<name>/SKILL.md`
- `cursor-user`: `~/.cursor/skills/<name>/SKILL.md`
- `claude-user`: `~/.claude/skills/<name>/SKILL.md`

Managed/plugin roots are discoverable but not writable:

- `~/.cursor/skills-cursor`
- `~/.cursor/plugins/cache`
- `~/.claude/plugins/cache`

`skill_manage` asks for approval before writing and renders a proposed `SKILL.md` preview in the tool UI. New skills default to `disable-model-invocation: true`, so the user can reload and explicitly invoke them before allowing automatic model guidance.

After a successful write, run:

```text
/skills reload
```

## Safety Model

Current defaults:

- `skill` is read-only and allowed by default.
- `skill_manage` asks by default because it changes persistent future behavior.
- Skill writes are constrained to approved writable roots.
- Plugin and managed roots are read-only in Furnace.
- Full explicit skill invocations are hidden from the visible transcript but preserved for model replay.

Future hub or remote skills should default to ask until Furnace has install provenance, review storage, and scan/audit support.

## Implementation

Main files:

- `src/skills/loader.ts`: discovery, validation, provenance, configured paths.
- `src/skills/context.ts`: compact guidance, tool output, hidden invocation message.
- `src/skills/manage.ts`: approved-root skill writing.
- `src/tools/registry.ts`: `skill` and `skill_manage` tools.
- `src/interactive-session-controller.ts`: `/skill:<name>`, `/skills list`, `/skills view`, and `/skills reload`.
- `src/slash-command-router.ts`: skill command discovery and autocomplete items.
- `src/ui/pi-terminal.ts`: dynamic slash autocomplete and tool previews.
