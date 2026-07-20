import { Text } from "@earendil-works/pi-tui"
import { getTextOutput } from "../render-utils.js"
import type { Theme } from "../theme.js"
import type { ToolDefinition } from "./types.js"

type TodoStatus = "cancelled" | "completed" | "in_progress" | "pending"

type TodoPreviewItem = {
  content: string
  status: TodoStatus
}

export function createTodoToolDefinition(name: "todoread" | "todowrite"): ToolDefinition {
  return {
    name,
    label: name === "todoread" ? "Read todos" : "Update todos",
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0)
      if (name === "todoread") {
        text.setText(context.isPartial ? theme.fg("warning", "◆ Reading todos") : "")
        return text
      }
      text.setText(renderTodos(parseTodoItems(args), context.isPartial ? "Updating" : "Updated", theme, context.expanded))
      return text
    },
    renderResult(result, options, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0)
      if (name === "todowrite") {
        text.setText("")
        return text
      }
      const todos = parseTodoItemsFromJson(getTextOutput(result, false))
      text.setText(renderTodos(todos, "Read", theme, options.expanded))
      return text
    },
  }
}

function renderTodos(todos: TodoPreviewItem[], verb: "Read" | "Updated" | "Updating", theme: Theme, expanded: boolean): string {
  const activeCount = todos.filter((todo) => todo.status === "in_progress").length
  const doneCount = todos.filter((todo) => todo.status === "completed").length
  const glyph = verb === "Updating" ? theme.fg("warning", "◆") : theme.fg("success", "✓")
  const counts = todos.length === 0
    ? theme.fg("muted", "none")
    : `${theme.fg("warning", `${activeCount} active`)} ${theme.fg("dim", "·")} ${theme.fg("success", `${doneCount} done`)}`
  const rows = [`${glyph} ${theme.fg("toolTitle", theme.bold(`${verb} todos`))} ${theme.fg("dim", "·")} ${counts}`]
  const visible = expanded ? todos : todos.slice(0, 12)
  for (const todo of visible) rows.push(renderTodo(todo, theme))
  if (visible.length < todos.length) rows.push(theme.fg("muted", `  … ${todos.length - visible.length} more`))
  return rows.join("\n")
}

function renderTodo(todo: TodoPreviewItem, theme: Theme): string {
  if (todo.status === "completed") return `  ${theme.fg("success", "✓")} ${theme.fg("muted", todo.content)}`
  if (todo.status === "in_progress") return `  ${theme.fg("warning", "◐")} ${theme.fg("toolOutput", theme.bold(todo.content))}`
  if (todo.status === "cancelled") return `  ${theme.fg("muted", "⊘")} ${theme.fg("dim", todo.content)}`
  return `  ${theme.fg("dim", "○")} ${theme.fg("toolOutput", todo.content)}`
}

function parseTodoItems(value: unknown): TodoPreviewItem[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return []
  return normalizeTodoArray((value as Record<string, unknown>).todos)
}

function parseTodoItemsFromJson(source: string): TodoPreviewItem[] {
  try {
    return parseTodoItems(JSON.parse(source))
  } catch {
    return []
  }
}

function normalizeTodoArray(value: unknown): TodoPreviewItem[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return []
    const record = item as Record<string, unknown>
    const content = typeof record.content === "string"
      ? record.content
      : typeof record.title === "string"
        ? record.title
        : ""
    if (!content) return []
    return [{ content, status: normalizeTodoStatus(record.status) }]
  })
}

function normalizeTodoStatus(value: unknown): TodoStatus {
  const status = typeof value === "string" ? value.toLowerCase().replace(/[ -]/g, "_") : "pending"
  if (status === "completed" || status === "complete" || status === "done") return "completed"
  if (status === "in_progress" || status === "current" || status === "running" || status === "active") return "in_progress"
  if (status === "cancelled" || status === "canceled" || status === "abandoned") return "cancelled"
  return "pending"
}
