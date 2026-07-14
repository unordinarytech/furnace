# Extensions and Subagents

> Furnace adds reusable behavior through skills and custom commands, and parallel work through child sessions.

## Overview

Skills are Markdown instruction packages discovered from project, user, configured, and plugin roots. Custom commands are prompt templates loaded from `.furnace/commands`. Neither requires a Furnace fork.

Subagents are normal agent turns in related child sessions. The task manager groups them, runs a group in parallel, reports status, and can release the parent turn while work continues in the background.

## How It Works

### Skills

Each skill is a directory containing `SKILL.md` with a description and optional name. Furnace builds a catalog, reports invalid or duplicate entries, adds eligible descriptions to model guidance, and loads full content only when invoked.

Project skills take precedence because roots are scanned in a stable order. Managed or plugin cache roots are readable but must not be treated as writable management targets.

### Custom Commands

Markdown templates under project or user `.furnace/commands` become slash commands. Project commands override global commands with the same name. `$ARGUMENTS` is replaced with user input.

### Subagents

The `task` tool creates child sessions and task records. Tasks in a group run concurrently. Foreground groups block the parent turn; backgrounded groups return control immediately and inject completion back into the parent later.

## Key Paths

| Path | Responsibility |
| --- | --- |
| `src/skills/loader.ts` | Skill roots, scanning, parsing, validation, and precedence |
| `src/skills/context.ts` | Catalog guidance and explicit invocation prompts |
| `src/skills/manage.ts` | Managed project and user skills |
| `src/commands/custom/loader.ts` | Custom-command discovery and rendering |
| `src/commands/autocomplete.ts` | Skill and custom-command completion |
| `src/tasks/manager.ts` | Parallel groups, backgrounding, status, and cancellation |
| `src/tasks/types.ts` | Task runner contracts |
| `src/tools/skills.ts` | Skill tools |
| `src/tools/tasks.ts` | Task and task-status tools |
| `src/ui/session-terminal-bridge.ts` | Child-session UI isolation |

## Invariants

- Duplicate skill names resolve deterministically and produce diagnostics.
- `disable-model-invocation` skills remain available for explicit use only.
- Plugin and managed cache roots are never writable skill-management targets.
- Custom-command rendering must not execute template content directly.
- Child sessions stay out of normal history.
- Child agents do not receive the `task` tool, preventing recursive delegation.
- A task group's records remain associated with one parent session.
- Background completion must not mutate another visible session.
- Live background task groups are process-local; durable results return through session entries.

## Changing This Area

- Test discovery order with project, user, configured, and plugin roots.
- Keep skill parsing small and deterministic.
- Test foreground, background, cancellation, failure, and completion-injection paths.
- Preserve session permission inheritance for child agents.
- Run skills, tools, session, and UI bridge tests after changing delegation.
