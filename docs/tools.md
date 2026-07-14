# Tools

Furnace tools are model-callable filesystem and shell primitives. The current workspace is the default path context, not a hard filesystem boundary. Each tool owns its model schema and runtime handler in one registry entry, then the agent loop passes only the schema portion to OpenRouter.

Current implementation lives in `src/tools/registry.ts`.

## Harness Provenance

Several tool-system choices were informed by other coding harnesses:

- Pi influenced the small primitive-tool shape, the decision to expose one edit primitive, and the multi-question terminal UX for `ask_question`.
- OpenCode influenced the web tooling shape, bounded tool-output behavior, allow/ask/deny permission model, pending question-request architecture, queued prompt manager behavior, and session-linked `task` tool direction. Furnace's `websearch`, `webfetch`, `.furnace/context-store/` previews, first approval layer, `ask_question` runtime shape, queued prompt UI, and task delegation spine follow that direction.
- Hermes Agent influenced file read deduplication, stale-write warnings, session-scoped broad approval, clarify-tool answer semantics, busy-input modes, richer tool history for debugging/resume, batch subagent fan-out, and grouped background completion. Furnace implements smaller versions of those ideas in the local TypeScript runtime and session store.

## Runtime Shape

Each tool is registered as:

```ts
type ToolDefinition = {
  type: "function"
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

type RegisteredTool = {
  definition: ToolDefinition
  execute: (args: unknown, context: ToolContext) => Promise<string>
}
```

The exported model-facing schema list is:

```ts
export const toolDefinitions = registeredTools.map((tool) => tool.definition)
```

Tool calls use OpenAI/OpenRouter-style function calling:

```ts
type ToolCallInput = {
  name: string
  arguments: string
}

type ToolExecution = {
  name: string
  content: string
}
```

`arguments` is a JSON string emitted by the model. The runtime parses it, executes the matching handler, truncates oversized output, persists the call/result into the active session, then returns a `tool` message to the model.

## Agent Loop

Tool execution is coordinated by `src/agent/loop.ts`.

Flow:

1. Send the current transcript plus `toolDefinitions` to OpenRouter.
2. If the assistant returns final text, end the turn.
3. If the assistant returns tool calls, append the assistant tool-call message to the in-memory transcript.
4. Persist each tool call as a `tool_call` session entry.
5. Execute each tool sequentially.
6. Persist each result as a `tool_result` session entry.
7. Append each result as a `role: "tool"` message with the matching `tool_call_id`.
8. Ask the model again.
9. Continue until the model returns a normal assistant response or the user interrupts the turn.

The TUI receives `onToolStart` and `onToolResult` callbacks so calls render inline in the conversation timeline:

```text
user
...

tools
> read path: "src/cli.ts"
ok read path: "src/cli.ts" -> 1|#!/usr/bin/env node

assistant
...
```

The persisted session path keeps the same sequence:

```text
message(user) -> tool_call(assistant) -> tool_result(tool) -> message(assistant)
```

## Path And Search Defaults

The current workspace is the default path context, not a hard filesystem boundary.

Path behavior:

- Relative paths resolve from the current workspace.
- Explicit absolute paths and parent paths are allowed when they are relevant to the user's request.
- Home paths beginning with `~/` resolve from the user's home directory.
- Omitting `path` means "use the current workspace" for tools that accept a path.
- `Desktop/file.py` means `<workspace>/Desktop/file.py`; use `~/Desktop/file.py` or `/Users/name/Desktop/file.py` for the user's actual Desktop.

Recursive search behavior:

- Default recursive `find`, `glob`, and `grep` skip noisy directories: `node_modules`, `.git`, and `.furnace`.
- That skip only applies when those directories are encountered incidentally during a broader search.
- If the user asks about one of those directories, or the agent otherwise needs it, pass it explicitly as `path`.

Examples:

```json
{ "query": "session" }
```

Searches from the current workspace and skips noisy directories.

```json
{ "path": ".git", "query": "reflog" }
```

