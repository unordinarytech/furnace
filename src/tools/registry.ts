import { bashTool } from "./bash.js"
import { booleanSchema, boundToolOutput, enumSchema, numberSchema, objectSchema, stringSchema, arraySchema } from "./common.js"
import { contextRetrieveTool, editTool, readTool, writeTool } from "./file.js"
import { findTool, globTool, grepTool, lsTool } from "./search.js"
import { skillManageTool, skillTool } from "./skills.js"
import { askQuestionTool, taskStatusTool, taskTool, todoReadTool, todoWriteTool } from "./tasks.js"
import type { RegisteredTool, ToolCallInput, ToolContext, ToolDefinition, ToolExecution } from "./types.js"
import { webfetchTool, websearchTool } from "./web.js"

export type {
  RegisteredTool,
  ToolCallInput,
  ToolContext,
  ToolDefinition,
  ToolExecution,
  ToolFileReadStore,
  ToolHandler,
  ToolServices,
  ToolTodoStore,
} from "./types.js"

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
  if (!tool) return { name: call.name, content: `Unknown tool: ${call.name}`, status: "error" }

  try {
    const args = call.arguments.trim() ? JSON.parse(call.arguments) : {}
    const handlerResult = await tool.execute(args, context)
    const content = typeof handlerResult === "string" ? handlerResult : handlerResult.content
    return {
      name: call.name,
      content: await boundToolOutput(content, context),
      control: typeof handlerResult === "string" ? undefined : handlerResult.control,
      status: "success",
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { name: call.name, content: `Tool ${call.name} failed: ${message}`, status: "error" }
  }
}
