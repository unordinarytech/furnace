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

export type EntryType = "message" | "compaction" | "branch_summary" | "model_change" | "custom"

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
  model?: string
}

export type TranscriptMessage = {
  role: "user" | "assistant"
  content: string
}
