import { execFile } from "node:child_process"
import { constants } from "node:fs"
import { access, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { promisify } from "node:util"
import { Parser } from "htmlparser2"
import TurndownService from "turndown"
import { retrieveContextArtifact, storeContextArtifact } from "../compression/artifacts.js"
import { compressToolOutput } from "../compression/router.js"
import { formatAskQuestionResult, normalizeAskQuestionRequest, type AskQuestionPrompt } from "../questions.js"
import type { FileReadFileKey, FileReadReceipt, FileReadRecord, FileReadSnapshot, TodoItem, TodoPriority, TodoStatus } from "../session/types.js"
import { renderSkillToolOutput } from "../skills/context.js"
import { loadSkillByName } from "../skills/loader.js"
import { writeManagedSkill, type SkillManageTarget } from "../skills/manage.js"
import type { TaskRunner, TaskRunResult, TaskSpec } from "../tasks/types.js"

const execFileAsync = promisify(execFile)

export type ToolServices = {
  fetch?: typeof fetch
}

export type ToolContext = {
  cwd: string
  fileReadStore?: ToolFileReadStore
  questionPrompt?: AskQuestionPrompt
  sessionId?: string
  services?: ToolServices
  signal?: AbortSignal
  skillPaths?: string[]
  taskRunner?: TaskRunner
  todoStore?: ToolTodoStore
}

export type ToolFileReadStore = {
  getFileReadReceipt(input: FileReadFileKey & { limit?: number | null; offset?: number | null }): FileReadReceipt | undefined
  getFileReadSnapshot(input: FileReadFileKey): FileReadSnapshot | undefined
  recordFileRead(input: FileReadRecord): void
  recordFileWrite(input: FileReadFileKey & { snapshot?: FileReadSnapshot }): void
}

export type ToolTodoStore = {
  appendTodoState(sessionId: string, todos: TodoItem[]): void
  getTodoState(sessionId: string): TodoItem[]
}

export type ToolCallInput = {
  arguments: string
  name: string
}

export type ToolExecution = {
  content: string
  name: string
}

export type ToolDefinition = {
  type: "function"
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

type ToolHandler = (args: unknown, context: ToolContext) => Promise<string>

type RegisteredTool = {
  definition: ToolDefinition
  execute: ToolHandler
}

type FileReadTracker = {
  latestByFile: Map<string, FileReadSnapshot>
  returnedRanges: Map<string, FileReadReceipt>
}

const maxToolOutputBytes = 50 * 1024
const maxToolOutputLines = 2_000
const maxReadChars = 200_000
const maxSearchFileBytes = 1_000_000
const maxWebSearchResponseBytes = 256 * 1024
const maxWebFetchResponseBytes = 5 * 1024 * 1024
const defaultWebFetchTimeoutMs = 30_000
const maxWebFetchTimeoutMs = 120_000
const noisyDirectoryNames = new Set(["node_modules", ".git", ".furnace"])
const exaUrl = process.env.EXA_API_KEY ? `https://mcp.exa.ai/mcp?exaApiKey=${encodeURIComponent(process.env.EXA_API_KEY)}` : "https://mcp.exa.ai/mcp"
const parallelUrl = "https://search.parallel.ai/mcp"
const fileReadTrackers = new Map<string, FileReadTracker>()

export const registeredTools: RegisteredTool[] = [
  {
    definition: {
      type: "function",
      function: {
        name: "read",
        description: "Read a file. Relative paths resolve from the current workspace; explicit absolute or parent paths are allowed. Secret-like .env files are denied except .env.example.",
        parameters: objectSchema({
          path: stringSchema("Path to read. Relative paths resolve from the current workspace."),
          offset: numberSchema("Optional 1-based line offset."),
          limit: numberSchema("Optional number of lines to return."),
        }, ["path"]),
      },
    },
    execute: readTool,
  },
  {
    definition: {
      type: "function",
      function: {
        name: "context_retrieve",
        description: "Retrieve original full content that Furnace saved after compressing a large tool output. Use the ctx_* id from a compressed tool result; request an offset/limit for targeted ranges.",
        parameters: objectSchema({
          id: stringSchema("Artifact id, for example ctx_0123abcd..."),
          offset: numberSchema("Optional 1-based line offset. Defaults to 1."),
          limit: numberSchema("Optional number of lines to return. Defaults to 500 to avoid flooding context."),
        }, ["id"]),
      },
    },
    execute: contextRetrieveTool,
  },
  {
    definition: {
      type: "function",
      function: {
        name: "ls",
        description: "List immediate files and directories. Relative paths resolve from the current workspace.",
        parameters: objectSchema({
          path: stringSchema("Directory to list. Defaults to the current workspace."),
        }),
      },
    },
    execute: lsTool,
  },
  {
    definition: {
      type: "function",
      function: {
        name: "find",
        description: "Find files by path/name substring. Relative paths resolve from the current workspace.",
        parameters: objectSchema({
          path: stringSchema("Directory to search. Defaults to the current workspace."),
          query: stringSchema("Optional case-insensitive substring to match against displayed paths."),
          maxResults: numberSchema("Maximum results to return. Defaults to 100."),
        }),
      },
    },
    execute: findTool,
  },
  {
    definition: {
      type: "function",
      function: {
        name: "glob",
        description: "Find files by glob pattern, for example **/*.ts. Relative paths resolve from the current workspace.",
        parameters: objectSchema({
          pattern: stringSchema("Glob pattern to match against displayed paths. Patterns without a slash also match filenames."),
          path: stringSchema("Directory to search. Defaults to the current workspace."),
          maxResults: numberSchema("Maximum results to return. Defaults to 100."),
        }, ["pattern"]),
      },
    },
    execute: globTool,
  },
  {
    definition: {
      type: "function",
      function: {
        name: "grep",
        description: "Search text files for a string or regular expression. Relative paths resolve from the current workspace.",
        parameters: objectSchema({
          pattern: stringSchema("Text or regex pattern to search for."),
          path: stringSchema("File or directory to search. Defaults to the current workspace."),
          regex: booleanSchema("Treat pattern as a JavaScript regular expression. Defaults to false."),
          maxResults: numberSchema("Maximum matching lines to return. Defaults to 100."),
        }, ["pattern"]),
      },
    },
    execute: grepTool,
  },
  {
    definition: {
      type: "function",
      function: {
        name: "write",
        description: "Create or overwrite a file. Relative paths resolve from the current workspace; explicit absolute or parent paths are allowed.",
        parameters: objectSchema({
          path: stringSchema("Path to write. Relative paths resolve from the current workspace."),
          content: stringSchema("Full file content to write."),
          overwrite: booleanSchema("Whether to overwrite an existing file. Defaults to false."),
        }, ["path", "content"]),
      },
    },
    execute: writeTool,
  },
  {
    definition: {
      type: "function",
      function: {
        name: "edit",
        description: "Apply a Furnace apply-patch envelope. Do not use unified diff syntax (`---`, `+++`, `@@ -1,3 +1,4 @@`). The patch must start with *** Begin Patch and use *** Add File, *** Update File, or *** Delete File operations.",
        parameters: objectSchema({
          patch: stringSchema("Patch envelope only: *** Begin Patch, then file operations like *** Update File: path, hunks with context/removal/addition lines, then *** End Patch. Unified diffs are invalid."),
        }, ["patch"]),
      },
    },
    execute: editTool,
  },
  {
    definition: {
      type: "function",
      function: {
        name: "bash",
        description: "Escape hatch for running a shell command. The command starts in the workspace, but may inspect explicitly requested external paths such as ~/Desktop. Use only when file/search/edit primitives are insufficient.",
        parameters: objectSchema({
          command: stringSchema("Shell command to run."),
          timeoutMs: numberSchema("Timeout in milliseconds. Defaults to 30000, max 120000."),
        }, ["command"]),
      },
    },
    execute: bashTool,
  },
  {
    definition: {
      type: "function",
      function: {
        name: "ask_question",
        description: "Ask the user one or more clarification questions when the task is ambiguous or needs a user decision. Put only concrete answer choices in options. Do not include choices like 'let me specify', 'type my own', 'other', 'custom', 'skip', or 'refuse'; the UI already provides custom answer and refusal controls.",
        parameters: objectSchema({
          questions: arraySchema(
            objectSchema({
              id: stringSchema("Stable question id, for example scope or style."),
              prompt: stringSchema("The complete question to ask. Do not embed option numbers here."),
              options: arraySchema(
                objectSchema({
                  id: stringSchema("Stable option id."),
                  label: stringSchema("Short option label shown to the user."),
                  description: stringSchema("Optional one-line explanation of the option."),
                }, ["id", "label"]),
                "Concrete available choices only. Do not include meta choices for custom input, other, skipping, or refusal; the UI provides those separately when enabled.",
              ),
              allowMultiple: booleanSchema("Allow selecting more than one option. Defaults to false."),
              allowCustom: booleanSchema("Allow the user to type their own answer. Defaults to true. Use this instead of adding an option like 'let me specify' or 'type my own'."),
            }, ["id", "prompt", "options"]),
            "One or more questions to ask before continuing.",
          ),
        }, ["questions"]),
      },
    },
    execute: askQuestionTool,
  },
  {
    definition: {
      type: "function",
      function: {
        name: "skill",
        description: "Load a specialized skill when the task matches one of the available skills in the system context. The name must match an available skill.",
        parameters: objectSchema({
          name: stringSchema("Name of the skill to load."),
        }, ["name"]),
      },
    },
    execute: skillTool,
  },
  {
    definition: {
      type: "function",
      function: {
        name: "skill_manage",
        description: "Create or update a local SKILL.md under an approved writable skill root. This is high-leverage and requires user approval. Prefer asking the user first unless they explicitly requested a reusable skill.",
        parameters: objectSchema({
          name: stringSchema("Skill name. Must use lowercase letters, numbers, and hyphens only."),
          description: stringSchema("Specific third-person description of what the skill does and when to use it."),
          body: stringSchema("Markdown body for SKILL.md after the frontmatter. Keep it concise and under 500 lines."),
          target: enumSchema(["project", "user", "cursor-user", "claude-user"], "Writable root. Defaults to project (.furnace/skills). Managed/plugin cache roots are never writable."),
          disableModelInvocation: booleanSchema("Whether to hide from automatic model guidance. Defaults to true for newly created skills."),
          overwrite: booleanSchema("Allow updating an existing skill. Defaults to false."),
        }, ["name", "description", "body"]),
      },
    },
    execute: skillManageTool,
  },
  {
    definition: {
      type: "function",
      function: {
        name: "task",
        description: "Delegate one or more independent multi-step coding, research, review, or exploration tasks to child Furnace subagents for parallel fan-out. Children use the same model/runtime context as the parent and the same tools except task. The parent waits by default unless the user promotes the active task group to background.",
        parameters: objectSchema({
          tasks: arraySchema(
            objectSchema({
              prompt: stringSchema("Detailed autonomous prompt for the child subagent. Include all context it needs; it cannot see hidden parent history."),
              description: stringSchema("Optional short UI/session label. If omitted, Furnace derives it from the prompt."),
            }, ["prompt"]),
            "One or more independent tasks to run as a batch. Results are returned in input order.",
          ),
          prompt: stringSchema("Convenience single-task prompt. Use tasks[] for batching."),
          description: stringSchema("Optional short label for the convenience single-task prompt."),
          background: booleanSchema("Start in background immediately. Normally leave false; the user can promote active tasks from the UI."),
        }),
      },
    },
    execute: taskTool,
  },
  {
    definition: {
      type: "function",
      function: {
        name: "task_status",
        description: "Check active and backgrounded subagent tasks for the current parent conversation.",
        parameters: objectSchema({}),
      },
    },
    execute: taskStatusTool,
  },
  {
    definition: {
      type: "function",
      function: {
        name: "todoread",
        description: "Read the current session todo list. Use before resuming complex multi-step work when the current todo state is unclear.",
        parameters: objectSchema({}),
      },
    },
    execute: todoReadTool,
  },
  {
    definition: {
      type: "function",
      function: {
        name: "todowrite",
        description: [
          "Create and maintain a structured task list for the current coding session. Tracks progress, organizes multi-step work, and surfaces status to the user.",
          "",
          "Use proactively when the task requires 3+ distinct steps, the work is non-trivial, the user provides multiple tasks, or the user explicitly asks for a todo list.",
          "Skip for single straightforward tasks, purely informational requests, or when tracking adds no organizational value.",
          "",
          "Rules: keep exactly one in_progress item while work remains; update status in real time; mark completed only after the work and required verification are actually done; preserve user-provided commands verbatim; keep items specific and actionable.",
        ].join("\n"),
        parameters: objectSchema({
          todos: arraySchema(
            objectSchema({
              id: stringSchema("Unique stable identifier for the todo item."),
              content: stringSchema("Brief, specific task description."),
              status: enumSchema(["pending", "in_progress", "completed", "cancelled"], "Current status."),
              priority: enumSchema(["high", "medium", "low"], "Optional priority level."),
            }, ["id", "content", "status"]),
            "The full updated todo list, in priority/order of execution.",
          ),
        }, ["todos"]),
      },
    },
    execute: todoWriteTool,
  },
  {
    definition: {
      type: "function",
      function: {
        name: "websearch",
        description: "Search the web for current information using an Exa or Parallel MCP-style provider. Returns model-optimized text and bounds large responses.",
        parameters: objectSchema({
          query: stringSchema("Web search query. Include the current year when searching for recent information."),
          numResults: numberSchema("Number of search results to return. Defaults to 8, max 20."),
          livecrawl: enumSchema(["fallback", "preferred"], "Live crawl mode. Defaults to fallback."),
          type: enumSchema(["auto", "fast", "deep"], "Search type. Defaults to auto."),
          contextMaxCharacters: numberSchema("Maximum provider context characters. Defaults to provider behavior, max 50000."),
          provider: enumSchema(["exa", "parallel"], "Optional provider override. Defaults to OPENCODE_WEBSEARCH_PROVIDER/FURNACE_WEBSEARCH_PROVIDER or a stable automatic choice."),
        }, ["query"]),
      },
    },
    execute: websearchTool,
  },
  {
    definition: {
      type: "function",
      function: {
        name: "webfetch",
        description: "Fetch an HTTP or HTTPS URL and return it as markdown, text, or HTML. HTML is cleaned of scripts/styles; large output is bounded.",
        parameters: objectSchema({
          url: stringSchema("HTTP or HTTPS URL to fetch."),
          format: enumSchema(["markdown", "text", "html"], "Output format. Defaults to markdown."),
          timeout: numberSchema("Timeout in seconds. Defaults to 30, max 120."),
        }, ["url"]),
      },
    },
    execute: webfetchTool,
  },
]

export const toolDefinitions: ToolDefinition[] = registeredTools.map((tool) => tool.definition)
export const childToolDefinitions: ToolDefinition[] = registeredTools.filter((tool) => tool.definition.function.name !== "task").map((tool) => tool.definition)

export async function executeToolCall(call: ToolCallInput, context: ToolContext): Promise<ToolExecution> {
  const tool = registeredTools.find((candidate) => candidate.definition.function.name === call.name)
  if (!tool) return { name: call.name, content: `Unknown tool: ${call.name}` }

  try {
    const args = call.arguments.trim() ? JSON.parse(call.arguments) : {}
    return { name: call.name, content: await boundToolOutput(await tool.execute(args, context), context) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { name: call.name, content: `Tool ${call.name} failed: ${message}` }
  }
}

async function readTool(args: unknown, context: ToolContext): Promise<string> {
  const path = requiredString(args, "path")
  const file = resolveToolPath(context.cwd, path)
  assertReadablePath(context.cwd, file)
  const fileInfo = await stat(file)
  const snapshot = fileSnapshot(fileInfo)
  const offset = optionalNumber(args, "offset")
  const limit = optionalNumber(args, "limit")
  const rangeKey = readRangeKey(context, file, offset, limit)
  const previousReceipt = getFileReadReceipt(context, file, offset, limit, rangeKey)
  if (previousReceipt && sameSnapshot(previousReceipt, snapshot)) {
    const range = readRangeLabel(offset, limit)
    return `File unchanged since last read: ${previousReceipt.displayPath}${range ? ` (${range})` : ""}.\nUse the previously returned content unless you need a different line range.`
  }

  const contents = await readFile(file, "utf8")
  const lines = contents.split(/\r?\n/)
  const start = Math.max(0, (offset || 1) - 1)
  const selected = typeof limit === "number" ? lines.slice(start, start + Math.max(0, limit)) : lines.slice(start)
  recordFileRead(context, file, snapshot, rangeKey, offset, limit)
  return truncate(selected.map((line, index) => `${start + index + 1}|${line}`).join("\n"), maxReadChars)
}

async function contextRetrieveTool(args: unknown, context: ToolContext): Promise<string> {
  const id = requiredString(args, "id")
  const offset = optionalNumber(args, "offset")
  const limit = optionalNumber(args, "limit") ?? 500
  const artifact = await retrieveContextArtifact({ cwd: context.cwd, id, offset, limit })
  const range = artifact.lineCount > 0 ? `lines ${artifact.startLine}-${artifact.endLine} of ${artifact.totalLines}` : `no lines selected from ${artifact.totalLines} total lines`
  return [
    `Context artifact ${artifact.id}`,
    `Path: ${artifact.relativePath}`,
    `Size: ${artifact.bytes.toLocaleString()} bytes`,
    `Returned: ${range}`,
    "",
    artifact.content,
  ].join("\n")
}

async function lsTool(args: unknown, context: ToolContext): Promise<string> {
  const target = resolveToolPath(context.cwd, optionalString(args, "path") || ".")
  const entries = await readdir(target, { withFileTypes: true })
  return entries
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => `${entry.isDirectory() ? "dir " : "file"} ${entry.name}`)
    .join("\n")
}

async function findTool(args: unknown, context: ToolContext): Promise<string> {
  const requestedPath = optionalString(args, "path")
  const root = resolveToolPath(context.cwd, requestedPath || ".")
  const query = (optionalString(args, "query") || "").toLowerCase()
  const maxResults = clamp(optionalNumber(args, "maxResults") || 100, 1, 1000)
  const files = await listFiles(root, context.cwd, maxResults, query, {
    skipNoisyDirs: !isInsideNoisyDirectory(root),
  })
  return files.map((file) => displayPath(context.cwd, file)).join("\n") || "No files found."
}

async function globTool(args: unknown, context: ToolContext): Promise<string> {
  const pattern = requiredString(args, "pattern")
  const requestedPath = optionalString(args, "path")
  const root = resolveToolPath(context.cwd, requestedPath || ".")
  const maxResults = clamp(optionalNumber(args, "maxResults") || 100, 1, 1000)
  const matcher = globToRegExp(pattern)
  const files = (await listFiles(root, context.cwd, 10_000, "", { skipNoisyDirs: !isInsideNoisyDirectory(root) })).filter((file) => {
    const label = displayPath(context.cwd, file)
    return matcher.test(label) || (!pattern.includes("/") && matcher.test(basename(file)))
  })
  return files.slice(0, maxResults).map((file) => displayPath(context.cwd, file)).join("\n") || "No files found."
}

async function grepTool(args: unknown, context: ToolContext): Promise<string> {
  const pattern = requiredString(args, "pattern")
  const requestedPath = optionalString(args, "path")
  const root = resolveToolPath(context.cwd, requestedPath || ".")
  const maxResults = clamp(optionalNumber(args, "maxResults") || 100, 1, 1000)
  const matcher = optionalBoolean(args, "regex") ? new RegExp(pattern) : undefined
  const needle = matcher ? "" : pattern.toLowerCase()
  const files = (await stat(root)).isDirectory() ? await listFiles(root, context.cwd, 10_000, "", { skipNoisyDirs: !isInsideNoisyDirectory(root) }) : [root]
  const results: string[] = []

  for (const relativeFile of files) {
    if (results.length >= maxResults) break
    const file = resolveToolPath(context.cwd, relativeFile)
    if (isSecretLikePath(file)) continue
    const info = await stat(file)
    if (info.size > maxSearchFileBytes) continue
    let contents: string
    try {
      contents = await readFile(file, "utf8")
    } catch {
      continue
    }
    const lines = contents.split(/\r?\n/)
    for (const [index, line] of lines.entries()) {
      const matched = matcher ? matcher.test(line) : line.toLowerCase().includes(needle)
      if (!matched) continue
      results.push(`${displayPath(context.cwd, file)}:${index + 1}:${line}`)
      if (results.length >= maxResults) break
    }
  }

  return results.join("\n") || "No matches found."
}

async function writeTool(args: unknown, context: ToolContext): Promise<string> {
  const path = requiredString(args, "path")
  const content = requiredString(args, "content")
  const overwrite = optionalBoolean(args, "overwrite") || false
  const file = resolveToolPath(context.cwd, path)
  const warning = overwrite ? await staleWriteWarning(context, file) : undefined
  if (!overwrite && (await exists(file))) throw new Error(`File already exists: ${displayPath(context.cwd, file)}`)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content, "utf8")
  await recordFileWrite(context, file)
  return [warning, `Wrote ${displayPath(context.cwd, file)} (${content.length} bytes).`].filter(Boolean).join("\n")
}

async function editTool(args: unknown, context: ToolContext): Promise<string> {
  const patch = requiredString(args, "patch")
  const targets = patchTargets(context.cwd, patch)
  const warnings = await staleWriteWarnings(context, targets.filter((target) => target.kind !== "add").map((target) => target.file))
  const result = await applyPatchEnvelope(context.cwd, patch)
  await Promise.all(targets.map((target) => recordFileWrite(context, target.file)))
  return [...warnings, ...result].join("\n")
}

async function bashTool(args: unknown, context: ToolContext): Promise<string> {
  const command = requiredString(args, "command")
  const timeoutMs = clamp(optionalNumber(args, "timeoutMs") || 30_000, 1, 120_000)
  try {
    const { stdout, stderr } = await execFileAsync("/bin/bash", ["-lc", command], {
      cwd: context.cwd,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    })
    return formatCommandResult(0, stdout, stderr)
  } catch (error) {
    if (error && typeof error === "object") {
      const maybe = error as { code?: unknown; killed?: boolean; signal?: unknown; stderr?: unknown; stdout?: unknown }
      const code = typeof maybe.code === "number" ? maybe.code : maybe.killed ? "timeout" : "error"
      return formatCommandResult(code, String(maybe.stdout || ""), String(maybe.stderr || maybe.signal || ""))
    }
    throw error
  }
}

async function askQuestionTool(args: unknown, context: ToolContext): Promise<string> {
  const request = normalizeAskQuestionRequest(args)
  if (!context.questionPrompt) {
    return "Question prompt UI is unavailable in this mode. Make a reasonable assumption or ask the user in the final response."
  }
  return formatAskQuestionResult(await context.questionPrompt(request))
}

async function skillTool(args: unknown, context: ToolContext): Promise<string> {
  const name = requiredString(args, "name")
  const skill = await loadSkillByName(context.cwd, name, { extraPaths: context.skillPaths })
  if (!skill) throw new Error(`Unable to load skill ${name}`)
  const files = await sampleSkillFiles(skill.baseDir)
  return renderSkillToolOutput(skill, files)
}

async function skillManageTool(args: unknown, context: ToolContext): Promise<string> {
  const name = requiredString(args, "name")
  const description = requiredString(args, "description")
  const body = requiredString(args, "body")
  const target = optionalEnum(args, "target", ["project", "user", "cursor-user", "claude-user"]) as SkillManageTarget | undefined
  const disableModelInvocation = optionalBoolean(args, "disableModelInvocation")
  const overwrite = optionalBoolean(args, "overwrite")
  const result = await writeManagedSkill(context.cwd, {
    body,
    description,
    disableModelInvocation,
    name,
    overwrite,
    target,
  })
  return [
    `${result.created ? "Created" : "Updated"} skill ${name}`,
    `path: ${displayPath(context.cwd, result.filePath)}`,
    `target: ${result.target}`,
    "Run /skills reload to refresh autocomplete and model guidance in the TUI.",
  ].join("\n")
}

async function taskTool(args: unknown, context: ToolContext): Promise<string> {
  if (!context.taskRunner || !context.sessionId) return "Task delegation is unavailable in this mode."
  const tasks = normalizeTaskSpecs(args)
  if (tasks.length === 0) throw new Error("Expected at least one task prompt")
  const result = await context.taskRunner.runTasks({
    background: optionalBoolean(args, "background") || false,
    parentSessionId: context.sessionId,
    signal: context.signal,
    tasks,
  })
  return formatTaskRunResult(result)
}

async function sampleSkillFiles(baseDir: string, maxFiles = 10): Promise<string[]> {
  const files = await listFiles(baseDir, baseDir, 10_000, "", { skipNoisyDirs: true })
  return files
    .filter((file) => basename(file) !== "SKILL.md")
    .sort((left, right) => left.localeCompare(right))
    .slice(0, maxFiles)
    .map((file) => displayPath(baseDir, file))
}

async function taskStatusTool(_args: unknown, context: ToolContext): Promise<string> {
  if (!context.taskRunner || !context.sessionId) return "Task status is unavailable in this mode."
  const snapshot = context.taskRunner.status(context.sessionId)
  const visible = snapshot.tasks.filter((task) => task.status !== "completed")
  if (visible.length === 0) return "No active subagent tasks for this conversation."
  return visible
    .map((task) => {
      const elapsed = Math.max(0, (task.completedAt || Date.now()) - task.startedAt)
      const parts = [
        `${task.status}: ${task.description}`,
        `task_id=${task.id}`,
        `elapsed=${formatDuration(elapsed)}`,
      ]
      if (task.error) parts.push(`error=${task.error}`)
      return parts.join(" | ")
    })
    .join("\n")
}

async function todoReadTool(_args: unknown, context: ToolContext): Promise<string> {
  if (!context.todoStore || !context.sessionId) return "Todo state is unavailable in this mode."
  return formatTodoToolResult(context.todoStore.getTodoState(context.sessionId))
}

async function todoWriteTool(args: unknown, context: ToolContext): Promise<string> {
  if (!context.todoStore || !context.sessionId) return "Todo state is unavailable in this mode."
  const todos = normalizeTodoItems(args)
  context.todoStore.appendTodoState(context.sessionId, todos)
  return formatTodoToolResult(todos)
}

async function websearchTool(args: unknown, context: ToolContext): Promise<string> {
  const query = requiredString(args, "query")
  const numResults = clamp(optionalNumber(args, "numResults") || 8, 1, 20)
  const livecrawl = optionalEnum(args, "livecrawl", ["fallback", "preferred"]) || "fallback"
  const type = optionalEnum(args, "type", ["auto", "fast", "deep"]) || "auto"
  const contextMaxCharacters = optionalNumber(args, "contextMaxCharacters")
  const boundedContextMaxCharacters = typeof contextMaxCharacters === "number" ? clamp(contextMaxCharacters, 1, 50_000) : undefined
  const provider = optionalEnum(args, "provider", ["exa", "parallel"]) || selectWebSearchProvider(query)
  const fetchImpl = context.services?.fetch || fetch

  const result =
    provider === "parallel"
      ? await callMcpWebTool(
          fetchImpl,
          parallelUrl,
          "web_search",
          {
            objective: query,
            search_queries: [query],
            session_id: "furnace",
          },
          parallelAuthHeaders(),
        )
      : await callMcpWebTool(fetchImpl, exaUrl, "web_search_exa", {
          query,
          type,
          numResults,
          livecrawl,
          ...(boundedContextMaxCharacters ? { contextMaxCharacters: boundedContextMaxCharacters } : {}),
        })

  return result || "No search results found. Please try a different query."
}

function normalizeTaskSpecs(args: unknown): TaskSpec[] {
  const tasksValue = getArg(args, "tasks")
  if (Array.isArray(tasksValue)) {
    return tasksValue.flatMap((item) => {
      if (!item || typeof item !== "object") return []
      const record = item as Record<string, unknown>
      const prompt = typeof record.prompt === "string" ? record.prompt.trim() : ""
      if (!prompt) return []
      const description = typeof record.description === "string" && record.description.trim() ? record.description.trim() : undefined
      return [description ? { description, prompt } : { prompt }]
    })
  }

  const prompt = optionalString(args, "prompt")?.trim()
  if (!prompt) return []
  const description = optionalString(args, "description")?.trim()
  return [description ? { description, prompt } : { prompt }]
}

function formatTaskRunResult(result: TaskRunResult): string {
  const state = result.backgrounded ? "backgrounded" : "completed"
  const lines = [`Task group ${result.groupId} ${state}.`]
  for (const [index, task] of result.tasks.entries()) {
    lines.push("")
    lines.push(`Task ${index + 1}: ${task.description}`)
    lines.push(`- task_id: ${task.id}`)
    lines.push(`- status: ${task.status}`)
    if (task.error) lines.push(`- error: ${task.error}`)
    if (task.result) lines.push(`- result:\n${indent(task.result)}`)
  }
  if (result.backgrounded) {
    lines.push("")
    lines.push("The subagent task group is now running in the background. Do not poll or duplicate its work; Furnace will notify the parent conversation when every task in the group finishes.")
  }
  return lines.join("\n")
}

function normalizeTodoItems(args: unknown): TodoItem[] {
  const value = getArg(args, "todos")
  if (!Array.isArray(value)) throw new Error("todos must be an array")
  return value.slice(0, 100).map((item, index) => normalizeTodoItem(item, index))
}

function normalizeTodoItem(item: unknown, index: number): TodoItem {
  if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`todos[${index}] must be an object`)
  const record = item as Record<string, unknown>
  const id = typeof record.id === "string" ? record.id.trim().slice(0, 80) : ""
  const content = typeof record.content === "string" ? record.content.trim().slice(0, 2_000) : ""
  if (!id) throw new Error(`todos[${index}].id is required`)
  if (!content) throw new Error(`todos[${index}].content is required`)
  const status = typeof record.status === "string" ? record.status : "pending"
  if (!isTodoStatus(status)) throw new Error(`todos[${index}].status must be pending, in_progress, completed, or cancelled`)
  const priority = typeof record.priority === "string" && isTodoPriority(record.priority) ? record.priority : undefined
  return priority ? { id, content, status, priority } : { id, content, status }
}

