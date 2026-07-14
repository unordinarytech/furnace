# Agent Instructions

This repository builds Furnace, a terminal-first agentic coding harness. Treat it as a layered local agent runtime with typed tools, permissions, SQLite sessions, compaction, skills, subagents, and a Pi TUI. Do not treat it as only a chat wrapper around an LLM.

## Product Direction

- Build a practical coding-agent harness with interactive TUI, headless prompt mode, resumable sessions, tool calls, permissions, and local state.
- Keep agent/runtime concerns separate from terminal UI concerns so future JSON, RPC, SDK, and editor surfaces can reuse the same engine.
- Prefer small, testable layers over large monolithic CLI changes.
- Make extensions, skills, custom slash commands, and custom tools possible without requiring forks.
- Preserve local-first behavior: SQLite sessions, local preferences, local skills, local context artifacts, and no infrastructure dependency beyond selected model/search providers.

## Required Commands

Use the pinned Node 22 scripts. Do not run plain `node`, `tsx`, or `tsc` directly unless you intentionally use `./scripts/with-node22.sh`.

```bash
npm run verify
npm run check-node
npm run typecheck
npm test
npm run build
npm run dev
npm run dev -- -p "Reply with exactly: ok"
```

Use `npm run verify` before pushing. It runs `check-node`, `typecheck`, `test`, and `pack:dry-run` in sequence and prints a clear pass/fail line for each step.

If `better-sqlite3` reports a `NODE_MODULE_VERSION` mismatch, run:

```bash
nvm use
./scripts/with-node22.sh npm rebuild better-sqlite3
```

## Current Technical Defaults

- Language: TypeScript.
- Runtime: Node.js 22.x only; repo pins `22.22.3` through `.nvmrc` and `.node-version`.
- CLI parser: Commander.
- TUI: `@earendil-works/pi-tui` with local components under `src/ui/pi/`.
- Storage: local SQLite at `.furnace/furnace.sqlite` using `better-sqlite3`.
- Providers: OpenRouter, Anthropic, and custom OpenAI-compatible endpoints.
- Build: `tsc` plus `esbuild` to `dist/cli.js`; prompt markdown is copied by `scripts/copy-prompts.mjs`.
- Tests: Node test runner after `npm run build`.

## Current Implementation Map

- `src/cli.ts` is the CLI entrypoint. It wires Commander options, opens the session store, and delegates interactive/headless/piped execution to `src/interactive-session-controller.ts`.
- `src/interactive-session-controller.ts` owns session orchestration for the TUI, headless turns, piped mode, plan mode, permissions, compaction, preferences, and subagent execution. Focused helpers live in `src/prompt-queue.ts`, `src/session/navigation.ts`, `src/slash-command-router.ts`, and `src/task-ui-bridge.ts`.
- `src/agent/loop.ts` contains the reusable streamed agent turn loop. It handles tool-call iterations, asks the permission store before gated tools run, records callbacks, and can force web search for non-local current-info requests.
- `src/openrouter.ts` is the provider-neutral request facade retained under its historical filename; provider adapters and model catalog logic live under `src/providers/`.
- `src/tools/registry.ts` declares built-in tool schemas/registration and dispatches to handlers split by domain under `src/tools/`:
  - file/search: `read`, `ls`, `find`, `glob`, `grep`, `write`, `edit`;
  - execution/interaction: `bash`, `ask_question`;
  - skills: `skill`, `skill_manage`;
  - subagents: `task`, `task_status`;
  - planning: `todoread`, `todowrite`;
  - web: `websearch`, `webfetch`;
  - compression retrieval: `context_retrieve`.
