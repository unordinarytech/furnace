import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { randomUUID } from "node:crypto"
import Database from "better-sqlite3"
import type { EntryRecord, EntryRole, EntryType, MessageEntryData, SessionRecord } from "./types.js"

type SessionRow = {
  id: string
  title: string
  cwd: string
  active_leaf_id: string | null
  parent_session_id: string | null
  forked_from_entry_id: string | null
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

export class SessionStore {
  private constructor(private readonly db: Database.Database) {}

  static open(cwd: string, dbPath = defaultDatabasePath(cwd)): SessionStore {
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

  deleteEmptySessions(cwd: string): void {
    this.db.prepare("delete from sessions where cwd = ? and archived_at is null and active_leaf_id is null").run(cwd)
  }

  createSession(input: {
    cwd: string
    title: string
    parentSessionId?: string | null
    forkedFromEntryId?: string | null
  }): SessionRecord {
    const now = Date.now()
    const session: SessionRecord = {
      id: makeId("ses"),
      title: input.title,
      cwd: input.cwd,
      activeLeafId: null,
      parentSessionId: input.parentSessionId ?? null,
      forkedFromEntryId: input.forkedFromEntryId ?? null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    }

    this.db
      .prepare(
        `insert into sessions (
          id, title, cwd, active_leaf_id, parent_session_id, forked_from_entry_id, created_at, updated_at, archived_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.title,
        session.cwd,
        session.activeLeafId,
        session.parentSessionId,
        session.forkedFromEntryId,
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

  appendMessage(sessionId: string, role: "user" | "assistant", content: string, model?: string): EntryRecord<MessageEntryData> {
    return this.appendEntry<MessageEntryData>(sessionId, "message", role, { content, model })
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

  private migrate(): void {
    this.db.exec(`
      pragma journal_mode = WAL;

      create table if not exists sessions (
        id text primary key,
        title text not null,
        cwd text not null,
        active_leaf_id text,
        -- Used when this session is created as a new conversation fork from another session.
        -- Same-session branching should only move active_leaf_id; it should not set parent_session_id.
        parent_session_id text,
        -- Entry id in the parent session where a new forked session begins.
        -- Fork creation should copy/replay only the root-to-forked_from_entry_id path.
        forked_from_entry_id text,
        created_at integer not null,
        updated_at integer not null,
        archived_at integer
      );

      create index if not exists sessions_cwd_updated_idx on sessions (cwd, updated_at);
      create index if not exists sessions_parent_idx on sessions (parent_session_id);

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
    `)
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
