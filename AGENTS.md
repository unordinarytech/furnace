# Agent Instructions

This repository is building an agentic coding harness from scratch. Treat the project as a layered runtime, not just a chat wrapper around an LLM.

## Product Direction

- Build a terminal-first coding agent harness with both interactive and headless modes.
- Keep the agent runtime independent from the terminal UI.
- Prefer small, testable layers over a large monolithic CLI.
- Start minimal: provider streaming, tool calls, permissions, session logs, and a useful TUI.
- Make extensions, skills, and custom tools possible without requiring forks.

## Architecture Principles

- The core agent loop should be reusable by CLI, TUI, JSON, RPC, SDK, and future editor integrations.
- All runtime activity should emit typed events: model deltas, tool calls, tool results, approvals, errors, and session updates.
- Tools must define their own schema, permission metadata, execution logic, and result shape.
- Permissions should be enforced before tools touch files, run commands, or access external resources.
- Session history uses a Pi-style tree in local SQLite: entries point to parent entries, and sessions track the active leaf.
- Compaction should preserve Pi-style `firstKeptEntryId` semantics when implemented.
- Keep sandboxing in the design from the start, even if the first version only has permission gates and workspace write boundaries.

## Initial Technical Defaults

- Language: TypeScript.
- Runtime: Node.js 22.19+.
- CLI parser: Commander.
- Schemas: Zod or TypeBox.
- TUI: `@earendil-works/pi-tui` for retained-mode terminal rendering, editor input, loader, and history selection.
- Storage: local SQLite in `.furnace/furnace.sqlite` using `better-sqlite3`.
- Providers: OpenRouter chat completions first, with Anthropic/OpenAI adapters later.

## Current Implementation

- `src/cli.ts` wires the CLI, OpenRouter streaming, session store, and interactive loop.
- `src/openrouter.ts` contains the current streaming and completion calls.
- `src/ui/pi-terminal.ts` owns the interactive terminal UI.
- `src/ui/terminal.ts` is still used for simple print/piped rendering.
- `src/session/store.ts` is the SQLite session store.
- `src/session/context.ts` converts active session entries into transcript/model messages.
- `src/session/title.ts` generates short session titles through a cheaper model.

Interactive commands currently supported:

- `/new`: switch to a fresh chat, reusing the current blank session if no message has been sent.
- `/history`: show saved non-empty conversations with arrow-key selection.
- `/exit` or `/quit`: leave the interactive TUI.

## Coding Standards

- Keep modules narrowly scoped and named by responsibility.
- Do not place provider logic inside the TUI.
- Do not let tools bypass the permission engine.
- Treat session entries as append-only; branch/fork features should move active leaves or create forked sessions, not rewrite old entries.
- Keep empty placeholder sessions out of user-visible history.
- Keep user-facing output concise, especially in the terminal.
- Add tests around the agent loop, tool execution, permission decisions, and transcript replay.

## Safety Defaults

- Ask before file edits and shell commands until the user explicitly changes policy.
- Deny reading secret-like files by default, including `.env` and `.env.*`, while allowing `.env.example`.
- Scope file writes to the workspace unless an external path is explicitly approved.
- Never run destructive git or filesystem commands without explicit approval.
- Truncate large command outputs and preserve the full output separately only when the user opts in.

## Useful Comparisons

- Pi: minimal TypeScript harness with extension-first design.
- OpenCode: client/server-style architecture with TUI as one client.
- Codex CLI: Rust implementation with strong sandboxing and a reusable core.
- Claude Code: product model with one engine across terminal, IDE, SDK, hooks, skills, and background agents.