- `src/permissions.ts` enforces default permissions. Read/search/question/skill/task/todo/web tools are allowed by default; write/edit/bash/skill management ask by default. Plan mode denies most mutations except writing/editing the active plan artifact and safe read-only shell commands.
- `src/session/store.ts` persists sessions and entries in SQLite using a Pi-style active-leaf tree. It records messages, tool calls/results, compactions, todo state, image attachments, branch/fork metadata, and file-read receipts/snapshots for stale-write warnings.
- `src/git-exclude.ts` keeps project `.furnace/` runtime state out of `git status` by adding local `.git/info/exclude` entries. Prefer local excludes over modifying a user's committed `.gitignore`.
- `src/session/context.ts` converts active session entries into model messages and user-visible transcript rows, including image blocks and compacted context references.
- `src/session/compaction.ts` implements model-assisted session compaction with deterministic fallback, `firstKeptEntryId` semantics, file details, secret redaction, and file-read-state clearing after compaction.
- `src/compression/*` implements Headroom-lite tool-output compression and request-local compression transforms. Full originals are stored under `.furnace/context-store/` and retrieved by `context_retrieve`.
- `src/ui/pi-terminal.ts` and `src/ui/pi/components/*` implement the interactive terminal: transcript rendering, streaming output, prompt input/autocomplete, approvals, question prompts, model editor, settings, permissions panel, task status, queue controls, plan actions, lofi state, themes, and status line.
- `src/commands.ts` defines built-in slash commands including `/new`, `/resume`/`/history`, `/fork`, `/clone`, `/image`, `/login`, `/model`, `/plan`, `/agent`, `/mode`, `/theme`, `/tasks`, `/compact`, `/skills`, `/lofi`, `/evolve`, `/reset`, `/settings`, `/permissions`, `/status`, `/export`, `/diff`, `/undo`, `/copy`, `/cost`, `/editor`, `/bug`, `/exit`, and `/quit`.
- `src/evolve/*` implements harness self-modification (`/evolve`) and reset (`/reset`): `root.ts` detects the furnace source root and gates availability; `recovery.ts` captures git+dist recovery points and restores them (`furnace --recover <id>`) plus `resetToBaseline` for `/reset`; `verify.ts` runs typecheck + temp build + launch-smoke asynchronously, then swaps `dist/cli.js` and `dist/prompts/` atomically; `orchestrator.ts` runs the flow (snapshot → agent edit → verify → content-level diff consent → swap → restart prompt). The `--recover` CLI flag and a cautious post-evolve startup hint live in `src/cli.ts`.
- `src/plan-mode.ts` supports agent/plan modes, creates plan artifact paths under `.furnace/plans/`, injects plan-mode system guidance, and renders saved plan artifacts/actions.
- `src/tasks/manager.ts` runs delegated subagent task groups in parallel, supports foreground/background promotion, records recent task status, and propagates task updates to the UI. Backgrounded task groups release the parent turn immediately; completion results are injected later through a hidden queued prompt.
- `src/skills/*` discovers skills from project/user/plugin roots, renders skill guidance, loads explicit skills, and can create managed project/user skill files.
- `src/custom-commands/*` loads reusable slash-command templates from `.furnace/commands` and `~/.furnace/commands`; project commands override global commands.
- `src/preferences.ts` loads/saves global and project preferences for model, model settings, theme, typing indicator style/blink, notifications, status line, and skill paths.
- `src/utils/images.ts` supports local/remote image attachments for multimodal user messages.

## Current CLI / UX Surface

- Headless prompt mode: `furnace -p "prompt"` or positional prompt arguments.
- Piped stdin mode when stdin is not a TTY.
- Interactive Pi TUI by default.
- Session controls: new sessions by default, `--continue`, `--session <id>`, `/new`, `/resume`, `/history`.
- Forking: `/fork`, `/fork current`, `/clone`; forks appear under their parent in history while subagents stay hidden from normal recents.
- Output mode option: `--output-format text|json` for headless mode.
- Harness self-modification: `/evolve <request>` (interactive only), `/reset` to revert all evolve changes to the default harness, and `furnace --recover <id>` to roll back a single evolve.
- Shell completion command: `furnace completion <bash|zsh|fish>`.
- Interactive model picker with context, reasoning, and fast-routing settings.
- Theme picker previews hovered themes and restores the saved theme if browsing is abandoned.
- `/settings` supports typing indicator, typing blink, notifications, and status line fields.
- Status context display supports tokens, tokens+percent, percent-only, and off.
- Prompt queueing while an agent turn is running.
- `/login` lists provider key status, stores saved keys in `~/.furnace/auth.json`, and supports deleting saved keys from that file.
- Manual `/compact` disables input while compaction runs.
- Interrupt support through the TUI abort controller.
- Subagent task groups can run in the foreground or be promoted/backgrounded.
- Multiple images can be attached to one prompt with `[Image #N]` tokens.

## Coding Standards

