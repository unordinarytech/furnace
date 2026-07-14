# Runtime

> The runtime turns one user prompt into persisted model messages, approved tool executions, and a final assistant response.

## Overview

The runtime has two orchestration levels:

- The session controller owns long-lived concerns such as active sessions, modes, queues, tasks, compaction, preferences, and interface updates.
- The agent loop owns one model turn and its tool-call iterations.

Providers expose a common configuration shape, while protocol-specific request code stays under `src/providers/` and `src/openrouter.ts`.

`/login` stores provider credentials in `~/.furnace/auth.json`; environment variables remain available for CI and local overrides. Custom provider definitions are stored separately in `~/.furnace/providers.json`.

## How It Works

1. `loadConfig()` combines saved preferences, environment variables, provider metadata, and CLI overrides.
2. The controller loads the active session path and system guidance.
3. Session entries become provider messages, including runtime context and image blocks.
4. Before each request, request-local compression may shorten old tool results.
5. The agent loop streams a provider response.
6. Tool calls are authorized, executed in order, and appended as tool messages.
7. The loop continues until no tool calls remain or a task group is backgrounded.
8. Usage and the final response are persisted and sent to the interface.

Context-overflow errors receive one recovery attempt through session compaction. Current-information prompts can force `websearch` on the first iteration; local repository prompts do not.

Repository indexing is an optional workspace service. It writes `.furnace/repo-index.md` plus sidecar metadata, and can regenerate manually, during onboarding, or after tracked upstream changes without blocking prompt input.

## Key Paths

| Path | Responsibility |
| --- | --- |
| `src/config.ts` | Runtime configuration and environment loading |
| `src/providers/registry.ts` | Built-in provider definitions |
| `src/providers/resolution.ts` | Provider activation and key resolution |
| `src/providers/catalog.ts` | Model listing and cache |
| `src/providers/openai-compatible.ts` | OpenAI-compatible transport |
| `src/providers/anthropic.ts` | Anthropic transport |
| `src/openrouter.ts` | Shared completion and OpenRouter behavior |
| `src/repo-index/core.ts` | Repository snapshots, index generation, and metadata |
| `src/repo-index/service.ts` | Background reindex policy and lifecycle |
| `src/interactive-session-controller.ts` | Long-lived runtime coordination |
| `src/agent/loop.ts` | One streamed agent turn |
| `src/prompts/` | Runtime system prompts copied into builds |

## Invariants

- A denied tool call must become a tool result so message ordering remains valid.
- Abort signals must stop provider and tool work promptly.
- Provider adapters must not know about TUI components.
- Model-facing transformations must not rewrite stored history.
- Configuration precedence must remain explicit: session override, saved preference, environment, then default.
- Prompt Markdown under `src/prompts/` is runtime code and must ship with the package.

## Changing This Area

- Add provider behavior through provider types and resolution, not UI conditionals.
- Test tool-loop ordering, aborts, usage aggregation, and overflow recovery in `test/agent-loop.test.mjs`.
- Test provider payloads in the provider test suites.
- Run a headless smoke command after changing startup or configuration:

```bash
npm run dev -- -p "Reply with exactly: ok"
```