Searches `.git` because it was explicitly provided.

```json
{ "path": "~/Desktop", "pattern": "Screen Recording" }
```

Searches outside the workspace because an explicit external path was provided.

## Safety Rules

Current safety behavior:

- Relative paths resolve from the current workspace.
- Explicit absolute paths and parent paths are allowed when they are relevant to the user's request.
- Reads of `.env` and `.env.*` are denied, except `.env.example`.
- Interactive sessions ask before `write`, `edit`, and `bash` tool calls. Denying a request blocks only that specific tool call.
- `ask_question` is allowed by default because it is a clarification tool, not a side-effecting operation.
- `skill` is allowed by default. It only loads local `SKILL.md` instructions into the model context.
- `skill_manage` asks by default because it creates or updates persistent agent instructions.
- `task` and `task_status` are allowed by default. Subagents inherit parent conversation permission grants, but ungranted side-effecting tools inside children still prompt normally.
- Child subagents receive the same tools as the parent except `task`, preventing recursive subagent creation.
- `write` refuses to overwrite existing files unless `overwrite: true`.
- Tool output is bounded to 2,000 lines and 50 KB before returning to the model.
- When tool output exceeds those limits, the full text is saved under `.furnace/tool-output/` and the model receives a head/tail preview plus the saved path.
- `read` output is capped at 200,000 characters before the general tool-output cap.
- `grep` skips files larger than 1 MB.
- `bash` starts in the workspace as its current directory, but can inspect or operate on explicit paths elsewhere.
- `bash` has a default 30 second timeout and a max 120 second timeout.
- `websearch` rejects raw provider responses larger than 256 KB.
- `webfetch` rejects raw response bodies larger than 5 MB.
- `read` tracks file size and mtime for each returned path/range within the active session. In real sessions this is stored in SQLite, so re-reading the same unchanged range after resume/restart returns an unchanged notice instead of repeating the file contents.
- `write` and `edit` warn when a file changed after Furnace last read it in the active session, including after resume/restart. Approval still happens before execution; stale warnings appear in the result after an approved modification.

Plan mode safety:

- Plan mode is enforced before normal conversation-scoped grants, so `Allow all tools for conversation` cannot bypass it.
- Plan mode allows read/search/web/question/subagent exploration.
- `write` and `edit` are allowed only for the active `.furnace/plans/YYYY-MM-DD_HHMMSS-<slug>.md` artifact.
- Mutating `bash` commands, `skill_manage`, commits, package installs, redirects, destructive filesystem commands, and unknown side-effecting tools are denied.
- Read-only `bash` commands such as `git status`, `git diff`, `rg`, `ls`, and `sed -n` are allowed for exploration.

Approval prompt choices:

- `Allow once`: approve only the current tool call.
- `Allow <tool> for conversation`: approve future calls of the same tool in the current conversation.
- `Allow all tools for conversation`: approve all future tool calls in the current conversation only.
- `Deny`: deny only the current tool call.

Use `/reset-perms` to clear permission grants for the current conversation.

`bash` is intentionally an escape hatch. The model prompt tells the agent to prefer structured tools before shell commands.

Queued prompt behavior:

- In the interactive TUI, prompts submitted while Furnace is busy are queued for the current conversation.
- Queued prompts render in a compact panel and can be selected.
- Press `e` on a selected queued prompt to remove it from the queue and restore it into the input for editing.
- Press `d` to remove it.
- Press Enter to promote it to run next. Furnace attempts to interrupt the current model request, but already-running tools may still finish until all tool execution supports abort signals.

## Built-In Tools

### `read`

Read a file. Relative paths resolve from the current workspace. Secret-like `.env` files are denied except `.env.example`.

Schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["path"],
  "properties": {
    "path": {
      "type": "string",
      "description": "Path to read. Relative paths resolve from the current workspace."
    },
    "offset": {
      "type": "number",
      "description": "Optional 1-based line offset."
    },
    "limit": {
      "type": "number",
      "description": "Optional number of lines to return."
    }
  }
}
```

Example:

```json
{
  "path": "src/cli.ts",
  "offset": 1,
  "limit": 40
}
```

Output format:

```text
1|#!/usr/bin/env node
2|
3|import { Command } from "commander"
```

Repeated unchanged read output:

```text
File unchanged since last read: src/cli.ts (lines 1-40).
Use the previously returned content unless you need a different line range.
```

### `ls`

List immediate files and directories. Relative paths resolve from the current workspace.

Schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "path": {
      "type": "string",
      "description": "Directory to list. Defaults to the current workspace."
    }
  }
}
```

Example:

```json
{
  "path": "src"
}
```

Output format:

```text
dir agent
file cli.ts
dir session
```

### `find`

Find files by case-insensitive path/name substring. Relative paths resolve from the current workspace.

Schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "path": {
      "type": "string",
      "description": "Directory to search. Defaults to the current workspace."
    },
    "query": {
      "type": "string",
      "description": "Optional case-insensitive substring to match against relative paths."
    },
    "maxResults": {
      "type": "number",
      "description": "Maximum results to return. Defaults to 100."
    }
  }
}
```

Example:

```json
{
  "query": "terminal",
  "maxResults": 20
}
```

Output format:

```text
src/ui/pi-terminal.ts
src/ui/terminal.ts
```

### `glob`

Find files by glob pattern. Relative paths resolve from the current workspace.

Schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["pattern"],
  "properties": {
    "pattern": {
      "type": "string",
      "description": "Glob pattern to match against displayed paths. Patterns without a slash also match filenames."
    },
    "path": {
      "type": "string",
      "description": "Directory to search. Defaults to the current workspace."
    },
    "maxResults": {
      "type": "number",
      "description": "Maximum results to return. Defaults to 100."
    }
  }
}
```

Example:

```json
{
  "pattern": "**/*.ts",
  "path": "src",
  "maxResults": 50
}
```

Output format:

```text
src/cli.ts
src/config.ts
src/session/store.ts
```

### `grep`

Search text files for a string or regular expression. Relative paths resolve from the current workspace.

Schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["pattern"],
  "properties": {
    "pattern": {
      "type": "string",
      "description": "Text or regex pattern to search for."
    },
    "path": {
      "type": "string",
      "description": "File or directory to search. Defaults to the current workspace."
    },
    "regex": {
      "type": "boolean",
      "description": "Treat pattern as a JavaScript regular expression. Defaults to false."
    },
    "maxResults": {
      "type": "number",
      "description": "Maximum matching lines to return. Defaults to 100."
    }
  }
}
```

Example:

```json
{
  "pattern": "runSingleTurn",
  "path": "src",
  "maxResults": 20
}
```

Output format:

```text
src/cli.ts:243:async function runSingleTurn(input: {
```

### `write`

Create or overwrite a file. Relative paths resolve from the current workspace.

Schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["path", "content"],
  "properties": {
    "path": {
      "type": "string",
      "description": "Path to write. Relative paths resolve from the current workspace."
    },
    "content": {
      "type": "string",
      "description": "Full file content to write."
    },
    "overwrite": {
      "type": "boolean",
      "description": "Whether to overwrite an existing file. Defaults to false."
    }
  }
}
```

Example:

```json
{
  "path": "notes/example.md",
  "content": "# Example\n",
  "overwrite": false
}
```

Output format:

```text
Wrote notes/example.md (10 bytes).
```

If Furnace previously read the file and it changed before this overwrite, the result starts with a warning:

```text
Warning: notes/example.md changed since Furnace last read it before this write. The requested modification was still applied; re-read/review if that change was not expected.
Wrote notes/example.md (10 bytes).
```

### `edit`

Apply a Furnace apply-patch envelope. This is the single edit primitive; there is no separate `apply_patch` tool.

Important: `edit` does not accept unified diff syntax. Do not pass patches that start with `--- file`, `+++ file`, or hunk headers like `@@ -1,3 +1,4 @@`. Use the Furnace envelope form below.

Schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["patch"],
  "properties": {
    "patch": {
      "type": "string",
      "description": "Patch envelope only: *** Begin Patch, then file operations like *** Update File: path, hunks with context/removal/addition lines, then *** End Patch. Unified diffs are invalid."
    }
  }
}
```

Example:

```json
{
  "patch": "*** Begin Patch\n*** Update File: src/example.ts\n@@\n-const value = 1\n+const value = 2\n*** End Patch"
}
```

Supported patch operations:

- `*** Add File: <path>`
- `*** Update File: <path>`
- `*** Delete File: <path>`

Output format:

```text
Updated src/example.ts (1 hunks)
```

`edit` performs the same stale-file check as `write` for updated or deleted files. Added files are not stale-checked because there is no previous file content to compare.

### `bash`

Escape hatch for running a shell command. The command starts in the workspace, but may inspect or operate on explicit paths elsewhere. Use only when file/search/edit primitives are insufficient.

Schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["command"],
  "properties": {
    "command": {
      "type": "string",
      "description": "Shell command to run."
    },
    "timeoutMs": {
      "type": "number",
      "description": "Timeout in milliseconds. Defaults to 30000, max 120000."
    }
  }
}
```

Example:

```json
{
  "command": "npm test",
  "timeoutMs": 120000
}
```

Output format:

```text
exit_code: 0
stdout:
...
stderr:
...
```

### `ask_question`

Ask the user one or more clarification questions when the task is vague or a decision has meaningful tradeoffs. The answer returns to the model as a normal tool result, so the agent can continue the same turn with the user's choices.

Use cases:

- Requirements are ambiguous and multiple valid implementations exist.
- The user needs to choose between mutually exclusive approaches.
- The agent needs a preference that cannot be inferred safely.

Do not use `ask_question` for low-stakes details where a sensible default is enough. When asking, include only concrete choices in `options`; do not add choices like `Let me specify`, `Type my own`, `Other`, `Skip`, or `Refuse`. Furnace already provides custom input and refusal controls in the UI.

Schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["questions"],
  "properties": {
    "questions": {
      "type": "array",
      "description": "One or more questions to ask before continuing.",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["id", "prompt", "options"],
        "properties": {
          "id": {
            "type": "string",
            "description": "Stable question id, for example scope or style."
          },
          "prompt": {
            "type": "string",
            "description": "The complete question to ask. Do not embed option numbers here."
          },
          "options": {
            "type": "array",
              "description": "Concrete available choices only. The UI also offers custom answer and refusal when enabled.",
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": ["id", "label"],
              "properties": {
                "id": {
                  "type": "string",
                  "description": "Stable option id."
                },
                "label": {
                  "type": "string",
                  "description": "Short option label shown to the user."
                },
                "description": {
                  "type": "string",
                  "description": "Optional one-line explanation of the option."
                }
              }
            }
          },
          "allowMultiple": {
            "type": "boolean",
            "description": "Allow selecting more than one option. Defaults to false."
          },
          "allowCustom": {
            "type": "boolean",
              "description": "Allow the user to type their own answer. Defaults to true. Use this instead of adding a 'let me specify' option."
          }
        }
      }
    }
  }
}
```

Example:

```json
{
  "questions": [
    {
      "id": "scope",
      "prompt": "Which version should I implement first?",
      "options": [
        {
          "id": "minimal",
          "label": "Minimal",
          "description": "Smallest useful version"
        },
        {
          "id": "complete",
          "label": "Complete",
          "description": "All requested behavior"
        }
      ]
    }
  ]
}
```

Output format:

```text
User answered the questions:
scope: user selected "Minimal"
```

The UI always offers `Refuse to answer` for each question. When `allowCustom` is enabled, it also offers a single custom-answer row. Refusal and custom answers are returned as answer data, not treated as tool failures.

### `skill`

Load a named local skill when the task matches the skill's description. Skill discovery scans local `SKILL.md` files under project roots like `.furnace/skills` and `.agents/skills`, user roots like `~/.furnace/skills` and `~/.agents/skills`, Cursor roots like `~/.cursor/skills-cursor`, `~/.cursor/skills`, and `~/.cursor/plugins/cache`, and Claude Code roots like `~/.claude/skills` and `~/.claude/plugins/cache`.

Skills with `disable-model-invocation: true` are not listed in automatic model guidance, but they can still be loaded through explicit `/skill:<name>` slash commands.

Extra skill roots can be configured in `.furnace/preferences.json`:

```json
{
  "skillPaths": ["custom-skills", "~/shared-skills"]
}
```

Schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["name"],
  "properties": {
    "name": {
      "type": "string",
      "description": "Name of the skill to load."
    }
  }
}
```

