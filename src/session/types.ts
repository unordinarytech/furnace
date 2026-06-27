export type SessionRecord = {
  id: string
  title: string
  cwd: string
  activeLeafId: string | null
  // Set only when this session is a new conversation forked from another session.
  // Same-session branching should move activeLeafId instead.
  parentSessionId: string | null
  // Entry id in the parent session where the fork begins. Fork creation should
  // copy/replay only the root-to-this-entry path from the parent session.
  forkedFromEntryId: string | null
  createdAt: number
  updatedAt: number
  archivedAt: number | null
}

export type EntryType = "message" | "tool_call" | "tool_result" | "compaction" | "branch_summary" | "model_change" | "custom"

export type EntryRole = "user" | "assistant" | "system" | "tool" | null

export type EntryRecord<TData = unknown> = {
  id: string
  sessionId: string
  parentEntryId: string | null
  type: EntryType
  role: EntryRole
  createdAt: number
  data: TData
}

export type MessageEntryData = {
  content: string
  images?: Array<{
    type: "base64" | "url"
    media_type?: string
    data?: string
    url?: string
  }>
  hidden?: boolean
  model?: string
  source?: string
}

export type ToolCallEntryData = {
  arguments: string
  content?: string | null
  name: string
  toolCallId: string
}

export type ToolResultEntryData = {
  content: string
  name: string
  toolCallId: string
}

export type CompactionEntryData = {
  details?: {
    fallback?: boolean
    modifiedFiles?: string[]
    readFiles?: string[]
    summarizedEntryCount?: number
  }
  firstKeptEntryId: string
  focus?: string
  kind: "context_compaction"
  model: string
  reason: "manual" | "threshold" | "overflow"
  summary: string
  tokensAfter?: number
  tokensBefore: number
}

export type FileReadSnapshot = {
  mtimeMs: number
  size: number
}

export type FileReadReceipt = FileReadSnapshot & {
  displayPath: string
}

export type FileReadRangeKey = {
  cwd: string
  file: string
  limit?: number | null
  offset?: number | null
  sessionId: string
}

export type FileReadRecord = FileReadRangeKey &
  FileReadReceipt

export type FileReadFileKey = {
  cwd: string
  file: string
  sessionId: string
}

export type TranscriptMessage = {
  role: "user" | "assistant"
  content: string
  imageCount?: number
}
