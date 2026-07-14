export type TaskStatus = "running" | "backgrounded" | "completed" | "failed" | "cancelled"

export type TaskSpec = {
  description?: string
  prompt: string
}

export type TaskRunInput = {
  background?: boolean
  parentSessionId: string
  signal?: AbortSignal
  tasks: TaskSpec[]
}

export type TaskRecord = {
  background: boolean
  childSessionId: string
  completedAt?: number
  description: string
  error?: string
  id: string
  lastToolName?: string
  parentSessionId: string
  prompt: string
  result?: string
  startedAt: number
  status: TaskStatus
}

export type TaskRunResult = {
  backgrounded: boolean
  groupId: string
  tasks: TaskRecord[]
}

export type TaskStatusSnapshot = {
  activeGroupId?: string
  parentSessionId: string
  tasks: TaskRecord[]
}

export type TaskRunner = {
  promoteActiveGroup(parentSessionId: string): boolean
  runTasks(input: TaskRunInput): Promise<TaskRunResult>
  status(parentSessionId: string): TaskStatusSnapshot
}
