# Interfaces

> Furnace exposes one runtime through an interactive TUI, headless text or JSON output, and piped input.

## Overview

The interactive interface is an Ink application backed by local Pi-compatible terminal components. It renders transcripts, streaming text, approvals, questions, settings, tasks, autocomplete, and status without owning agent logic.

Headless mode writes plain text or JSON and uses the same session controller and agent loop. Piped input follows the same non-interactive path.

## How It Works

1. The CLI selects an interface from TTY state and command-line options.
2. The session controller emits updates through the `FurnaceTerminal` contract.
3. `src/ui/pi-terminal.ts` maps that contract to interactive component state.
4. `src/ui/plain-output.ts` renders non-interactive output.
5. Prompt input is parsed as a built-in command, custom command, skill command, queued prompt, or normal user message.
6. Image paths, URLs, and clipboard images become labeled attachments such as `[Image #1]`.

The interactive terminal supports live theme and layout switching. Layouts change structure; themes provide colors, spacing tokens, typography, and border styles.

## Key Paths

| Path | Responsibility |
| --- | --- |
| `src/ui/terminal-types.ts` | Interface contract shared with the controller |
| `src/ui/pi-terminal.ts` | Interactive terminal assembly and state |
| `src/ui/pi/` | Interactive components, layouts, editor frame, and theme adapter |
| `src/ui/themes/` | Furnace theme definitions |
| `src/ui/plain-output.ts` | Headless text rendering |
| `src/ui/streaming.ts` | Streaming preview helpers |
| `src/ui/session-terminal-bridge.ts` | Isolates background-session UI updates |
| `src/commands/builtins.ts` | Built-in slash-command definitions and parsing |
| `src/commands/autocomplete.ts` | Slash, skill, and custom-command completion |
| `src/prompt-queue.ts` | Prompts queued while a turn is running |
| `src/preferences.ts` | Saved model, theme, layout, status, and interaction settings |
| `src/utils/images.ts` | Image validation and loading |
| `src/utils/clipboard.ts` | Platform clipboard image extraction |

## Invariants

- Runtime and provider code must not import interactive components.
- Background sessions must not overwrite the visible session's state.
- Prompt queues preserve submission order.
- Autocomplete must distinguish command names from command arguments.
- Image token order must match multimodal content-block order.
- Theme browsing must restore the saved theme when cancelled.
- Focus, cursor, approval, and question states must survive normal rerenders.

## Changing This Area

- Change terminal behavior through the `FurnaceTerminal` contract when headless parity matters.
- Keep new command definitions in `src/commands/`, not in UI components.
- Add component-level tests under `test/ui/`.
- Test narrow terminal widths and empty, streaming, tool, error, and approval states.
- Smoke-test interactive startup and `npm run start -- --help`.
