# Tools

Furnace tools are model-callable filesystem and shell primitives. The current workspace is the default path context, not a hard filesystem boundary. Each tool owns its model schema and runtime handler in one registry entry, then the agent loop passes only the schema portion to OpenRouter.

Current implementation lives in `src/tools/registry.ts`.

## Harness Provenance

Several tool-system choices were informed by other coding harnesses:

- Pi influenced the small primitive-tool shape and the decision to expose one edit primitive. Furnace presents it as `edit`, but the implementation behaves like an apply-patch envelope.
- OpenCode influenced the web tooling shape and bounded tool-output behavior. Furnace's `websearch`, `webfetch`, and `.furnace/tool-output/` previews follow that direction.
- Hermes Agent influenced file read deduplication, stale-write warnings, and richer tool history for debugging/resume. Furnace implements a smaller version of those ideas in the local TypeScript tool runtime and session store.

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
9. Stop after 8 tool iterations to avoid runaway loops.

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
- Writes are not hard-blocked for special paths yet. The prompt instructs the agent not to modify repo metadata like `.git/` or secret-like files like `.env` unless the user explicitly asks for that exact operation. A real permission gate should enforce this later.
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
- `write` and `edit` warn when a file changed after Furnace last read it in the active session, including after resume/restart. The write/edit is still applied today because approval/permission gates are not implemented yet.

`bash` is intentionally an escape hatch. The model prompt tells the agent to prefer structured tools before shell commands.

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
src/ui/ink-terminal.tsx
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