- Keep modules narrowly scoped and named by responsibility.
- Do not put provider-specific logic in the TUI.
- Do not let tools bypass the permission engine.
- Treat session entries as append-only; branch/fork features should move active leaves or create forked sessions, not rewrite old entries.
- Preserve assistant tool-call and tool-result pairings when changing transcript/model-message transforms.
- Preserve multimodal ordering for `[Image #N]` tokens and image blocks.
- Keep context compression deterministic and reversible: compress model-facing output, but store the full original under `.furnace/context-store/` when content is omitted.
- Keep empty placeholder sessions out of user-visible history.
- Keep subagent sessions out of normal history unless a feature explicitly surfaces them.
- Keep user-facing terminal output concise.
- Use structured file tools and `edit` patches for repository changes where possible.
- Add or update tests around agent loop behavior, tool execution, permission decisions, transcript replay, compaction, skills, plan mode, sessions/forks, and UI-adjacent command behavior when changing those areas.

## Safety Defaults

- Deny reading secret-like files by default, including `.env` and `.env.*`, while allowing `.env.example`.
- Ask before write/edit/bash/skill-management operations unless a session grant permits them.
- Scope file writes to the workspace unless an external path is explicitly requested and approved.
- Never run destructive git or filesystem commands without explicit approval.
- Compress large command/tool outputs before model replay and preserve full originals separately under `.furnace/context-store/`.
- In plan mode, keep implementation locked down: only the active plan artifact can be written/edited, and only safe read-only shell commands are allowed.
- Do not request or print secrets.
- Do not modify `.git/`, secret files, or local SQLite stores unless the user explicitly asks for that exact operation. The one product exception is Furnace's local `.git/info/exclude` entry for `.furnace/` runtime state.

## Documentation Expectations

- Keep `README.md` narrative and user-facing.
- Keep `AGENTS.md` imperative and agent-facing.
- Update docs in the same change that introduces or changes user-visible behavior.
- Prefer exact commands over vague descriptions.
- Do not reference deleted docs or planned features as current.
- Important docs currently live in:
  - `docs/tools.md`
  - `docs/skills.md`
  - `docs/session-management.md`
  - `docs/forking-and-branching.md`
  - `docs/compaction.md`
  - `docs/headroom-lite.md`
  - `docs/image-support.md`
  - `docs/clipboard-paste-images.md`
  - `docs/delegation-subagents.md`
  - `docs/interaction-model.md`
  - `docs/plan.md`
  - `docs/design-choices.md`

## Watch List

- Interactive orchestration is now split across `interactive-session-controller.ts` and focused helper modules. Keep new command/session/task logic in those focused modules rather than growing `src/cli.ts` again.
- The runtime is more separated from the UI, but `interactive-session-controller.ts` still coordinates many concerns for modes, tasks, permissions, compaction, slash commands, preferences, and UI callbacks.
- Provider adapters support OpenRouter, Anthropic's native API, and custom OpenAI-compatible endpoints; keep provider-specific serialization outside the TUI and agent loop.
- Sandboxing is permission-gate based. There is no OS/container sandbox adapter yet.
- JSON/headless output exists, but the event stream is not yet exposed as a stable public JSON/RPC/SDK interface.
- The pi-based TUI is featureful; watch for regressions around focus management, autocomplete scopes, queue controls, settings panels, task panels, and layout.
- Web search/fetch are MCP-style HTTP integrations with bounded output; provider configuration, error surfacing, and tests should stay current as those services change.
- Skills load from many local/plugin roots. Be careful about duplicate names, disabled model invocation, and never treating managed/plugin cache skill roots as writable.
- File stale-write protection depends on read receipts/snapshots. Preserve this when changing `read`, `write`, `edit`, or session persistence.
- Plan artifacts live under `.furnace/plans/`.

## Useful Comparisons

- Pi: minimal TypeScript harness with extension-first design.
- OpenCode: client/server-style architecture with TUI as one client.
- Headroom: content-aware compression, CCR-style retrieval handles, and request-local transforms for oversized tool results.
- Codex CLI: Rust implementation with strong sandboxing and a reusable core.
- Claude Code: product model with one engine across terminal, IDE, SDK, hooks, skills, and background agents.

When adopting or adapting behavior from another harness, including Pi, OpenCode, Hermes Agent, Codex CLI, or Claude Code, document the source and Furnace-specific adaptation in `docs/design-choices.md`.

When researching local reference repos, prefer the checked-out clones over memory and record inspected commit hashes in reports. Pull with `git pull --ff-only` first when practical.
