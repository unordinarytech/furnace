import { formatAskQuestionResult, normalizeAskQuestionRequest } from "../questions.js"
import type { TodoItem, TodoPriority, TodoStatus } from "../session/types.js"
import type { TaskRunResult, TaskSpec } from "../tasks/types.js"
import { getArg, optionalBoolean, optionalString } from "./common.js"
import type { ToolContext, ToolHandlerResult } from "./types.js"

export async function askQuestionTool(args: unknown, context: ToolContext): Promise<string> {
  const request = normalizeAskQuestionRequest(args)
  if (!context.questionPrompt) {
    return "Question prompt UI is unavailable in this mode. Make a reasonable assumption or ask the user in the final response."
  }
  return formatAskQuestionResult(await context.questionPrompt(request))
}

export async function taskTool(args: unknown, context: ToolContext): Promise<ToolHandlerResult> {
  if (!context.taskRunner || !context.sessionId) return "Task delegation is unavailable in this mode."
  const tasks = normalizeTaskSpecs(args)
  if (tasks.length === 0) throw new Error("Expected at least one task prompt")
  const result = await context.taskRunner.runTasks({
    background: optionalBoolean(args, "background") || false,
    parentSessionId: context.sessionId,
    signal: context.signal,
    tasks,
  })
  return {
    content: formatTaskRunResult(result),
    control: result.backgrounded ? { backgrounded: true } : undefined,
  }
}

export async function taskStatusTool(_args: unknown, context: ToolContext): Promise<string> {
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

export async function todoReadTool(_args: unknown, context: ToolContext): Promise<string> {
  if (!context.todoStore || !context.sessionId) return "Todo state is unavailable in this mode."
  return formatTodoToolResult(context.todoStore.getTodoState(context.sessionId))
}

export async function todoWriteTool(args: unknown, context: ToolContext): Promise<string> {
  if (!context.todoStore || !context.sessionId) return "Todo state is unavailable in this mode."
  const todos = normalizeTodoItems(args)
  context.todoStore.appendTodoState(context.sessionId, todos)
  return formatTodoToolResult(todos)
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