function isTodoStatus(value: string): value is TodoStatus {
  return value === "pending" || value === "in_progress" || value === "completed" || value === "cancelled"
}

function isTodoPriority(value: string): value is TodoPriority {
  return value === "high" || value === "medium" || value === "low"
}

function formatTodoToolResult(todos: TodoItem[]): string {
  const summary = {
    total: todos.length,
    pending: todos.filter((todo) => todo.status === "pending").length,
    in_progress: todos.filter((todo) => todo.status === "in_progress").length,
    completed: todos.filter((todo) => todo.status === "completed").length,
    cancelled: todos.filter((todo) => todo.status === "cancelled").length,
  }
  return JSON.stringify({ todos, summary }, null, 2)
}

function indent(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => `  ${line}`)
    .join("\n")
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return `${minutes}m${remainder.toString().padStart(2, "0")}s`
}

async function webfetchTool(args: unknown, context: ToolContext): Promise<string> {
  const url = requiredString(args, "url")
  const format = optionalEnum(args, "format", ["markdown", "text", "html"]) || "markdown"
  const timeoutMs = clamp((optionalNumber(args, "timeout") || defaultWebFetchTimeoutMs / 1000) * 1000, 1, maxWebFetchTimeoutMs)
  const parsed = new URL(url)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("URL must use http:// or https://")

  const fetchImpl = context.services?.fetch || fetch
  const response = await fetchWithTimeout(fetchImpl, parsed.toString(), {
    headers: webFetchHeaders(format),
    timeoutMs,
  })
  if (!response.ok) throw new Error(`Web fetch failed (${response.status}): ${response.statusText}`)

  const contentLength = response.headers.get("content-length")
  if (contentLength && Number.parseInt(contentLength, 10) > maxWebFetchResponseBytes) {
    throw new Error(`Response too large (exceeds ${maxWebFetchResponseBytes} byte limit)`)
  }

  const arrayBuffer = await response.arrayBuffer()
  if (arrayBuffer.byteLength > maxWebFetchResponseBytes) {
    throw new Error(`Response too large (exceeds ${maxWebFetchResponseBytes} byte limit)`)
  }

  const contentType = response.headers.get("content-type") || ""
  const mime = mimeFrom(contentType)
  if (!isTextualMime(mime)) throw new Error(`Unsupported fetched content type: ${mime || "unknown"}`)

  const content = new TextDecoder().decode(arrayBuffer)
  if (format === "html") return content
  if (contentType.toLowerCase().includes("text/html")) {
    return format === "text" ? extractTextFromHTML(content) : convertHTMLToMarkdown(content)
  }
  return content
}

