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
- Session history should be event-sourced first, with compacted summaries derived from the log.
- Keep sandboxing in the design from the start, even if the first version only has permission gates and workspace write boundaries.

## Initial Technical Defaults

- Language: TypeScript.
- Runtime: Node.js 22+.
- CLI parser: Commander or Yargs.
- Schemas: Zod or TypeBox.
- TUI: React Ink for the fastest first version, or OpenTUI/Solid if terminal UI quality becomes a primary differentiator.
- Storage: JSONL transcripts first, SQLite index later if needed.
- Providers: Anthropic, OpenAI Responses API, and OpenAI-compatible endpoints.

## Coding Standards

- Keep modules narrowly scoped and named by responsibility.
- Do not place provider logic inside the TUI.
- Do not let tools bypass the permission engine.
- Prefer append-only logs for session state and debugging.
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
