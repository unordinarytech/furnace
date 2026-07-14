import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { randomUUID } from "node:crypto"
import Database from "better-sqlite3"
import { ensureFurnaceStateExcluded } from "../git-exclude.js"
import type { ImageAttachment } from "../utils/images.js"
import type {
  EntryRecord,
  EntryRole,
  EntryType,
  FileReadFileKey,
  FileReadRangeKey,
  FileReadReceipt,
  FileReadRecord,
  FileReadSnapshot,
  CompactionEntryData,
  MessageEntryData,
  SessionRelationType,
  SessionRecord,
  TodoItem,
  TodoStateEntryData,
  ToolCallEntryData,
  ToolResultEntryData,
  TurnUsage,
} from "./types.js"

type AppendMessageOptions = {
  hidden?: boolean
  images?: ImageAttachment[]
  model?: string
  source?: string
  usage?: TurnUsage
}

type SessionRow = {
  id: string
  title: string
  cwd: string
  active_leaf_id: string | null
  parent_session_id: string | null
  forked_from_entry_id: string | null
  relation_type: SessionRelationType
  root_session_id: string | null
  created_at: number
  updated_at: number
  archived_at: number | null
}

type EntryRow = {
  id: string
  session_id: string
  parent_entry_id: string | null
  type: EntryType
  role: EntryRole
  created_at: number
  data: string
}

type FileReadFileRow = {
  cwd: string
  file_path: string
  mtime_ms: number
  session_id: string
  size: number
  updated_at: number
}

type FileReadRangeRow = FileReadFileRow & {
  display_path: string
  limit_key: string
  offset_key: string
}

export type ForkSessionResult = {
  forkedSession: SessionRecord
}

export type ForkPoint = {
  entry: EntryRecord<MessageEntryData>
  forkCount: number
}

export class SessionStore {
  private constructor(private readonly db: Database.Database) {}

  static open(cwd: string, dbPath = defaultDatabasePath(cwd)): SessionStore {
    ensureFurnaceStateExcluded(cwd)
    mkdirSync(dirname(dbPath), { recursive: true })
    const db = new Database(dbPath)
    const store = new SessionStore(db)
    store.migrate()
    return store
  }

  close(): void {
    this.db.close()
  }

  getOrCreateLatestSession(cwd: string): SessionRecord {
    const existing = this.db
      .prepare(
        `select * from sessions
         where cwd = ? and archived_at is null and active_leaf_id is not null
         order by updated_at desc
         limit 1`,
      )
      .get(cwd) as SessionRow | undefined

    if (existing) return mapSession(existing)
    return this.createSession({ cwd, title: "New Chat" })
  }

  listSessions(cwd: string): SessionRecord[] {
    const rows = this.db
      .prepare(
        `select * from sessions
         where cwd = ? and archived_at is null and active_leaf_id is not null
         order by updated_at desc`,
      )
      .all(cwd) as SessionRow[]

    return rows.map(mapSession)
  }

  listHistorySessions(cwd: string): SessionRecord[] {
    const rows = this.db
      .prepare(
        `select * from sessions
         where cwd = ? and archived_at is null and active_leaf_id is not null
           and (relation_type is null or relation_type = 'fork')
         order by updated_at desc`,
      )
      .all(cwd) as SessionRow[]

    return rows.map(mapSession)
  }

  listForkChildren(parentSessionId: string): SessionRecord[] {
    const rows = this.db
      .prepare(
        `select * from sessions
         where parent_session_id = ? and archived_at is null and relation_type = 'fork'
         order by updated_at desc`,
      )
      .all(parentSessionId) as SessionRow[]

    return rows.map(mapSession)
  }

  deleteEmptySessions(cwd: string): void {
    this.db.prepare("delete from sessions where cwd = ? and archived_at is null and active_leaf_id is null").run(cwd)
  }

