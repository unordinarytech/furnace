import assert from "node:assert/strict"
import { test } from "node:test"
import { buildRuntimeContext, entriesToModelMessages, entriesToTranscript } from "../dist/session/context.js"

test("runtime context includes current date and workspace", () => {
  const context = buildRuntimeContext({
    cwd: "/tmp/furnace",
    now: new Date("2026-06-20T17:48:00.000Z"),
  })

  assert.match(context, /Runtime context:/)
  assert.match(context, /Current ISO timestamp: 2026-06-20T17:48:00.000Z/)
  assert.match(context, /Current year: 2026/)
  assert.match(context, /Current workspace: \/tmp\/furnace/)
  assert.match(context, /latest, current, recent, today, and now/)
})

test("model messages include transient runtime context", () => {
  const messages = entriesToModelMessages(
    "base system",
    [
      {
        id: "entry-1",
        parentEntryId: null,
        sessionId: "session-1",
        type: "message",
        role: "user",
        data: { content: "latest FIFA news" },
        model: null,
        createdAt: 0,
      },
    ],
    { cwd: "/tmp/furnace", now: new Date("2026-06-20T17:48:00.000Z") },
  )

  assert.equal(messages[0].role, "system")
  assert.equal(messages[0].content, "base system")
  assert.equal(messages[1].role, "system")
  assert.match(messages[1].content, /Current year: 2026/)
  assert.deepEqual(messages[2], { role: "user", content: "latest FIFA news" })
})

test("hidden messages are replayed to the model but omitted from transcript", () => {
  const entries = [
    {
      id: "entry-1",
      parentEntryId: null,
      sessionId: "session-1",
      type: "message",
      role: "user",
      data: { content: "visible user prompt" },
      createdAt: 0,
    },
    {
      id: "entry-2",
      parentEntryId: "entry-1",
      sessionId: "session-1",
      type: "message",
      role: "user",
      data: { content: "background subagent completion", hidden: true, source: "background_subagent_completion" },
      createdAt: 1,
    },
  ]

  assert.deepEqual(entriesToTranscript(entries), [{ role: "user", content: "visible user prompt", imageCount: 0 }])
  assert.deepEqual(entriesToModelMessages("base system", entries), [
    { role: "system", content: "base system" },
    { role: "user", content: "visible user prompt" },
    { role: "user", content: "background subagent completion" },
  ])
})

test("model messages replay persisted tool calls and results", () => {
  const messages = entriesToModelMessages("base system", [
    {
      id: "entry-1",
      parentEntryId: null,
      sessionId: "session-1",
      type: "message",
      role: "user",
      data: { content: "read notes" },
      model: null,
      createdAt: 0,
    },
    {
      id: "entry-2",
      parentEntryId: "entry-1",
      sessionId: "session-1",
      type: "tool_call",
      role: "assistant",
      data: { arguments: "{\"path\":\"notes.txt\"}", name: "read", toolCallId: "call_1" },
      createdAt: 1,
    },
    {
      id: "entry-3",
      parentEntryId: "entry-2",
      sessionId: "session-1",
      type: "tool_result",
      role: "tool",
      data: { content: "1|hello", name: "read", toolCallId: "call_1" },
      createdAt: 2,
    },
    {
      id: "entry-4",
      parentEntryId: "entry-3",
      sessionId: "session-1",
      type: "message",
      role: "assistant",
      data: { content: "notes say hello" },
      createdAt: 3,
    },
  ])

  assert.deepEqual(messages, [
    { role: "system", content: "base system" },
    { role: "user", content: "read notes" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{\"path\":\"notes.txt\"}" } }],
    },
    { role: "tool", name: "read", tool_call_id: "call_1", content: "1|hello" },
    { role: "assistant", content: "notes say hello" },
  ])
})

test("model messages project latest compaction summary plus kept suffix", () => {
  const entries = [
    {
      id: "entry-1",
      parentEntryId: null,
      sessionId: "session-1",
      type: "message",
      role: "user",
      data: { content: "old request" },
      createdAt: 0,
    },
    {
      id: "entry-2",
      parentEntryId: "entry-1",
      sessionId: "session-1",
      type: "message",
      role: "assistant",
      data: { content: "old answer" },
      createdAt: 1,
    },
    {
      id: "entry-3",
      parentEntryId: "entry-2",
      sessionId: "session-1",
      type: "message",
      role: "user",
      data: { content: "kept request" },
      createdAt: 2,
    },
    {
      id: "entry-4",
      parentEntryId: "entry-3",
      sessionId: "session-1",
      type: "compaction",
      role: "system",
      data: {
        firstKeptEntryId: "entry-3",
        kind: "context_compaction",
        model: "test-model",
        reason: "manual",
        summary: "Old work was summarized.",
        tokensBefore: 100,
      },
      createdAt: 3,
    },
    {
      id: "entry-5",
      parentEntryId: "entry-4",
      sessionId: "session-1",
      type: "message",
      role: "assistant",
      data: { content: "new answer" },
      createdAt: 4,
    },
  ]

  const messages = entriesToModelMessages("base system", entries)

  assert.equal(messages[0].role, "system")
  assert.equal(messages[1].role, "user")
  assert.match(messages[1].content, /Old work was summarized/)
  assert.deepEqual(messages.slice(2), [
    { role: "user", content: "kept request" },
    { role: "assistant", content: "new answer" },
  ])
})
