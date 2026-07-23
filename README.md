<div align="center">

# Furnace

**A terminal-first coding agent built for real repository work**

[![npm](https://img.shields.io/npm/v/cook-furnace)](https://www.npmjs.com/package/cook-furnace)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Issues](https://img.shields.io/github/issues/amoreX/furnace)](https://github.com/amoreX/furnace/issues)

Furnace is a local coding-agent CLI with a real TUI, typed tools, permission gates, resumable sessions, provider switching, and both interactive and headless workflows.

<img src="docs/assets/furnace-screenshot.jpeg" alt="Furnace terminal UI showing the prompt, status line, and active model" width="100%" />

</div>

---

## What is Furnace?

Furnace is a from-scratch harness for agentic coding in the terminal. It gives an AI coding agent a focused workspace with repository context, local session history, model controls, tool execution, permissions, and a terminal UI designed for long-running implementation work.

The model still does the coding. Furnace provides the runtime around it: provider adapters, message projection, typed file/search/shell/web tools, permission checks, plan mode, subagents, compaction, usage tracking, and a persistent session store. Instead of treating every prompt as disposable, Furnace turns agent work into an ongoing local workflow.

## Features

<table>
  <tr>
    <td width="34%">
      <h3>Headroom for long tool-heavy sessions</h3>
    </td>
    <td width="66%">
      Furnace includes Headroom request compression for large tool results. Big reads, searches, and command outputs are shortened before they hit the model, while the full omitted content remains locally retrievable when the agent actually needs it.
    </td>
  </tr>
  <tr>
    <td width="34%">
      <h3>Graph-based conversations and forks</h3>
    </td>
    <td width="66%">
      Sessions are stored as a graph, not a flat transcript. You can resume old work, fork from the current point, fork from an earlier prompt, clone a conversation tip, and keep alternate attempts without losing the path that got you there.
    </td>
  </tr>
  <tr>
    <td width="34%">
      <h3>Built-in workflows for real repositories</h3>
    </td>
    <td width="66%">
      Furnace ships the daily agent ergonomics people keep rebuilding in every harness: slash commands, <code>/stfu</code> for minimal responses, <code>/caveman</code> for blunt doc-less interaction, <code>/init</code> to index an existing repository, plan mode, image input, usage tracking, undo, model controls, and permission management.
    </td>
  </tr>
  <tr>
    <td width="34%">
      <h3>Local evolve that survives updates</h3>
    </td>
    <td width="66%">
      <code>/evolve</code> lets Furnace modify its own harness locally, verify the change, and keep that evolved behavior in place. When Furnace updates, <code>/evolve-merge</code> can reapply those local changes onto the new version instead of throwing them away.
    </td>
  </tr>
  <tr>
    <td width="34%">
      <h3>Pinned chats for multitasking</h3>
    </td>
    <td width="66%">
      Pinned chats keep multiple active threads close at hand. You can pin work, switch between sessions, watch active subagents continue thinking, and multitask inside one terminal instead of juggling separate harness windows.
    </td>
  </tr>
  <tr>
    <td width="34%">
      <h3>The good parts without the baggage</h3>
    </td>
    <td width="66%">
      Furnace is intentionally stripped down around what actually helps coding agents work: a real TUI, local state, typed tools, permissions, context management, forks, skills, subagents, and headless mode. It keeps the useful parts of modern agent harnesses and removes the ceremony that slows them down.
    </td>
  </tr>
</table>

## Install

Requirements:

- Node.js 22.x
- Git
- A provider API key configured through `/login` or environment variables

Run Furnace once through `npx`:

```bash
npx cook-furnace@latest
```

The first run installs Furnace into your user account and creates the persistent `furnace` command. It does not require administrator access or a global npm install.

On Windows, Furnace adds `%LOCALAPPDATA%\Furnace\bin` to your User PATH. On macOS and Linux it uses `~/.local/bin` and adds that directory to your active shell profile only when needed. Reopen the terminal if Furnace reports that PATH changed.

Update later with:

```bash
furnace update
```

The npm package is `cook-furnace`; the installed command is `furnace`.

## Quick start

Start the TUI from a repository:

```bash
cd ~/your-project
furnace
```

Then run `/login` to choose a provider and save an API key.

Run a one-shot prompt:

```bash
furnace -p "Summarize this repository"
```

Run from source:

```bash
npm install
npm run dev
```

Build the compiled CLI:

```bash
npm run build
npm run start -- --help
```

## Documentation

| Document | Start here when you need |
| --- | --- |
| [DOCS.md](DOCS.md) | Architecture and system documentation index. |
| [docs/architecture/overview.md](docs/architecture/overview.md) | Runtime layers, request flow, and ownership boundaries. |
| [docs/systems/tools-and-permissions.md](docs/systems/tools-and-permissions.md) | Tool registration, execution, approvals, and safety rules. |
| [docs/systems/context-management.md](docs/systems/context-management.md) | Request compression, retrieval artifacts, compaction, and overflow handling. |
| [docs/systems/extensions-and-subagents.md](docs/systems/extensions-and-subagents.md) | Skills, custom commands, delegated tasks, and child sessions. |
| [CHANGELOG.md](CHANGELOG.md) | Release history. |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Contribution guidance. |

## Status

Furnace is early, but it is already usable as a local coding-agent CLI with interactive and headless modes. Expect fast iteration, and please open an issue if something feels off.

## License

MIT License. See [LICENSE](LICENSE).

