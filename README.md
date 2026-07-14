# Furnace

Furnace is a terminal-first agentic coding harness built from scratch in TypeScript. It runs an AI coding loop against real repositories with streamed model output, typed tools, permission gates, local SQLite session history, context compaction, multimodal image input, skills, subagents, and a Pi-based TUI.

The project is still early, but it is no longer just a plan: the current codebase is a usable local coding-agent CLI with interactive and headless modes.

## What Furnace Does Today

- Runs interactive agent sessions in a terminal UI.
- Runs one-shot/headless prompts with text or JSON output.
- Streams chat completions and tool calls through OpenRouter, Anthropic, and custom OpenAI-compatible providers.
- Persists local sessions in SQLite at `.furnace/furnace.sqlite`.
- Replays sessions as append-only active-leaf histories with fork support.
- Reads, searches, edits, writes files, and runs bounded shell commands through typed tools.
- Uses a permission engine for risky tools.
- Tracks file reads and warns on stale writes/edits.
- Compacts long conversations with model-assisted summaries and deterministic fallback.
- Compresses oversized tool output into retrievable local artifacts.
- Supports multiple image attachments in a single prompt.
- Supports project/user/plugin skills and reusable custom slash commands.
- Delegates independent work to subagent task groups.
- Provides plan mode for implementation planning before mutating code.
- Can create a compact local repository index for faster project orientation.
- Provides six structural UI layouts plus configurable themes, status line fields, model settings, and typing indicators.

## Requirements

- Node.js 22.x.
- A provider API key configured through `/login` or an environment variable.

## Install And Update

Install the published CLI from npm:

```bash
npm install -g cook-furnace
```

Update an existing global install to the latest published version:

```bash
npm install -g cook-furnace@latest
```

Check the installed version:

```bash
furnace --version
```

The npm package is `cook-furnace`, but the installed command is `furnace`.

## Quickstart

Start Furnace, then type `/login` to choose a provider and save an API key:

```bash
furnace
```

Run from a source checkout:

```bash
npm install
npm run dev
```

Run a single prompt without opening the TUI:

```bash
npm run dev -- -p "Reply with exactly: ok"
```

Build and run the compiled CLI:

```bash
npm run build
npm run start -- --help
```

Run verification:

```bash
npm run verify
```

`npm run verify` is the pre-push check. It runs the pinned Node check, TypeScript typecheck, the full test/build script, and the npm package dry run, then prints whether each step passed.

Run individual checks when you only need one part:

```bash
npm run typecheck
npm test
npm run pack:dry-run
```

## CLI Usage

Interactive mode starts by default:

```bash
npm run dev
```

Headless prompt mode:

```bash
npm run dev -- -p "Summarize this repository"
```

Continue or resume sessions:

```bash
npm run dev -- --continue
npm run dev -- --session <session-id>
```

Use JSON output for headless mode:

```bash
npm run dev -- -p "List changed files" --output-format json
```

Generate shell completions:

```bash
npm run dev -- completion bash
npm run dev -- completion zsh
npm run dev -- completion fish
```

## Interactive Commands

Built-in slash commands include:

| Command | Purpose |
| --- | --- |
| `/new` | Start a fresh conversation. |
| `/resume`, `/history` | Browse saved conversations. |
| `/fork [current\|prompt-preview]` | Fork the current conversation or a prior user prompt. |
| `/clone` | Fork from the current conversation tip. |
| `/image <path\|url>` | Attach an image to the next message. |
| `/model` | Browse/select model and configure context, max output, reasoning, and fast routing. |
| `/theme [name]` | Select a theme; browsing previews hovered themes. |
| `/settings`, `/prefs` | Configure UI/status preferences. |
| `/evolve <what to change>` | Modify the Furnace harness itself, with verification and recovery. |
| `/reset` | Reset the Furnace harness to its default state (undo all evolve changes). |
| `/plan [prompt]` | Switch to plan mode. |
| `/agent` or `/mode agent` | Switch back to normal agent mode. |
| `/tasks` | Show active subagents. |
| `/compact [focus]` | Manually summarize old context. |
| `/init` | Learn the current repo/folder and write `.furnace/repo-index.md`. |
| `/skills list` | List discovered skills. |
| `/skills view <name>` | View a skill. |
| `/skills reload` | Reload skill discovery. |
| `/permissions` | View/clear conversation approvals. |
| `/status` | Show session/model/mode/context status. |
| `/export [json] [path]` | Export the conversation. |
| `/diff` | Show files changed this session. |
| `/undo` | Revert the most recent file-changing tool call. |
| `/copy` | Copy the last assistant response. |
| `/cost` | Show token/cost usage estimates. |
| `/editor` | Compose a message in `$EDITOR`. |
| `/lofi` | Toggle lofi mode. |
| `/clear` | Clear the conversation display. |
| `/exit`, `/quit` | Exit Furnace. |

