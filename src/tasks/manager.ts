import type { TaskRecord, TaskRunInput, TaskRunner, TaskRunResult, TaskSpec, TaskStatusSnapshot } from "./types.js"

type TaskGroup = {
  backgrounded: boolean
  backgroundedWaiter: Deferred<TaskRunResult>
  completion: Promise<void>
  controllers: AbortController[]
  id: string
  parentSessionId: string
  records: TaskRecord[]
}

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

export type TaskManagerOptions = {
  createChildTask(input: { description: string; index: number; parentSessionId: string; prompt: string }): TaskRecord
  executeChildTask(record: TaskRecord, signal: AbortSignal): Promise<string>
  onGroupComplete?: (group: { backgrounded: boolean; id: string; parentSessionId: string; records: TaskRecord[] }) => void
  onUpdate?: (snapshot: TaskStatusSnapshot) => void
}

export class TaskManager implements TaskRunner {
  private readonly groups = new Map<string, TaskGroup>()
  private readonly recent = new Map<string, TaskRecord[]>()

  constructor(private readonly options: TaskManagerOptions) {}

  async runTasks(input: TaskRunInput): Promise<TaskRunResult> {
    const group = this.createGroup(input)
    this.groups.set(group.id, group)
    this.publish(input.parentSessionId)
    const abort = () => {
      if (group.backgrounded) return
      for (const controller of group.controllers) controller.abort()
    }
    if (input.signal?.aborted) abort()
    else input.signal?.addEventListener("abort", abort, { once: true })

    group.completion = Promise.all(group.records.map((record, index) => this.runOne(group, record, group.controllers[index].signal))).then(() => {
      input.signal?.removeEventListener("abort", abort)
      this.groups.delete(group.id)
      this.remember(group.parentSessionId, group.records)
      this.publish(group.parentSessionId)
      this.options.onGroupComplete?.({ backgrounded: group.backgrounded, id: group.id, parentSessionId: group.parentSessionId, records: group.records.map(copyTaskRecord) })
    })

    if (input.background) {
      this.markBackgrounded(group)
      return { backgrounded: true, groupId: group.id, tasks: group.records.map(copyTaskRecord) }
    }

    return Promise.race([
      group.completion.then(() => ({ backgrounded: false, groupId: group.id, tasks: group.records.map(copyTaskRecord) })),
      group.backgroundedWaiter.promise,
    ])
  }

  promoteActiveGroup(parentSessionId: string): boolean {
    const group = [...this.groups.values()].find((candidate) => candidate.parentSessionId === parentSessionId && !candidate.backgrounded)
    if (!group) return false
    this.markBackgrounded(group)
    return true
  }

  status(parentSessionId: string): TaskStatusSnapshot {
    const active = [...this.groups.values()].filter((group) => group.parentSessionId === parentSessionId)
    const recent = this.recent.get(parentSessionId) || []
    return {
      activeGroupId: active[0]?.id,
      parentSessionId,
      tasks: [...active.flatMap((group) => group.records), ...recent].map(copyTaskRecord),
    }
  }

  private createGroup(input: TaskRunInput): TaskGroup {
    const id = makeTaskId("group")
    const records = input.tasks.map((task, index) => {
      const description = taskDescription(task, index)
      return this.options.createChildTask({
        description,
        index,
        parentSessionId: input.parentSessionId,
        prompt: task.prompt,
      })
    })

    return {
      backgrounded: false,
      backgroundedWaiter: deferred<TaskRunResult>(),
      completion: Promise.resolve(),
      controllers: records.map(() => new AbortController()),
      id,
      parentSessionId: input.parentSessionId,
      records,
    }
  }

  private async runOne(group: TaskGroup, record: TaskRecord, signal: AbortSignal): Promise<void> {
    try {
      const result = await this.options.executeChildTask(record, signal)
      record.result = result
      record.status = "completed"
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error)
      record.status = isAbortError(error) ? "cancelled" : "failed"
    } finally {
      record.completedAt = Date.now()
      this.publish(group.parentSessionId)
    }
  }

  private markBackgrounded(group: TaskGroup): void {
    if (group.backgrounded) return
    group.backgrounded = true
    for (const record of group.records) {
      record.background = true
      if (record.status === "running") record.status = "backgrounded"
    }
    const result = { backgrounded: true, groupId: group.id, tasks: group.records.map(copyTaskRecord) }
    group.backgroundedWaiter.resolve(result)
    this.publish(group.parentSessionId)
  }

  private remember(parentSessionId: string, records: TaskRecord[]): void {
    const next = [...records.map(copyTaskRecord), ...(this.recent.get(parentSessionId) || [])].slice(0, 20)
    this.recent.set(parentSessionId, next)
  }

  private publish(parentSessionId: string): void {
    this.options.onUpdate?.(this.status(parentSessionId))
  }
}

export function makeTaskId(prefix = "task"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function taskDescription(task: TaskSpec, index: number): string {
  const explicit = task.description?.trim()
  if (explicit) return explicit.slice(0, 80)
  const firstLine = task.prompt.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
  return (firstLine || `Task ${index + 1}`).slice(0, 80)
}

function copyTaskRecord(record: TaskRecord): TaskRecord {
  return { ...record }
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && (error.name === "AbortError" || /aborted|interrupted/i.test(error.message))
}