async function callMcpWebTool(fetchImpl: typeof fetch, url: string, tool: string, toolArguments: Record<string, unknown>, headers: Record<string, string> = {}): Promise<string | undefined> {
  const response = await fetchWithTimeout(fetchImpl, url, {
    method: "POST",
    timeoutMs: 25_000,
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: tool,
        arguments: toolArguments,
      },
    }),
  })
  if (!response.ok) throw new Error(`${tool} request failed (${response.status}): ${response.statusText}`)
  const body = await response.text()
  if (Buffer.byteLength(body, "utf8") > maxWebSearchResponseBytes) {
    throw new Error(`${tool} response exceeded ${maxWebSearchResponseBytes} bytes`)
  }
  return parseMcpWebResponse(body)
}

async function fetchWithTimeout(fetchImpl: typeof fetch, url: string, options: RequestInit & { timeoutMs: number }): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs)
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

function parseMcpWebResponse(body: string): string | undefined {
  const direct = parseMcpWebPayload(body.trim())
  if (direct) return direct
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue
    const parsed = parseMcpWebPayload(line.slice("data: ".length).trim())
    if (parsed) return parsed
  }
  return undefined
}

function parseMcpWebPayload(payload: string): string | undefined {
  if (!payload.startsWith("{")) return undefined
  try {
    const parsed = JSON.parse(payload) as { result?: { content?: Array<{ text?: string; type?: string }> } }
    return parsed.result?.content?.find((item) => item.text)?.text
  } catch {
    return undefined
  }
}

