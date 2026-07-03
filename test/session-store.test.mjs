import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import assert from "node:assert/strict"
import { compactSessionIfNeeded } from "../dist/session/compaction.js"
import { SessionStore } from "../dist/session/store.js"

test("session store appends entries as a Pi-style active leaf chain", async () => {
  const dir = await mkdtemp(join(tmpdir(), "furnace-session-"))

  try {
    const store = SessionStore.open(dir)
    const session = store.createSession({ cwd: dir, title: "Test session" })

    const first = store.appendMessage(session.id, "user", "hello")
    const second = store.appendToolCall(session.id, { arguments: "{\"path\":\"notes.txt\"}", name: "read", toolCallId: "call_1" })
    const third = store.appendToolResult(session.id, { content: "1|hello", name: "read", toolCallId: "call_1" })
    const fourth = store.appendMessage(session.id, "assistant", "hi")
    const path = store.getActivePath(session.id)

    assert.equal(first.parentEntryId, null)
    assert.equal(second.parentEntryId, first.id)
    assert.equal(third.parentEntryId, second.id)
    assert.equal(fourth.parentEntryId, third.id)
    assert.deepEqual(
      path.map((entry) => entry.id),
      [first.id, second.id, third.id, fourth.id],
    )
    assert.equal(path.map((entry) => entry.type).join(","), "message,tool_call,tool_result,message")
    assert.equal(store.getSession(session.id).activeLeafId, fourth.id)

    store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("session store persists an image attachment's label through appendMessage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "furnace-session-"))

  try {
    const store = SessionStore.open(dir)
    const session = store.createSession({ cwd: dir, title: "Test session" })

    const entry = store.appendMessage(session.id, "user", "check [Image #1]", {
      images: [
        {
          id: "img-1",
          source: { type: "base64", media_type: "image/png", data: "AAA" },
          label: "1",
        },
      ],
    })

    assert.equal(entry.data.images[0].label, "1")

    const [reloaded] = store.getActivePath(session.id).slice(-1)
    assert.equal(reloaded.data.images[0].label, "1")

    store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("session store hides and cleans up empty sessions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "furnace-session-"))

  try {
    const store = SessionStore.open(dir)
    const empty = store.createSession({ cwd: dir, title: "New Chat" })
    const kept = store.createSession({ cwd: dir, title: "Kept Chat" })
    store.appendMessage(kept.id, "user", "hello")

    assert.deepEqual(
      store.listSessions(dir).map((session) => session.id),
      [kept.id],
    )

    store.deleteEmptySessions(dir)
    assert.throws(() => store.getSession(empty.id), /Session not found/)
    assert.equal(store.getSession(kept.id).id, kept.id)

    store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("session store records parent-linked child sessions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "furnace-session-"))

  try {
    const store = SessionStore.open(dir)
    const parent = store.createSession({ cwd: dir, title: "Parent" })
    const child = store.createSession({ cwd: dir, title: "Child", parentSessionId: parent.id })

    assert.equal(store.getSession(child.id).parentSessionId, parent.id)
    assert.equal(store.getSession(child.id).forkedFromEntryId, null)

    store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("compaction appends marker and clears file read state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "furnace-session-"))
  const originalFetch = globalThis.fetch

  try {
    globalThis.fetch = async () => {
      throw new Error("summarizer unavailable")
    }
    const store = SessionStore.open(dir)
    const session = store.createSession({ cwd: dir, title: "Compaction" })
    store.appendMessage(session.id, "user", "old " + "history ".repeat(30_000))
    const kept = store.appendMessage(session.id, "user", "current task")
    store.recordFileRead({
      cwd: dir,
      displayPath: "notes.txt",
      file: join(dir, "notes.txt"),
      limit: 10,
      mtimeMs: 1,
      offset: 1,
      sessionId: session.id,
      size: 5,
    })

    const result = await compactSessionIfNeeded({
      config: fakeConfig({ contextLength: 16_000 }),
      cwd: dir,
      force: true,
      reason: "manual",
      sessionId: session.id,
      store,
      systemPrompt: "base system",
      tools: [],
    })

    assert.ok(result.entry)
    assert.equal(result.entry.data.firstKeptEntryId, kept.id)
    assert.equal(result.entry.data.details.fallback, true)
    assert.equal(
      store.getFileReadReceipt({
        cwd: dir,
        file: join(dir, "notes.txt"),
        limit: 10,
        offset: 1,
        sessionId: session.id,
      }),
      undefined,
    )
    assert.equal(store.getActivePath(session.id).at(-1).type, "compaction")

    store.close()
  } finally {
    globalThis.fetch = originalFetch
    await rm(dir, { recursive: true, force: true })
  }
})

function fakeConfig(settings = {}) {
  return {
    appName: "Furnace Test",
    model: "test-model",
    modelSettings: settings,
    openRouterApiKey: "test-key",
    siteUrl: "http://localhost",
    skillPaths: [],
    subagentSystemPrompt: "subagent",
    systemPrompt: "system",
    theme: "flexoki",
    titleModel: "title-model",
    titleSystemPrompt: "title",
  }
}
