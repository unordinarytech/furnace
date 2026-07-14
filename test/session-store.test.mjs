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

test("session store only exposes fork points after actual conversation has happened", async () => {
  const dir = await mkdtemp(join(tmpdir(), "furnace-session-"))

  try {
    const store = SessionStore.open(dir)
    const session = store.createSession({ cwd: dir, title: "Fork guards" })

    assert.throws(() => store.forkSession({ sourceSessionId: session.id }), /empty session/)

    store.appendMessage(session.id, "user", "first prompt")
    assert.equal(store.listForkPoints(session.id).length, 0)
    assert.throws(() => store.forkSession({ sourceSessionId: session.id }), /actual conversation/)

    store.appendMessage(session.id, "assistant", "first answer")
    const second = store.appendMessage(session.id, "user", "second prompt")
    assert.deepEqual(store.listForkPoints(session.id).map((point) => point.entry.id), [second.id])

    store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("session store blocks forking from fork sessions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "furnace-session-"))

  try {
    const store = SessionStore.open(dir)
    const parent = store.createSession({ cwd: dir, title: "Parent" })
    store.appendMessage(parent.id, "user", "first prompt")
    store.appendMessage(parent.id, "assistant", "first answer")
    const second = store.appendMessage(parent.id, "user", "second prompt")

    const fork = store.forkSession({ position: "before", sourceEntryId: second.id, sourceSessionId: parent.id }).forkedSession
    assert.equal(store.listForkPoints(fork.id).length, 0)
    assert.throws(() => store.forkSession({ sourceSessionId: fork.id }), /Forking from a fork is not supported/)

    store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("session store forks before a selected user prompt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "furnace-session-"))

  try {
    const store = SessionStore.open(dir)
    const parent = store.createSession({ cwd: dir, title: "Main work" })
    const first = store.appendMessage(parent.id, "user", "first prompt")
    store.appendMessage(parent.id, "assistant", "first answer")
    const selected = store.appendMessage(parent.id, "user", "try sqlite instead")
    store.appendMessage(parent.id, "assistant", "sqlite answer")

    const result = store.forkSession({ position: "before", sourceEntryId: selected.id, sourceSessionId: parent.id })
    const fork = store.getSession(result.forkedSession.id)
    const forkPath = store.getActivePath(fork.id)

    assert.equal(fork.parentSessionId, parent.id)
    assert.equal(fork.relationType, "fork")
    assert.equal(fork.rootSessionId, parent.id)
    assert.equal(fork.forkedFromEntryId, selected.id)
    assert.equal(fork.title, "Fork: try sqlite instead")
    assert.deepEqual(forkPath.map((entry) => entry.data.content), ["first prompt", "first answer"])
    assert.equal(forkPath[0].parentEntryId, null)
    assert.notEqual(forkPath[0].id, first.id)
    assert.deepEqual(store.listForkChildren(parent.id).map((session) => session.id), [fork.id])

    store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("session store lists history with forks but hides subagents", async () => {
  const dir = await mkdtemp(join(tmpdir(), "furnace-session-"))

  try {
    const store = SessionStore.open(dir)
    const parent = store.createSession({ cwd: dir, title: "Parent" })
    store.appendMessage(parent.id, "user", "prefix")
    store.appendMessage(parent.id, "assistant", "prefix answer")
    const prompt = store.appendMessage(parent.id, "user", "branch me")
    const fork = store.forkSession({ position: "before", sourceEntryId: prompt.id, sourceSessionId: parent.id }).forkedSession
    const subagent = store.createSession({ cwd: dir, title: "Worker", parentSessionId: parent.id, relationType: "subagent", rootSessionId: parent.id })
    store.appendMessage(subagent.id, "user", "hidden worker")

    const history = store.listHistorySessions(dir).map((session) => session.id)
    assert.ok(history.includes(parent.id))
    assert.ok(history.includes(fork.id))
    assert.ok(!history.includes(subagent.id))

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
    const child = store.createSession({ cwd: dir, title: "Child", parentSessionId: parent.id, relationType: "subagent", rootSessionId: parent.id })

    assert.equal(store.getSession(child.id).parentSessionId, parent.id)
    assert.equal(store.getSession(child.id).forkedFromEntryId, null)
    assert.equal(store.getSession(child.id).relationType, "subagent")
    assert.equal(store.getSession(child.id).rootSessionId, parent.id)

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
    siteUrl: "http://localhost",
    skillPaths: [],
    subagentSystemPrompt: "subagent",
    systemPrompt: "system",
    theme: "flexoki",
    titleModel: "title-model",
    titleSystemPrompt: "title",
  }
}
