import type { AskQuestionPrompt } from "../questions.js"
import type { FileReadFileKey, FileReadReceipt, FileReadRecord, FileReadSnapshot, TodoItem } from "../session/types.js"
import type { TaskRunner } from "../tasks/types.js"

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
  control?: {
    backgrounded?: boolean
  }
  name: string
  status: "error" | "success"
}

export type ToolHandlerResult = string | {
  content: string
  control?: ToolExecution["control"]
}

export type ToolDefinition = {
  type: "function"
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export type ToolHandler = (args: unknown, context: ToolContext) => Promise<ToolHandlerResult>

export type RegisteredTool = {
  definition: ToolDefinition
  execute: ToolHandler
}