Example:

```json
{
  "name": "review-bugbot"
}
```

Output format:

```xml
<skill_content name="review-bugbot">
# Skill: review-bugbot

...

Base directory for this skill: file:///...
Relative paths in this skill are relative to this base directory.
</skill_content>
```

### `skill_manage`

Create or update a local `SKILL.md` under an approved writable root. This tool is for agent-created reusable skills and always asks for approval before writing.

Writable targets:

- `project`: `.furnace/skills/<name>/SKILL.md`
- `user`: `~/.furnace/skills/<name>/SKILL.md`
- `cursor-user`: `~/.cursor/skills/<name>/SKILL.md`
- `claude-user`: `~/.claude/skills/<name>/SKILL.md`

Managed/plugin roots are intentionally not writable.

Schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["name", "description", "body"],
  "properties": {
    "name": {
      "type": "string",
      "description": "Skill name. Must use lowercase letters, numbers, and hyphens only."
    },
    "description": {
      "type": "string",
      "description": "Specific third-person description of what the skill does and when to use it."
    },
    "body": {
      "type": "string",
      "description": "Markdown body for SKILL.md after the frontmatter. Keep it concise and under 500 lines."
    },
    "target": {
      "type": "string",
      "enum": ["project", "user", "cursor-user", "claude-user"]
    },
    "disableModelInvocation": {
      "type": "boolean",
      "description": "Defaults to true for newly created skills."
    },
    "overwrite": {
      "type": "boolean",
      "description": "Allow updating an existing skill. Defaults to false."
    }
  }
}
```

Example:

```json
{
  "name": "terminal-polish",
  "description": "Improves terminal interface spacing and copy. Use when polishing terminal UI.",
  "body": "# Terminal Polish\n\nKeep panels compact and readable.",
  "target": "project"
}
```

After a skill is created or updated in the interactive TUI, run `/skills reload` to refresh slash autocomplete and model guidance.

### `task`

Delegate one or more independent multi-step prompts to child Furnace subagents. Use this when fresh context or fan-out helps more than direct local tools.

Schema:

```json
{
  "tasks": [
    {
      "prompt": "Inspect src/session/store.ts for parent/child session risks and return findings.",
      "description": "Review session linking"
    }
  ],
  "background": false
}
```

Only `prompt` is required for each task. `description` is an optional short label for the UI and child session title. Furnace derives a label from the prompt when it is omitted.

Behavior:

- Creates one child session per task with `parentSessionId` set to the parent conversation.
- Uses the same model and runtime context shape as the parent agent, including current date/time, current year, and workspace path.
- Uses the same tool set as the parent except `task` is removed.
- Runs synchronously by default and returns one combined tool result in input order.
- Can be promoted to background from the focused TUI task panel with `b`.
- When a background group finishes, Furnace queues one grouped completion prompt for the original parent session.
- Child session ids are kept internal and are not shown in task results.

Convenience single-task shape is also accepted:

```json
{
  "prompt": "Research the current API behavior and summarize it.",
  "description": "Research API behavior"
}
```

### `task_status`

Inspect active and backgrounded subagent tasks for the current parent conversation.

Schema:

```json
{}
```

The result includes task id, status, elapsed time, and errors if any.

### `websearch`

Search the web for current information using an Exa or Parallel MCP-style provider. Use this for current facts, recent versions, news, documentation discovery, and anything beyond the model cutoff.

Provider behavior:

- `provider: "exa"` calls Exa's `web_search_exa`.
- `provider: "parallel"` calls Parallel's `web_search`.
- If omitted, `FURNACE_WEBSEARCH_PROVIDER` or `OPENCODE_WEBSEARCH_PROVIDER` can choose the provider.
- If no provider is configured, Furnace chooses a stable provider from the query.
- `EXA_API_KEY` is forwarded through Exa's MCP URL when set.
- `PARALLEL_API_KEY` is sent as a bearer token when set.

Context handling:

- `numResults` defaults to `8` and is capped at `20`.
- `contextMaxCharacters` is capped at `50000`.
- The raw provider response is capped at `256 KB`.
- Final tool output is still passed through the generic `.furnace/tool-output/` bounding layer.

Schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["query"],
  "properties": {
    "query": {
      "type": "string",
      "description": "Web search query. Include the current year when searching for recent information."
    },
    "numResults": {
      "type": "number",
      "description": "Number of search results to return. Defaults to 8, max 20."
    },
    "livecrawl": {
      "type": "string",
      "enum": ["fallback", "preferred"],
      "description": "Live crawl mode. Defaults to fallback."
    },
    "type": {
      "type": "string",
      "enum": ["auto", "fast", "deep"],
      "description": "Search type. Defaults to auto."
    },
    "contextMaxCharacters": {
      "type": "number",
      "description": "Maximum provider context characters. Defaults to provider behavior, max 50000."
    },
    "provider": {
      "type": "string",
      "enum": ["exa", "parallel"],
      "description": "Optional provider override. Defaults to OPENCODE_WEBSEARCH_PROVIDER/FURNACE_WEBSEARCH_PROVIDER or a stable automatic choice."
    }
  }
}
```