function selectWebSearchProvider(seed: string): "exa" | "parallel" {
  const configured = process.env.FURNACE_WEBSEARCH_PROVIDER || process.env.OPENCODE_WEBSEARCH_PROVIDER
  if (configured === "exa" || configured === "parallel") return configured
  let hash = 0
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return hash % 2 === 0 ? "exa" : "parallel"
}

function parallelAuthHeaders(): Record<string, string> {
  const headers = { "User-Agent": "furnace/0.0.0" }
  return process.env.PARALLEL_API_KEY ? { ...headers, Authorization: `Bearer ${process.env.PARALLEL_API_KEY}` } : headers
}

function webFetchHeaders(format: "html" | "markdown" | "text"): Record<string, string> {
  const accept =
    format === "markdown"
      ? "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
      : format === "text"
        ? "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1"
        : "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1"
  return {
    Accept: accept,
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
  }
}

function mimeFrom(contentType: string): string {
  return contentType.split(";")[0]?.trim().toLowerCase() || ""
}

function isTextualMime(mime: string): boolean {
  return (
    !mime ||
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime.endsWith("+json") ||
    mime === "application/xml" ||
    mime.endsWith("+xml") ||
    mime === "application/javascript" ||
    mime === "application/x-javascript"
  )
}

function extractTextFromHTML(html: string): string {
  let text = ""
  let skipDepth = 0
  const parser = new Parser({
    onopentag(name) {
      if (skipDepth > 0 || ["script", "style", "noscript", "iframe", "object", "embed"].includes(name)) skipDepth += 1
    },
    ontext(input) {
      if (skipDepth === 0) text += input
    },
    onclosetag() {
      if (skipDepth > 0) skipDepth -= 1
    },
  })
  parser.write(html)
  parser.end()
  return text.trim()
}

