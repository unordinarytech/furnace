# Contributing to Furnace

Thanks for helping improve Furnace. Furnace is a terminal-first agentic coding harness with a local runtime, typed tools, permissions, SQLite sessions, compaction, skills, subagents, and a Pi TUI.

## Development Setup

Requirements:

- Node.js 22.x. The repo is pinned with `.nvmrc` and `.node-version`.
- npm.
- A supported provider API key for manual agent runs.

Setup:

```bash
nvm use
npm ci
cp .env.example .env
```

Configure a provider key through `/login` or an environment variable for local manual testing.

## Common Commands

Use the pinned Node wrapper scripts so native dependencies stay aligned with Node 22:

```bash
npm run check-node
npm run typecheck
npm test
npm run build
npm run dev
npm run dev -- -p "Reply with exactly: ok"
```

If `better-sqlite3` reports a native module mismatch:

```bash
nvm use
./scripts/with-node22.sh npm rebuild better-sqlite3
```

## Pull Request Guidelines

Before opening a PR:

1. Keep changes small and focused.
2. Add or update tests for runtime, tool, session, permission, compaction, skill, plan mode, or UI-adjacent behavior changes.
3. Update docs when user-visible behavior changes.
4. Run:

```bash
npm run verify
```

## Architecture Guidelines

- Keep agent/runtime concerns separate from terminal UI concerns.
- Keep provider-specific logic out of the TUI.
- Do not let tools bypass the permission engine.
- Preserve append-only session history semantics.
- Preserve assistant tool-call and tool-result pairings in model-message transforms.
- Preserve stale-write protections around file reads, writes, and edits.
- Keep context compression reversible by storing omitted originals locally.
- Keep user-facing terminal output concise.

## Safety Guidelines

Furnace operates on real local files and can run shell commands after approval. Be conservative with changes that affect:

- permission defaults,
- secret-file handling,
- shell command execution,
- write/edit tools,
- session persistence,
- model context construction,
- external network calls,
- skill discovery and skill management.

Do not add behavior that reads secrets, modifies `.git/`, or performs destructive filesystem/git actions without explicit user intent and permission gating.

## Documentation

Important docs live under `docs/`, especially:

- `docs/tools.md`
- `docs/skills.md`
- `docs/session-management.md`
- `docs/forking-and-branching.md`
- `docs/compaction.md`
- `docs/headroom-lite.md`
- `docs/image-support.md`
- `docs/delegation-subagents.md`
- `docs/interaction-model.md`
- `docs/plan.md`
- `docs/design-choices.md`

Keep `README.md` user-facing and `AGENTS.md` agent-facing.