  createSession(input: {
    cwd: string
    title: string
    parentSessionId?: string | null
    forkedFromEntryId?: string | null
    relationType?: SessionRelationType
    rootSessionId?: string | null
  }): SessionRecord {
    const now = Date.now()
    const session: SessionRecord = {
      id: makeId("ses"),
      title: input.title,
      cwd: input.cwd,
      activeLeafId: null,
      parentSessionId: input.parentSessionId ?? null,
      forkedFromEntryId: input.forkedFromEntryId ?? null,
      relationType: input.relationType ?? null,
      rootSessionId: input.rootSessionId ?? null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    }

    this.db
      .prepare(
        `insert into sessions (
          id, title, cwd, active_leaf_id, parent_session_id, forked_from_entry_id, relation_type, root_session_id, created_at, updated_at, archived_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.title,
        session.cwd,
        session.activeLeafId,
        session.parentSessionId,
        session.forkedFromEntryId,
        session.relationType,
        session.rootSessionId,
        session.createdAt,
        session.updatedAt,
        session.archivedAt,
      )

    return session
  }

  getSession(sessionId: string): SessionRecord {
    const row = this.db.prepare("select * from sessions where id = ?").get(sessionId) as SessionRow | undefined
    if (!row) throw new Error(`Session not found: ${sessionId}`)
    return mapSession(row)
  }

  updateSessionTitle(sessionId: string, title: string): void {
    const cleanTitle = title.trim().slice(0, 80)
    if (!cleanTitle) return

    this.db
      .prepare("update sessions set title = ?, updated_at = ? where id = ?")
      .run(cleanTitle, Date.now(), sessionId)
  }

  appendMessage(
    sessionId: string,
    role: "user" | "assistant",
    content: string,
    modelOrOptions?: string | AppendMessageOptions,
  ): EntryRecord<MessageEntryData> {
    const options = typeof modelOrOptions === "string" ? { model: modelOrOptions } : modelOrOptions || {}
    const { images: imageAttachments, ...entryOptions } = options
    const images = imageAttachments?.map((img) => {
      if (img.source.type === "base64") {
        return {
          type: "base64" as const,
          media_type: img.source.media_type,
          data: img.source.data,
          label: img.label,
        }
      }
      return {
        type: "url" as const,
        url: img.source.url,
        label: img.label,
      }
    })
    return this.appendEntry<MessageEntryData>(sessionId, "message", role, { content, images, ...entryOptions })
  }

  appendToolCall(sessionId: string, input: ToolCallEntryData): EntryRecord<ToolCallEntryData> {
    return this.appendEntry<ToolCallEntryData>(sessionId, "tool_call", "assistant", input)
  }

  appendToolResult(sessionId: string, input: ToolResultEntryData): EntryRecord<ToolResultEntryData> {
    return this.appendEntry<ToolResultEntryData>(sessionId, "tool_result", "tool", input)
  }

  appendCompaction(sessionId: string, input: CompactionEntryData): EntryRecord<CompactionEntryData> {
    return this.appendEntry<CompactionEntryData>(sessionId, "compaction", "system", input)
  }

  appendTodoState(sessionId: string, todos: TodoItem[]): EntryRecord<TodoStateEntryData> {
    return this.appendEntry<TodoStateEntryData>(sessionId, "custom", null, {
      kind: "todo_state",
      todos,
      updatedAt: Date.now(),
    })
  }

  getTodoState(sessionId: string): TodoItem[] {
    const path = this.getActivePath(sessionId)
    for (let index = path.length - 1; index >= 0; index -= 1) {
      const entry = path[index]
      if (entry.type !== "custom") continue
      const data = entry.data as Partial<TodoStateEntryData>
      if (data.kind !== "todo_state" || !Array.isArray(data.todos)) continue
      return data.todos.map((todo) => ({ ...todo }))
    }
    return []
  }

  getFileReadReceipt(input: FileReadRangeKey): FileReadReceipt | undefined {
    const row = this.db
      .prepare(
        `select * from file_read_ranges
         where session_id = ? and cwd = ? and file_path = ? and offset_key = ? and limit_key = ?`,
      )
      .get(input.sessionId, input.cwd, input.file, rangePartKey(input.offset), rangePartKey(input.limit)) as FileReadRangeRow | undefined
    if (!row) return undefined
    return {
      displayPath: row.display_path,
      mtimeMs: row.mtime_ms,
      size: row.size,
    }
  }

  getFileReadSnapshot(input: FileReadFileKey): FileReadSnapshot | undefined {
    const row = this.db
      .prepare(
        `select * from file_read_files
         where session_id = ? and cwd = ? and file_path = ?`,
      )
      .get(input.sessionId, input.cwd, input.file) as FileReadFileRow | undefined
    if (!row) return undefined
    return {
      mtimeMs: row.mtime_ms,
      size: row.size,
    }
  }

  recordFileRead(input: FileReadRecord): void {
    const now = Date.now()
    const transaction = this.db.transaction(() => {
      this.db
        .prepare(
          `insert into file_read_files (session_id, cwd, file_path, mtime_ms, size, updated_at)
           values (?, ?, ?, ?, ?, ?)
           on conflict(session_id, cwd, file_path) do update set
             mtime_ms = excluded.mtime_ms,
             size = excluded.size,
             updated_at = excluded.updated_at`,
        )
        .run(input.sessionId, input.cwd, input.file, input.mtimeMs, input.size, now)

      this.db
        .prepare(
          `insert into file_read_ranges (
            session_id, cwd, file_path, offset_key, limit_key, mtime_ms, size, display_path, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict(session_id, cwd, file_path, offset_key, limit_key) do update set
            mtime_ms = excluded.mtime_ms,
            size = excluded.size,
            display_path = excluded.display_path,
            updated_at = excluded.updated_at`,
        )
        .run(
          input.sessionId,
          input.cwd,
          input.file,
          rangePartKey(input.offset),
          rangePartKey(input.limit),
          input.mtimeMs,
          input.size,
          input.displayPath,
          now,
        )
    })
    transaction()
  }

  recordFileWrite(input: FileReadFileKey & { snapshot?: FileReadSnapshot }): void {
    const now = Date.now()
    const transaction = this.db.transaction(() => {
      this.db.prepare("delete from file_read_ranges where session_id = ? and cwd = ? and file_path = ?").run(input.sessionId, input.cwd, input.file)

      if (input.snapshot) {
        this.db
          .prepare(
            `insert into file_read_files (session_id, cwd, file_path, mtime_ms, size, updated_at)
             values (?, ?, ?, ?, ?, ?)
             on conflict(session_id, cwd, file_path) do update set
               mtime_ms = excluded.mtime_ms,
               size = excluded.size,
               updated_at = excluded.updated_at`,
          )
          .run(input.sessionId, input.cwd, input.file, input.snapshot.mtimeMs, input.snapshot.size, now)
      } else {
        this.db.prepare("delete from file_read_files where session_id = ? and cwd = ? and file_path = ?").run(input.sessionId, input.cwd, input.file)
      }
    })
    transaction()
  }

  clearFileReadState(sessionId: string): void {
    const transaction = this.db.transaction(() => {
      this.db.prepare("delete from file_read_ranges where session_id = ?").run(sessionId)
      this.db.prepare("delete from file_read_files where session_id = ?").run(sessionId)
    })
    transaction()
  }

  appendEntry<TData>(sessionId: string, type: EntryType, role: EntryRole, data: TData): EntryRecord<TData> {
    const session = this.getSession(sessionId)
    const now = Date.now()
    const entry: EntryRecord<TData> = {
      id: makeId("ent"),
      sessionId,
      parentEntryId: session.activeLeafId,
      type,
      role,
      createdAt: now,
      data,
    }

    // Pi-style rule: every new entry is a child of the current active leaf,
    // then the active leaf advances to the new entry.
    const transaction = this.db.transaction(() => {
      this.db
        .prepare(
          `insert into entries (id, session_id, parent_entry_id, type, role, created_at, data)
           values (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(entry.id, entry.sessionId, entry.parentEntryId, entry.type, entry.role, entry.createdAt, JSON.stringify(entry.data))

      this.db
        .prepare("update sessions set active_leaf_id = ?, updated_at = ? where id = ?")
        .run(entry.id, now, sessionId)
    })

    transaction()
    return entry
  }

  updateEntryData<TData>(entryId: string, data: TData): void {
    this.db.prepare("update entries set data = ? where id = ?").run(JSON.stringify(data), entryId)
  }

  getActivePath(sessionId: string): EntryRecord[] {
    const session = this.getSession(sessionId)
    if (!session.activeLeafId) return []

    const rows = this.db.prepare("select * from entries where session_id = ?").all(sessionId) as EntryRow[]
    const byId = new Map(rows.map((row) => [row.id, row]))
    const path: EntryRow[] = []
    let current = byId.get(session.activeLeafId)

    while (current) {
      path.unshift(current)
      current = current.parent_entry_id ? byId.get(current.parent_entry_id) : undefined
    }

    return path.map(mapEntry)
  }

  listEntries(sessionId: string): EntryRecord[] {
    const rows = this.db
      .prepare("select * from entries where session_id = ? order by created_at asc, id asc")
      .all(sessionId) as EntryRow[]
    return rows.map(mapEntry)
  }

  listForkPoints(sessionId: string): ForkPoint[] {
    const session = this.getSession(sessionId)
    if (session.relationType === "fork") return []
    const forkCounts = new Map<string, number>()
    for (const child of this.listForkChildren(sessionId)) {
      if (!child.forkedFromEntryId) continue
      forkCounts.set(child.forkedFromEntryId, (forkCounts.get(child.forkedFromEntryId) || 0) + 1)
    }
    const activePath = this.getActivePath(sessionId)
    return activePath
      .filter((entry): entry is EntryRecord<MessageEntryData> => entry.type === "message" && entry.role === "user")
      .filter((entry) => hasActualConversationBefore(activePath, entry.id))
      .map((entry) => ({ entry, forkCount: forkCounts.get(entry.id) || 0 }))
      .reverse()
  }

  forkSession(input: {
    position?: "before" | "at"
    sourceEntryId?: string | null
    sourceSessionId: string
    title?: string
  }): ForkSessionResult {
    const sourceSession = this.getSession(input.sourceSessionId)
    if (sourceSession.relationType === "fork") throw new Error("Forking from a fork is not supported yet. Resume the original conversation to create another level-one fork.")
    const position = input.position || "at"
    const sourcePath = this.getActivePath(input.sourceSessionId)
    if (sourcePath.length === 0) throw new Error("Cannot fork an empty session")
    if (!hasActualConversation(sourcePath)) throw new Error("Cannot fork until the chat has an actual conversation with at least one user prompt and assistant response")

    const sourceIndex = input.sourceEntryId
      ? sourcePath.findIndex((entry) => entry.id === input.sourceEntryId)
      : sourcePath.length - 1
    if (sourceIndex < 0) throw new Error(`Fork source entry is not on the active path: ${input.sourceEntryId}`)

    const sourceEntry = sourcePath[sourceIndex]
    if (position === "before" && (sourceEntry.type !== "message" || sourceEntry.role !== "user")) {
      throw new Error("Forking before an entry requires a user message")
    }

    const boundaryIndex = position === "before" ? sourceIndex - 1 : sourceIndex
    const entriesToCopy = boundaryIndex >= 0 ? sourcePath.slice(0, boundaryIndex + 1) : []
    if (!hasActualConversation(entriesToCopy)) throw new Error("Cannot fork before this prompt because there is no earlier assistant response to preserve")
    const now = Date.now()
    const forkedSession: SessionRecord = {
      id: makeId("ses"),
      title: (input.title || forkTitle(sourceSession.title, position === "before" && sourceEntry.type === "message" ? (sourceEntry.data as MessageEntryData).content : undefined)).trim().slice(0, 80),
      cwd: sourceSession.cwd,
      activeLeafId: null,
      parentSessionId: sourceSession.id,
      forkedFromEntryId: sourceEntry.id,
      relationType: "fork",
      rootSessionId: sourceSession.rootSessionId || sourceSession.id,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    }

    const idMap = new Map<string, string>()
    const copiedRows = entriesToCopy.map((entry) => {
      const id = makeId("ent")
      idMap.set(entry.id, id)
      return { entry, id }
    })

    const transaction = this.db.transaction(() => {
      this.db
        .prepare(
          `insert into sessions (
            id, title, cwd, active_leaf_id, parent_session_id, forked_from_entry_id, relation_type, root_session_id, created_at, updated_at, archived_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          forkedSession.id,
          forkedSession.title,
          forkedSession.cwd,
          null,
          forkedSession.parentSessionId,
          forkedSession.forkedFromEntryId,
          forkedSession.relationType,
          forkedSession.rootSessionId,
          forkedSession.createdAt,
          forkedSession.updatedAt,
          forkedSession.archivedAt,
        )

      for (const { entry, id } of copiedRows) {
        const parentEntryId = entry.parentEntryId ? idMap.get(entry.parentEntryId) || null : null
        this.db
          .prepare(
            `insert into entries (id, session_id, parent_entry_id, type, role, created_at, data)
             values (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(id, forkedSession.id, parentEntryId, entry.type, entry.role, entry.createdAt, JSON.stringify(entry.data))
        forkedSession.activeLeafId = id
      }

      this.db
        .prepare("update sessions set active_leaf_id = ?, updated_at = ? where id = ?")
        .run(forkedSession.activeLeafId, now, forkedSession.id)
    })
    transaction()

    return { forkedSession }
  }

  private migrate(): void {
    this.db.exec(`
      pragma journal_mode = WAL;

      create table if not exists sessions (
        id text primary key,
        title text not null,
        cwd text not null,
        active_leaf_id text,
        -- Relationship parent. Interpret with relation_type; forks and subagents both use it.
        parent_session_id text,
        -- Entry id in the parent session where a new forked session begins.
        -- Fork creation should copy/replay only the root-to-forked_from_entry_id path.
        forked_from_entry_id text,
        relation_type text,
        root_session_id text,
        created_at integer not null,
        updated_at integer not null,
        archived_at integer
      );

    `)

    this.backfillSessionSchema()

    this.db.exec(`

      create index if not exists sessions_cwd_updated_idx on sessions (cwd, updated_at);
      create index if not exists sessions_parent_idx on sessions (parent_session_id);
      create index if not exists sessions_relation_idx on sessions (cwd, relation_type, updated_at);

      create table if not exists entries (
        id text primary key,
        session_id text not null references sessions(id) on delete cascade,
        parent_entry_id text,
        type text not null,
        role text,
        created_at integer not null,
        data text not null
      );

      create index if not exists entries_session_created_idx on entries (session_id, created_at, id);
      create index if not exists entries_parent_idx on entries (session_id, parent_entry_id);

      create table if not exists file_read_files (
        session_id text not null references sessions(id) on delete cascade,
        cwd text not null,
        file_path text not null,
        mtime_ms real not null,
        size integer not null,
        updated_at integer not null,
        primary key (session_id, cwd, file_path)
      );

      create table if not exists file_read_ranges (
        session_id text not null references sessions(id) on delete cascade,
        cwd text not null,
        file_path text not null,
        offset_key text not null,
        limit_key text not null,
        mtime_ms real not null,
        size integer not null,
        display_path text not null,
        updated_at integer not null,
        primary key (session_id, cwd, file_path, offset_key, limit_key)
      );

      create index if not exists file_read_ranges_file_idx on file_read_ranges (session_id, cwd, file_path);
    `)
  }

  private backfillSessionSchema(): void {
    try {
      this.db.prepare("alter table sessions add column relation_type text").run()
    } catch {}
    try {
      this.db.prepare("alter table sessions add column root_session_id text").run()
    } catch {}
    this.db
      .prepare("update sessions set relation_type = 'subagent' where parent_session_id is not null and relation_type is null")
      .run()
  }
}

export function defaultDatabasePath(cwd: string): string {
  return join(cwd, ".furnace", "furnace.sqlite")
}

function mapSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    title: row.title,
    cwd: row.cwd,
    activeLeafId: row.active_leaf_id,
    parentSessionId: row.parent_session_id,
    forkedFromEntryId: row.forked_from_entry_id,
    relationType: row.relation_type ?? null,
    rootSessionId: row.root_session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  }
}