Custom slash commands can live under `.furnace/commands` in the project or `~/.furnace/commands` globally.

## Settings

`/settings` opens a keyboard-driven preferences panel. Current settings include:

- Interface layout:
  - `Classic`: the original banner, transcript, composer, and footer stack
  - `Focus`: minimal chrome and a compact single-line rail
  - `Forge`: a wide two-column command center with a live session sidecar
  - `Console`: an operator layout with top telemetry and a bottom command deck
  - `Notebook`: an editorial conversation log with labelled entries
  - `Signal`: a broadcast-style transmission desk
- Typing indicator: block, underscore, or bar.
- Typing blink: off/on, applied to any indicator style.
- Notifications on/off.
- Status line fields:
  - app name
  - cwd
  - title
  - context: on, token+percent, percent-only, or off
  - mode
  - window
  - theme
  - model
  - reasoning
  - fast routing
  - fork parent

`Tab` or `Enter` cycles values.

`/model` opens model-specific settings. Furnace defaults model turns to `8192` max output tokens to avoid unexpectedly large provider reservations; advanced users can change that cap from the model editor.

## Evolving the harness

Furnace can modify its own source. Ask for a harness change in plain language
("put cost usage on the statusline", "add a monochrome green theme", "make the
thinking text say huzzing") and the agent routes it into the evolve flow, or run
it explicitly:

```bash
/evolve add cost usage to the statusline
```

An evolve run:

1. Creates a **recovery point** — a git snapshot plus a copy of the current
   known-good `dist/`.
2. Edits the Furnace source for your request.
3. Verifies with a typecheck, an isolated build to a temp location, and a launch
   check that runs the new bundle in a subprocess (this catches a change that
   compiles but crashes on startup). The live `dist/` is only swapped after all
   of these pass, so a bad change never bricks the `furnace` command. Verification
   runs asynchronously and does not freeze the UI.
4. Shows you the diff and asks you to approve it before it goes live.
5. Asks you to **restart Furnace** for the change to take effect.

If a restart lands on a broken harness, roll back:

```bash
furnace --recover <id>
```

Recovery restores the previous known-good `dist/` without rebuilding. In the rare
case the bundle will not launch at all, rebuild from source with `npm run build`
in the Furnace checkout.

Notes and current limits:

- Evolve requires running Furnace from its own source checkout (a git repo with
  `src/`); an npm-global install without source reports that evolve is
  unavailable.
- The evolve edit turn runs with broad session permissions over the Furnace
  root; the diff-review step is your control. It can read `~/.furnace/auth.json`,
  so review the diff before approving.
- Recovery points accumulate git tags under `refs/tags/furnace-recovery/`.

## Images

Interactive sessions can attach one or more images before sending a prompt:

```bash
> /image screenshot-a.png
> /image screenshot-b.png
> Compare [Image #1] and [Image #2]
```

Furnace supports local JPEG, PNG, GIF, and WebP files, plus remote image URLs. Local images are validated, stored with the session, and sent as multimodal message content when the selected model supports image input. See [docs/image-support.md](docs/image-support.md).

## Tools

The built-in model tools are:

- `read`, `ls`, `find`, `glob`, `grep`
- `write`, `edit`
- `bash`
- `ask_question`
- `todoread`, `todowrite`
- `task`, `task_status`
- `skill`, `skill_manage`
- `websearch`, `webfetch`
- `context_retrieve`

Each tool has a schema, permission metadata, execution logic, and bounded model-facing output. See [docs/tools.md](docs/tools.md).

## Repository Index

In interactive mode, Furnace can offer to initialize a git workspace by creating `.furnace/repo-index.md`. The prompt appears only when an API key is configured, the current folder is inside a git repo, and no index exists yet.

The index is a compact map for the agent, not generated docs. It uses fixed sections like `Project Shape`, `Key Directories`, and `File Dictionary`, and should stay under 250 lines when possible. Furnace also writes `.furnace/repo-index.meta.json` with small metadata such as generation time, git head, package name, and indexed file count.

Use `/init` to regenerate the index manually. Furnace does not auto-regenerate it or warn just because it is old; the main agent is instructed to read it before broad repo exploration and update only relevant parts when meaningful repo-level structure changes or is discovered.

Current session behavior:

- New chats are hidden from history until they contain useful content.
- `/resume` lists normal sessions and forked sessions.
- Forks are first-level branches from an original session.
- `/fork` opens a picker of valid fork points.
- `/fork current` and `/clone` fork through the current active leaf.
- Subagent sessions are related to their parent but hidden from normal history.

See [docs/session-management.md](docs/session-management.md) and [docs/forking-and-branching.md](docs/forking-and-branching.md).

## Safety Model

Furnace is designed to be useful on real repositories without requiring blind trust.

Local data storage:

- Conversation history, tool calls, tool results, todo state, fork metadata, file-read tracking, and image attachment metadata are stored in `.furnace/furnace.sqlite` for the current workspace.
- Large compressed tool-output originals are stored separately under `.furnace/context-store/`.
- `.furnace/` is intended to be local-only state. Furnace excludes it through local git excludes when possible, and this repo also ignores it in `.gitignore`.

Defaults:

- Low-risk read/search/question/task/todo/web tools are allowed by default.
- `write`, `edit`, `bash`, and `skill_manage` ask by default.
- `.env` and `.env.*` reads are denied; `.env.example` is allowed.
- Writes outside the workspace require explicit external paths and approval.
- Tool permissions are session-scoped and visible through `/permissions`.
- Plan mode denies implementation side effects except the active plan artifact and safe read-only shell commands.
- Large tool outputs are bounded before model replay and preserved locally for retrieval.

Furnace currently uses permission gates rather than an OS/container sandbox.

## Architecture

Furnace is organized around a reusable agent runtime with the TUI as one surface.

```mermaid
flowchart TD
  CLI[CLI Entrypoint] --> Controller[Session/Mode Controller]
  Controller --> Runtime[Agent Turn Loop]
  Runtime --> Provider[OpenRouter Provider]
  Runtime --> Tools[Tool Registry]
  Runtime --> Permissions[Permission Engine]
  Controller --> Sessions[SQLite Session Store]
  Controller --> Compaction[Session Compaction]
  Tools --> Compression[Headroom-lite Compression]
  Controller --> TUI[Pi Terminal UI]
  Controller --> Headless[Headless Text/JSON Output]
  Controller --> Skills[Skills and Custom Commands]
  Controller --> Subagents[Task/Subagent Manager]
```

## Documentation

Useful docs:

- [Tools](docs/tools.md)
- [Skills](docs/skills.md)
- [Session management](docs/session-management.md)
- [Forking and branching](docs/forking-and-branching.md)
- [Compaction](docs/compaction.md)
- [Headroom-lite](docs/headroom-lite.md)
- [Image support](docs/image-support.md)
- [Clipboard image paste](docs/clipboard-paste-images.md)
- [Delegation and subagents](docs/delegation-subagents.md)
- [Interaction model](docs/interaction-model.md)
- [Plan mode](docs/plan.md)
- [Design choices](docs/design-choices.md)