Example:

```json
{
  "query": "Node.js 26 fetch changes 2026",
  "numResults": 8,
  "type": "auto",
  "livecrawl": "fallback",
  "contextMaxCharacters": 10000
}
```

Output format:

```text
<provider returned model-optimized search context>
```

### `webfetch`

Fetch an HTTP or HTTPS URL and return it as Markdown, plain text, or HTML. Use this when the user gives a specific URL or a `websearch` result needs deeper inspection.

Behavior:

- Only `http://` and `https://` URLs are allowed.
- Default output format is `markdown`.
- HTML is converted to Markdown with scripts/styles/meta/link tags removed.
- `text` extracts text from HTML while skipping active content.
- `html` returns the cleaned fetch body as HTML when textual.
- Non-textual content is rejected for now.
- Raw response body is capped at `5 MB`.
- Timeout defaults to `30s` and is capped at `120s`.
- Final tool output is passed through the generic `.furnace/tool-output/` bounding layer.

Schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["url"],
  "properties": {
    "url": {
      "type": "string",
      "description": "HTTP or HTTPS URL to fetch."
    },
    "format": {
      "type": "string",
      "enum": ["markdown", "text", "html"],
      "description": "Output format. Defaults to markdown."
    },
    "timeout": {
      "type": "number",
      "description": "Timeout in seconds. Defaults to 30, max 120."
    }
  }
}
```

Example:

```json
{
  "url": "https://example.com/docs",
  "format": "markdown",
  "timeout": 30
}
```

Output format:

```text
<markdown, text, or html content>
```

## Adding A Tool

To add a tool:

1. Add an entry to `registeredTools` in `src/tools/registry.ts`.
2. Define the model-facing schema in `definition`.
3. Implement the handler as a `ToolHandler`.
4. Keep path and permission checks in the handler or shared helpers.
5. Add tests in `test/tools.test.mjs`.
6. Update this document.

The agent loop does not need changes if the new tool follows the existing `RegisteredTool` shape.
