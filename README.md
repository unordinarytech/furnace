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

## Why Furnace?

Coding agents become more useful when the harness around them is built for actual projects. Long sessions need history. Tool calls need guardrails. Large repositories need context management. Parallel work needs a way to come back without losing state.

Furnace is built to make that loop manageable. It helps you:

- Work inside a keyboard-first terminal UI instead of a raw prompt loop
- Resume, fork, pin, and continue local sessions from `.furnace/`
- Approve risky file, edit, shell, and skill-management actions before they run
- Switch between supported providers and browse model catalogs from the TUI
- Use plan mode, subagents, skills, image input, and repository indexing without leaving the CLI
- Run one-shot headless prompts when you want automation instead of an interactive session

## How it works

At a high level, Furnace follows a simple loop:

1. Start Furnace in a repository with `furnace`.
2. Choose a provider and model through `/login` or environment variables.
3. Furnace opens or creates a local workspace session under `.furnace/`.
4. Your prompt is projected into provider messages with repository and session context.
5. The selected provider streams model output and tool calls back to Furnace.
6. Tool calls pass through typed handlers and permission gates before changing files or running commands.
7. Messages, tool results, usage, compactions, forks, and task results are saved so the session can continue later.

The result is a local control layer for agentic coding: the agent can explore, edit, test, delegate, and summarize while Furnace keeps the terminal UI, state, permissions, and history organized.

## Features

<table>
  <tr>
    <td width="34%">
      <h3>Product-grade TUI</h3>
      <p>Use a dedicated terminal interface with layouts, status line controls, model selection, pinned chats, task status, and focused input flows.</p>
    </td>
    <td width="66%">
      <img src="docs/assets/furnace-screenshot.jpeg" alt="Furnace terminal interface" />
    </td>
  </tr>
  <tr>
    <td width="34%">
      <h3>Real tools with guardrails</h3>
      <p>Give the agent typed file, search, edit, shell, todo, question, web, skill, and task tools while keeping mutating actions behind permission checks.</p>
    </td>
    <td width="66%">
      Read/search/question/todo/task/skill/web tools are allowed by default. Write, edit, shell, and skill-management calls ask before they run.
    </td>
  </tr>
  <tr>
    <td width="34%">
      <h3>Durable sessions</h3>
      <p>Keep conversations, tool calls, usage, forks, compactions, and project state in local SQLite storage so agent work can continue across runs.</p>
    </td>
    <td width="66%">
      Sessions are stored per repository in <code>.furnace/</code>. Global preferences, provider credentials, and usage summaries live under <code>~/.furnace</code>.
    </td>
  </tr>
  <tr>
    <td width="34%">
      <h3>Beyond single-agent chat</h3>
      <p>Use plan mode for scoped research, subagents for parallel child tasks, skills for reusable instructions, image input for multimodal work, and headless mode for scripts.</p>
    </td>
    <td width="66%">
      Furnace supports both interactive sessions and <code>-p</code> prompts, so the same harness works for active coding, repository analysis, and automation.
    </td>
  </tr>
</table>

## Supported Providers

Furnace supports built-in providers plus custom OpenAI-compatible endpoints:

<p>
  <code>openrouter</code> |
  <code>openai</code> |
  <code>anthropic</code> |
  <code>deepseek</code> |
  <code>glm</code> |
  <code>custom providers</code>
</p>

Use `/login` to save a provider key interactively, or configure keys with environment variables such as `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, and `GLM_API_KEY`.

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

