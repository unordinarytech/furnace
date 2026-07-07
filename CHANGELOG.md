# Changelog

All notable changes to Furnace will be documented in this file.

This project uses semantic versioning for public releases. During early releases, breaking changes may still happen between minor versions.

## [0.1.0] - 2026-07-07

### Added

- Interactive terminal coding-agent CLI.
- Headless prompt mode with text and JSON output.
- OpenRouter chat completions with streamed output and tool calls.
- Local SQLite session history under `.furnace/furnace.sqlite`.
- Session resume, continue, fork, and clone flows.
- Typed filesystem, search, edit, shell, todo, question, skill, web, compression, and subagent tools.
- Permission gates for write, edit, shell, and skill-management operations.
- Plan mode with restricted side effects and durable plan artifacts.
- Context compaction and large tool-output compression with retrievable local artifacts.
- Multimodal image attachment support.
- Project/user/plugin skill discovery and explicit skill loading.
- Subagent task delegation with foreground and background task groups.
- Configurable model settings, themes, preferences, status line, and typing indicators.

### Notes

- Furnace is currently OpenRouter-first.
- Furnace uses permission gates, not an OS/container sandbox.
- Public package/release automation is still being hardened during early releases.