function convertHTMLToMarkdown(html: string): string {
  const turndown = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  })
  turndown.remove(["script", "style", "meta", "link"])
  return turndown.turndown(html)
}

async function applyPatchEnvelope(cwd: string, patch: string): Promise<string[]> {
  const lines = patch.replace(/\r\n/g, "\n").split("\n")
  if (lines[0] !== "*** Begin Patch") throw new Error("Patch must start with *** Begin Patch")
  if (!lines.some((line) => line === "*** End Patch")) throw new Error("Patch must end with *** End Patch")
  if (lines.some((line) => line.startsWith("--- ") || line.startsWith("+++ "))) throw new Error("Unified diff syntax is not supported. Use Furnace patch envelope syntax: *** Begin Patch, *** Update File: <path>, @@, context/removal/addition lines, *** End Patch.")

  const results: string[] = []
  let index = 1
  while (index < lines.length) {
    const line = lines[index]
    if (line === "*** End Patch") break
    if (!line) {
      index += 1
      continue
    }
    if (line.startsWith("*** Add File: ")) {
      const file = resolveToolPath(cwd, line.slice("*** Add File: ".length).trim())
      const contentLines: string[] = []
      index += 1
      while (index < lines.length && !lines[index].startsWith("*** ") && !lines[index].startsWith("@@")) {
        const current = lines[index]
        if (!current.startsWith("+")) throw new Error(`Add file lines must start with + near ${displayPath(cwd, file)}`)
        contentLines.push(current.slice(1))
        index += 1
      }
      if (await exists(file)) throw new Error(`File already exists: ${displayPath(cwd, file)}`)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, `${contentLines.join("\n")}${contentLines.length > 0 ? "\n" : ""}`, "utf8")
      results.push(`Added ${displayPath(cwd, file)}`)
      continue
    }
    if (line.startsWith("*** Update File: ")) {
      const file = resolveToolPath(cwd, line.slice("*** Update File: ".length).trim())
      let contents = await readFile(file, "utf8")
      index += 1
      let hunks = 0
      while (index < lines.length && !lines[index].startsWith("*** ")) {
        if (!lines[index].startsWith("@@")) throw new Error(`Expected hunk header in ${displayPath(cwd, file)}`)
        index += 1
        const oldLines: string[] = []
        const newLines: string[] = []
        while (index < lines.length && !lines[index].startsWith("@@") && !lines[index].startsWith("*** ")) {
          const current = lines[index]
          if (current === "*** End of File") {
            index += 1
            continue
          }
          const marker = current[0]
          const text = current.slice(1)
          if (marker === " ") {
            oldLines.push(text)
            newLines.push(text)
          } else if (marker === "-") {
            oldLines.push(text)
          } else if (marker === "+") {
            newLines.push(text)
          } else if (current === "") {
            oldLines.push("")
            newLines.push("")
          } else {
            throw new Error(`Invalid hunk line in ${displayPath(cwd, file)}: ${current}`)
          }
          index += 1
        }
        contents = replaceHunk(contents, oldLines.join("\n"), newLines.join("\n"), displayPath(cwd, file))
        hunks += 1
      }
      await writeFile(file, contents, "utf8")
      results.push(`Updated ${displayPath(cwd, file)} (${hunks} hunks)`)
      continue
    }
    if (line.startsWith("*** Delete File: ")) {
      const file = resolveToolPath(cwd, line.slice("*** Delete File: ".length).trim())
      await rm(file)
      results.push(`Deleted ${displayPath(cwd, file)}`)
      index += 1
      continue
    }
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      throw new Error("Unified diff syntax is not supported. Use Furnace patch envelope syntax with *** Update File: <path> instead of ---/+++ file headers.")
    }
    throw new Error(`Unknown patch operation: ${line}. Expected *** Add File:, *** Update File:, *** Delete File:, or *** End Patch.`)
  }
  return results
}

