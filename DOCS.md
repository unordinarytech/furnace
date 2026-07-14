# Furnace Documentation

Use this index to understand the harness before changing it. Read the architecture documents in order, then open the system guide for the area you are modifying.

## Architecture

| Document | Read this to understand |
| --- | --- |
| [Overview](docs/architecture/overview.md) | The major layers, request flow, and ownership boundaries |
| [Runtime](docs/architecture/runtime.md) | CLI startup, session orchestration, the agent loop, providers, and tools |
| [Sessions](docs/architecture/sessions.md) | SQLite persistence, entry trees, forks, model projection, and history |
| [Interfaces](docs/architecture/interfaces.md) | Interactive TUI, headless output, prompt queues, commands, and images |

## Systems

| Document | Read this to understand |
| --- | --- |
| [Tools and permissions](docs/systems/tools-and-permissions.md) | Tool registration, execution, approvals, file safety, and plan-mode restrictions |
| [Context management](docs/systems/context-management.md) | Request compression, retrieval artifacts, session compaction, and overflow recovery |
| [Extensions and subagents](docs/systems/extensions-and-subagents.md) | Skills, custom commands, delegated tasks, and child sessions |
| [Repository index](docs/systems/repository-index.md) | Workspace onboarding, bounded repository maps, and background refresh |
| [Plan and evolve](docs/systems/plan-and-evolve.md) | Read-only planning and verified self-modification |

## Changing Furnace

| Document | Read this to understand |
| --- | --- |
| [Change guide](docs/contributing/change-guide.md) | Source ownership, invariants, test locations, and verification commands |

## Documentation Format

Every document follows the same shape:

1. **Overview** — what the area owns.
2. **How it works** — the shortest useful execution model.
3. **Key paths** — source files that define the behavior.
4. **Invariants** — behavior that changes must preserve.
5. **Changing this area** — practical checks for contributors and agents.

Keep these documents about current behavior. Put release history in `CHANGELOG.md`; do not add implementation plans, speculative roadmaps, or copied source-level detail.
