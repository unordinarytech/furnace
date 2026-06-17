# Furnace Roadmap

Furnace should be built in phases. Each phase should leave the project in a usable state, even if the feature set is narrow.

## Phase 0: Project Skeleton

Create the basic repository structure and development workflow.

### Scope

- Initialize a TypeScript package.
- Add formatting, linting, typechecking, and tests.
- Create the initial CLI entrypoint.
- Define package boundaries for runtime, CLI, TUI, tools, providers, config, and sessions.
- Add basic project docs and contribution instructions.

### Validation Criteria

- `npm install` completes cleanly.
- `npm run typecheck` passes.
- `npm test` runs at least one smoke test.
- `furnace --help` prints CLI usage.
- The package layout makes the runtime importable without importing the TUI.

## Phase 1: Runtime Event Protocol

Define the contract that every interface will consume.

### Scope

- Create typed events for user messages, assistant text deltas, tool calls, tool results, approvals, errors, and session lifecycle.
- Implement an async event stream abstraction.
- Add event serialization for JSON output and session logs.
- Create a minimal headless mode that echoes a fake assistant response through the event stream.

### Validation Criteria

- A headless command can emit newline-delimited JSON events.
- Event payloads validate against schemas.
- Tests can replay a captured event stream deterministically.
- TUI-specific types are not referenced by the runtime package.

## Phase 2: Provider Layer

Connect the runtime to real LLM APIs through a normalized interface.

### Scope

- Add provider interface for streaming responses and tool calls.
- Implement Anthropic and OpenAI adapters.
- Add model config, API key loading, retries, timeouts, and usage metadata.
- Normalize provider-specific tool-call formats into internal events.

### Validation Criteria

- A prompt streams assistant text from at least one real provider.
- Provider adapters can be tested with fixture streams.
- API keys are never written to transcripts.
- Transient provider failures retry within configured limits.
- Unsupported model/provider combinations fail with actionable errors.

## Phase 3: Agent Loop

Implement the core agentic loop.

### Scope

- Assemble prompts, instructions, conversation history, and available tools.
- Stream model output.
- Detect tool calls.
- Execute tool calls through the tool registry.
- Append tool results and continue until the model produces a final answer.
- Add max-step limits, cancellation, and interruption handling.

### Validation Criteria

- A model can call a mock tool and receive its result in a follow-up turn.
- The loop stops at the configured max-step limit.
- Cancellation records a complete transcript without dangling tool calls.
- Errors become structured events instead of crashing the process.
- Unit tests cover success, tool failure, provider failure, and max-step behavior.

## Phase 4: Core Coding Tools

Add the first useful tool set.

### Scope

- Implement `read`, `write`, `edit`, `bash`, `glob`, and `grep`.
- Add output truncation for large files and command output.
- Track working directory, environment, and command exit status.
- Return structured tool results that are useful to both the model and UI.

### Validation Criteria

- Tools cannot access paths outside the workspace unless policy allows it.
- `edit` fails cleanly when the target snippet is ambiguous.
- `bash` captures stdout, stderr, exit code, duration, and timeout.
- Large outputs are truncated with clear metadata.
- Tests cover path traversal, missing files, ambiguous edits, command failure, and timeout.

## Phase 5: Permissions

Make tool execution safe enough for real repositories.

### Scope

- Add permission decisions: `allow`, `ask`, and `deny`.
- Match rules by tool name, file path, and shell command pattern.
- Add session-scoped approvals.
- Deny secret-like files by default.
- Add approval request events for TUI and headless clients.

### Validation Criteria

- Edit and bash tools request approval by default.
- Denied tools do not execute.
- Session approvals apply only to matching future requests.
- `.env` and `.env.*` reads are denied by default, while `.env.example` is allowed.
- Permission decisions are recorded in the transcript.

## Phase 6: Session Persistence

Make sessions resumable and debuggable.

### Scope

