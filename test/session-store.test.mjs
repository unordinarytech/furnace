import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import assert from "node:assert/strict"
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