function replaceHunk(contents: string, oldText: string, newText: string, file: string): string {
  if (contents.includes(oldText)) return contents.replace(oldText, newText)
  if (contents.includes(`${oldText}\n`)) return contents.replace(`${oldText}\n`, `${newText}\n`)
  throw new Error(`Could not find hunk context in ${file}`)
}

async function listFiles(root: string, cwd: string, maxResults: number, query: string, options: { skipNoisyDirs: boolean }): Promise<string[]> {
  const results: string[] = []
  async function visit(directory: string): Promise<void> {
    if (results.length >= maxResults) return
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (results.length >= maxResults) return
      if (options.skipNoisyDirs && noisyDirectoryNames.has(entry.name)) continue
      const fullPath = resolve(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(fullPath)
        continue
      }
      if (!entry.isFile()) continue
      const label = displayPath(cwd, fullPath)
      if (!query || label.toLowerCase().includes(query)) results.push(fullPath)
    }
  }
  await visit(root)
  return results.sort((left, right) => displayPath(cwd, left).localeCompare(displayPath(cwd, right)))
}

function resolveToolPath(cwd: string, inputPath: string): string {
  if (inputPath === "~") return resolve(homeDirectory())
  if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) return resolve(homeDirectory(), inputPath.slice(2))
  return resolve(cwd, inputPath)
}