- Store sessions as JSONL event logs.
- Add session metadata: id, name, cwd, created time, updated time, model, and status.
- Implement resume-last and resume-by-id.
- Add transcript replay for debugging.

### Validation Criteria

- A completed session can be resumed and continued.
- A replayed transcript reconstructs the same visible conversation.
- Corrupt session files fail gracefully with a useful error.
- Session files do not contain secrets from config or environment.

## Phase 7: Terminal UI

Build the interactive CLI experience on top of the runtime.

### Scope

- Add a streaming chat view.
- Add multiline input.
- Add approval prompts.
- Add visible tool-call progress and results.
- Add keyboard shortcuts for interrupt, submit, quit, and model selection.
- Add markdown rendering and basic code highlighting.

### Validation Criteria

- The TUI can run the same prompts as headless mode.
- Streaming text updates without flicker in common terminals.
- Approval prompts block execution until answered.
- Interrupting a run leaves the terminal usable and the transcript complete.
- Basic flows work in macOS Terminal, iTerm2, and VS Code/Cursor integrated terminal.

## Phase 8: Config And Project Context

Let users customize behavior without changing code.

### Scope

- Add global and project config files.
- Load `AGENTS.md` or equivalent instruction files from the project.
- Configure default provider, model, permission rules, shell path, and session directory.
- Add project trust before loading project-local executable extensions.

### Validation Criteria

- Project config overrides global config predictably.
- Invalid config reports schema errors with file paths.
- Project instructions are included in the model context.
- Untrusted project executable resources are ignored.
- Config values are visible through a diagnostic command.

## Phase 9: Extensibility

Open the harness to custom workflows.

### Scope

- Add hooks before and after tool execution.
- Add custom tool registration.
- Add markdown skills and prompt templates.
- Add plugin loading from trusted local paths.
- Add package-based extensions later.

### Validation Criteria

- A local plugin can register a new tool.
- A hook can block or rewrite a tool request.
- Skills can be invoked from the CLI.
- Plugin failures are isolated and reported clearly.
- Untrusted project plugins never execute.

## Phase 10: MCP And Subagents

Add broader integration and parallel work after the core is stable.

### Scope

- Add MCP client support for external tools.
- Add read-only and build agent modes.
- Add subagent sessions with isolated context.
- Add parent-child session navigation and summaries.

### Validation Criteria

- MCP tools follow the same permission path as built-in tools.
- Read-only agents cannot edit files or run unapproved commands.
- Subagents write separate transcripts.
- Parent sessions receive summaries, not uncontrolled full child transcripts.
- Parallel subagent failures do not corrupt the parent session.

## Phase 11: Sandboxing

Move from policy-only safety toward process-level isolation.

### Scope

- Add a Docker-based shell runner option.
- Add platform-native sandbox helpers later:
  - macOS Seatbelt.
  - Linux bubblewrap or Landlock.
  - Windows restricted token or AppContainer.
- Add network controls where supported.
- Add sandbox diagnostics.

### Validation Criteria

- Sandboxed commands cannot write outside approved roots.
- Network-disabled commands fail when attempting network access.
- Sandbox errors fail closed.
- Users can inspect the effective sandbox policy before execution.
- Non-sandboxed mode requires explicit opt-in.

## Phase 12: Polish And Distribution

Make the harness pleasant to install, use, and debug.

### Scope

- Package the CLI for npm.
- Add optional single-binary packaging after the API stabilizes.
- Add update checks only with clear opt-out.
- Add diagnostics, debug logs, and trace export.
- Add documentation for common workflows.

### Validation Criteria

- Fresh install works on macOS, Linux, and Windows or WSL.
- `furnace doctor` reports environment issues.
- Debug logs are useful without leaking secrets.
- Public docs cover install, auth, first run, config, permissions, tools, and troubleshooting.
- A new user can complete a simple edit-and-test workflow from the README.