function mapEntry(row: EntryRow): EntryRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    parentEntryId: row.parent_entry_id,
    type: row.type,
    role: row.role,
    createdAt: row.created_at,
    data: JSON.parse(row.data) as unknown,
  }
}

function makeId(prefix: string): string {
  return `${prefix}_${randomUUID()}`
}

function forkTitle(parentTitle: string, prompt?: string): string {
  const summary = prompt?.trim().replace(/\s+/g, " ").slice(0, 48)
  if (summary) return `Fork: ${summary}`
  const base = parentTitle.trim() || "Conversation"
  return `${base} (fork)`
}

function hasActualConversation(entries: EntryRecord[]): boolean {
  const hasUser = entries.some((entry) => entry.type === "message" && entry.role === "user" && messageContent(entry).trim())
  const hasAssistant = entries.some((entry) => entry.type === "message" && entry.role === "assistant" && messageContent(entry).trim())
  return hasUser && hasAssistant
}

function hasActualConversationBefore(entries: EntryRecord[], entryId: string): boolean {
  const index = entries.findIndex((entry) => entry.id === entryId)
  if (index <= 0) return false
  return hasActualConversation(entries.slice(0, index))
}

function messageContent(entry: EntryRecord): string {
  const data = entry.data as Partial<MessageEntryData>
  return typeof data.content === "string" ? data.content : ""
}

function rangePartKey(value: number | null | undefined): string {
  return typeof value === "number" ? String(value) : ""
}