function homeDirectory(): string {
  return process.env.HOME || process.env.USERPROFILE || cwdFallback()
}

function cwdFallback(): string {
  return process.cwd()
}

function assertReadablePath(cwd: string, file: string): void {
  if (isSecretLikePath(file)) throw new Error(`Refusing to read secret-like file: ${displayPath(cwd, file)}`)
}

function isSecretLikePath(file: string): boolean {
  const parts = file.split(/[\\/]/)
  const name = parts[parts.length - 1] || ""
  return name !== ".env.example" && (name === ".env" || name.startsWith(".env."))
}

function isInsideNoisyDirectory(file: string): boolean {
  return resolve(file).split(/[\\/]/).some((part) => noisyDirectoryNames.has(part))
}

function displayPath(cwd: string, file: string): string {
  const normalizedCwd = resolve(cwd)
  const normalizedFile = resolve(file)
  const relativeFile = relative(normalizedCwd, normalizedFile)
  if (relativeFile === "") return "."
  if (!relativeFile.startsWith("..") && !isAbsolute(relativeFile) && !relativeFile.includes(`..${sep}`)) return relativeFile
  return normalizedFile
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

function getFileReadTracker(context: ToolContext): FileReadTracker {
  const key = fileReadTrackerKey(context)
  const existing = fileReadTrackers.get(key)
  if (existing) return existing
  const tracker: FileReadTracker = {
    latestByFile: new Map(),
    returnedRanges: new Map(),
  }
  fileReadTrackers.set(key, tracker)
  return tracker
}

function fileReadTrackerKey(context: ToolContext): string {
  return [resolve(context.cwd), context.sessionId || "workspace"].join("\0")
}

function fileSnapshot(info: Awaited<ReturnType<typeof stat>>): FileReadSnapshot {
  return {
    mtimeMs: Number(info.mtimeMs),
    size: Number(info.size),
  }
}

function sameSnapshot(left: FileReadSnapshot, right: FileReadSnapshot): boolean {
  return left.mtimeMs === right.mtimeMs && left.size === right.size
}

function readRangeKey(context: ToolContext, file: string, offset: number | undefined, limit: number | undefined): string {
  return [fileReadTrackerKey(context), resolve(file), offset ?? "", limit ?? ""].join("\0")
}

function readRangeLabel(offset: number | undefined, limit: number | undefined): string {
  if (typeof offset !== "number" && typeof limit !== "number") return ""
  if (typeof limit !== "number") return `from line ${offset || 1}`
  return `lines ${offset || 1}-${(offset || 1) + Math.max(0, limit) - 1}`
}

function getFileReadReceipt(context: ToolContext, file: string, offset: number | undefined, limit: number | undefined, rangeKey: string): FileReadReceipt | undefined {
  const normalizedFile = resolve(file)
  if (context.sessionId && context.fileReadStore) {
    return context.fileReadStore.getFileReadReceipt({
      cwd: resolve(context.cwd),
      file: normalizedFile,
      limit: limit ?? null,
      offset: offset ?? null,
      sessionId: context.sessionId,
    })
  }

  return getFileReadTracker(context).returnedRanges.get(rangeKey)
}

function recordFileRead(context: ToolContext, file: string, snapshot: FileReadSnapshot, rangeKey: string, offset: number | undefined, limit: number | undefined): void {
  const normalizedCwd = resolve(context.cwd)
  const tracker = getFileReadTracker(context)
  const normalizedFile = resolve(file)
  const receipt: FileReadReceipt = {
    ...snapshot,
    displayPath: displayPath(normalizedCwd, normalizedFile),
  }
  if (context.sessionId && context.fileReadStore) {
    context.fileReadStore.recordFileRead({
      cwd: normalizedCwd,
      file: normalizedFile,
      limit: limit ?? null,
      offset: offset ?? null,
      sessionId: context.sessionId,
      ...receipt,
    })
  }
  tracker.latestByFile.set(normalizedFile, snapshot)
  tracker.returnedRanges.set(rangeKey, receipt)
}

async function staleWriteWarnings(context: ToolContext, files: string[]): Promise<string[]> {
  const uniqueFiles = [...new Set(files.map((file) => resolve(file)))]
  const warnings = await Promise.all(uniqueFiles.map((file) => staleWriteWarning(context, file)))
  return warnings.filter((warning): warning is string => Boolean(warning))
}

async function staleWriteWarning(context: ToolContext, file: string): Promise<string | undefined> {
  const normalizedFile = resolve(file)
  const previous =
    context.sessionId && context.fileReadStore
      ? context.fileReadStore.getFileReadSnapshot({
          cwd: resolve(context.cwd),
          file: normalizedFile,
          sessionId: context.sessionId,
        })
      : getFileReadTracker(context).latestByFile.get(normalizedFile)
  if (!previous) return undefined
  try {
    const current = fileSnapshot(await stat(normalizedFile))
    if (sameSnapshot(previous, current)) return undefined
    return `Warning: ${displayPath(context.cwd, normalizedFile)} changed since Furnace last read it before this write. The requested modification was still applied; re-read/review if that change was not expected.`
  } catch {
    return `Warning: ${displayPath(context.cwd, normalizedFile)} changed since Furnace last read it and was no longer readable before this write.`
  }
}

async function recordFileWrite(context: ToolContext, file: string): Promise<void> {
  const tracker = getFileReadTracker(context)
  const normalizedFile = resolve(file)
  for (const key of tracker.returnedRanges.keys()) {
    if (key.includes(`\0${normalizedFile}\0`)) tracker.returnedRanges.delete(key)
  }
  try {
    const snapshot = fileSnapshot(await stat(normalizedFile))
    if (context.sessionId && context.fileReadStore) {
      context.fileReadStore.recordFileWrite({
        cwd: resolve(context.cwd),
        file: normalizedFile,
        sessionId: context.sessionId,
        snapshot,
      })
    }
    tracker.latestByFile.set(normalizedFile, snapshot)
  } catch {
    if (context.sessionId && context.fileReadStore) {
      context.fileReadStore.recordFileWrite({
        cwd: resolve(context.cwd),
        file: normalizedFile,
        sessionId: context.sessionId,
      })
    }
    tracker.latestByFile.delete(normalizedFile)
  }
}

function patchTargets(cwd: string, patch: string): Array<{ file: string; kind: "add" | "delete" | "update" }> {
  const targets: Array<{ file: string; kind: "add" | "delete" | "update" }> = []
  for (const line of patch.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("*** Add File: ")) targets.push({ file: resolveToolPath(cwd, line.slice("*** Add File: ".length).trim()), kind: "add" })
    else if (line.startsWith("*** Update File: ")) targets.push({ file: resolveToolPath(cwd, line.slice("*** Update File: ".length).trim()), kind: "update" })
    else if (line.startsWith("*** Delete File: ")) targets.push({ file: resolveToolPath(cwd, line.slice("*** Delete File: ".length).trim()), kind: "delete" })
  }
  return targets
}

function objectSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required,
    properties,
  }
}

function arraySchema(items: Record<string, unknown>, description: string): Record<string, unknown> {
  return { type: "array", items, description }
}

function stringSchema(description: string): Record<string, unknown> {
  return { type: "string", description }
}

function numberSchema(description: string): Record<string, unknown> {
  return { type: "number", description }
}

function booleanSchema(description: string): Record<string, unknown> {
  return { type: "boolean", description }
}

function enumSchema(values: string[], description: string): Record<string, unknown> {
  return { type: "string", enum: values, description }
}

function requiredString(args: unknown, key: string): string {
  const value = getArg(args, key)
  if (typeof value !== "string") throw new Error(`Expected string argument: ${key}`)
  return value
}

function optionalString(args: unknown, key: string): string | undefined {
  const value = getArg(args, key)
  return typeof value === "string" ? value : undefined
}

function optionalNumber(args: unknown, key: string): number | undefined {
  const value = getArg(args, key)
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function optionalBoolean(args: unknown, key: string): boolean | undefined {
  const value = getArg(args, key)
  return typeof value === "boolean" ? value : undefined
}

function optionalEnum<TValue extends string>(args: unknown, key: string, values: readonly TValue[]): TValue | undefined {
  const value = getArg(args, key)
  return typeof value === "string" && values.includes(value as TValue) ? (value as TValue) : undefined
}

function getArg(args: unknown, key: string): unknown {
  return args && typeof args === "object" ? (args as Record<string, unknown>)[key] : undefined
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function globToRegExp(pattern: string): RegExp {
  let source = "^"
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    const next = pattern[index + 1]
    const afterNext = pattern[index + 2]
    if (char === "*" && next === "*" && afterNext === "/") {
      source += "(?:.*/)?"
      index += 2
      continue
    }
    if (char === "*" && next === "*") {
      source += ".*"
      index += 1
      continue
    }
    if (char === "*") {
      source += "[^/]*"
      continue
    }
    if (char === "?") {
      source += "[^/]"
      continue
    }
    source += escapeRegExp(char)
  }
  return new RegExp(`${source}$`)
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$+?.()|[\]{}]/g, "\\$&")
}

async function boundToolOutput(value: string, context: ToolContext): Promise<string> {
  const byteLength = Buffer.byteLength(value, "utf8")
  const lines = value.split("\n")
  if (byteLength <= maxToolOutputBytes && lines.length <= maxToolOutputLines) return value

  const artifact = await storeContextArtifact({ content: value, cwd: context.cwd, label: "tool-output" })
  return compressToolOutput({ artifact, content: value, maxBytes: maxToolOutputBytes, maxLines: maxToolOutputLines }).content
}

function boundedPreview(value: string, marker: string, maxLines: number, maxBytes: number): string {
  const markerOnly = takePrefix(marker, maxBytes).split("\n").slice(0, maxLines).join("\n")
  const markerBytes = Buffer.byteLength(marker, "utf8")
  if (maxLines <= 4 || maxBytes <= markerBytes + 4) return markerOnly

  const preview = splitPreview(value, maxLines - 4, maxBytes - markerBytes - 4)
  return preview.tail ? `${preview.head}\n\n${marker}\n\n${preview.tail}` : `${preview.head}\n\n${marker}`
}

function splitPreview(value: string, maxLines: number, maxBytes: number): { head: string; tail: string } {
  const lines = value.split("\n")
  const headLines = Math.ceil(maxLines / 2)
  const tailLines = Math.floor(maxLines / 2)
  const head = lines.slice(0, headLines).join("\n")
  const tail = lines.length > maxLines && tailLines > 0 ? lines.slice(lines.length - tailLines).join("\n") : ""
  const sampled = tail ? `${head}\n${tail}` : head
  if (Buffer.byteLength(sampled, "utf8") <= maxBytes) return { head, tail }
  return {
    head: takePrefix(head, Math.ceil(maxBytes / 2)),
    tail: tail ? takeSuffix(tail, Math.floor(maxBytes / 2)) : "",
  }
}

function takePrefix(value: string, maxBytes: number): string {
  let bytes = 0
  let output = ""
  for (const char of value) {
    const size = Buffer.byteLength(char, "utf8")
    if (bytes + size > maxBytes) break
    output += char
    bytes += size
  }
  return output
}

function takeSuffix(value: string, maxBytes: number): string {
  let bytes = 0
  const output: string[] = []
  for (const char of Array.from(value).reverse()) {
    const size = Buffer.byteLength(char, "utf8")
    if (bytes + size > maxBytes) break
    output.unshift(char)
    bytes += size
  }
  return output.join("")
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, max)}\n... truncated ${value.length - max} chars`
}

function formatCommandResult(exitCode: number | string, stdout: string, stderr: string): string {
  const parts = [`exit_code: ${exitCode}`]
  if (stdout) parts.push(`stdout:\n${stdout}`)
  if (stderr) parts.push(`stderr:\n${stderr}`)
  return parts.join("\n")
}
