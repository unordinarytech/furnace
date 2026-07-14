import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import assert from "node:assert/strict"
import { SessionStore } from "../dist/session/store.js"
import { executeToolCall, toolDefinitions } from "../dist/tools/registry.js"
import { withTemporaryWorkspace } from "./helpers/workspace.mjs"

const withWorkspace = (fn) => withTemporaryWorkspace("furnace-tools-", fn)

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test("tool registry exposes the core primitives", () => {
  assert.deepEqual(
    toolDefinitions.map((tool) => tool.function.name),
    ["read", "context_retrieve", "ls", "find", "glob", "grep", "write", "edit", "bash", "ask_question", "skill", "skill_manage", "task", "task_status", "todoread", "todowrite", "websearch", "webfetch"],
  )
})

test("todo tools persist session-scoped todo state through the provided todo store", async () => {
  await withWorkspace(async (cwd) => {
    const states = new Map()
    const todoStore = {
      appendTodoState(sessionId, todos) {
        states.set(sessionId, todos)
      },
      getTodoState(sessionId) {
        return states.get(sessionId) || []
      },
    }
    const todos = [
      { id: "inspect", content: "Inspect implementation", status: "completed", priority: "high" },
      { id: "verify", content: "Run verification", status: "in_progress", priority: "medium" },
    ]

    const write = await executeToolCall(
      { name: "todowrite", arguments: JSON.stringify({ todos }) },
      { cwd, sessionId: "session-1", todoStore },
    )
    assert.deepEqual(JSON.parse(write.content).todos, todos)

    const read = await executeToolCall(
      { name: "todoread", arguments: "{}" },
      { cwd, sessionId: "session-1", todoStore },
    )
    const payload = JSON.parse(read.content)
    assert.deepEqual(payload.todos, todos)
    assert.equal(payload.summary.completed, 1)
    assert.equal(payload.summary.in_progress, 1)
  })
})

test("task delegates batched prompts through the task runner", async () => {
  await withWorkspace(async (cwd) => {
    const calls = []
    const taskRunner = {
      promoteActiveGroup() {
        return false
      },
      status() {
        return { parentSessionId: "parent", tasks: [] }
      },
      async runTasks(input) {
        calls.push(input)
        return {
          backgrounded: false,
          groupId: "group_1",
          tasks: input.tasks.map((task, index) => ({
            background: false,
            childSessionId: `child_${index + 1}`,
            completedAt: 20,
            description: task.description || task.prompt,
            id: `task_${index + 1}`,
            parentSessionId: input.parentSessionId,
            prompt: task.prompt,
            result: `done ${index + 1}`,
            startedAt: 10,
            status: "completed",
          })),
        }
      },
    }

    const result = await executeToolCall(
      {
        name: "task",
        arguments: JSON.stringify({
          tasks: [
            { prompt: "Research A", description: "A" },
            { prompt: "Research B" },
          ],
        }),
      },
      { cwd, sessionId: "parent", taskRunner },
    )

    assert.equal(calls.length, 1)
    assert.equal(calls[0].parentSessionId, "parent")
    assert.deepEqual(calls[0].tasks, [{ prompt: "Research A", description: "A" }, { prompt: "Research B" }])
    assert.match(result.content, /Task group group_1 completed/)
    assert.doesNotMatch(result.content, /child_session/)
    assert.match(result.content, /done 2/)
  })
})

test("task_status returns current task runner status", async () => {
  await withWorkspace(async (cwd) => {
    const result = await executeToolCall(
      { name: "task_status", arguments: "{}" },
      {
        cwd,
        sessionId: "parent",
        taskRunner: {
          promoteActiveGroup() {
            return false
          },
          runTasks() {
            throw new Error("not used")
          },
          status() {
            return {
              parentSessionId: "parent",
              tasks: [
                {
                  background: true,
                  childSessionId: "child_1",
                  description: "Background research",
                  id: "task_1",
                  parentSessionId: "parent",
                  prompt: "Research",
                  startedAt: Date.now(),
                  status: "backgrounded",
                },
              ],
            }
          },
        },
      },
    )

    assert.match(result.content, /backgrounded: Background research/)
    assert.doesNotMatch(result.content, /child_session/)
  })
})

test("ask_question returns user answers from the prompt service", async () => {
  await withWorkspace(async (cwd) => {
    const result = await executeToolCall(
      {
        name: "ask_question",
        arguments: JSON.stringify({
          questions: [
            {
              id: "scope",
              prompt: "Which scope?",
              options: [{ id: "minimal", label: "Minimal" }],
            },
          ],
        }),
      },
      {
        cwd,
        questionPrompt: async (request) => {
          assert.equal(request.questions[0].id, "scope")
          return {
            answers: [
              {
                answer: "Minimal",
                kind: "option",
                optionId: "minimal",
                questionId: "scope",
              },
            ],
          }
        },
      },
    )

    assert.match(result.content, /scope: user selected "Minimal"/)
  })
})

test("ask_question filters duplicate custom and refusal meta-options", async () => {
  await withWorkspace(async (cwd) => {
    const result = await executeToolCall(
      {
        name: "ask_question",
        arguments: JSON.stringify({
          questions: [
            {
              id: "scope",
              prompt: "Which scope?",
              allowCustom: true,
              allowMultiple: true,
              allowRefuse: false,
              options: [
                { id: "minimal", label: "Minimal" },
                { id: "specify", label: "Let me specify" },
                { id: "own", label: "Type my own" },
                { id: "refuse", label: "Refuse to answer" },
              ],
            },
          ],
        }),
      },
      {
        cwd,
        questionPrompt: async (request) => {
          assert.deepEqual(request.questions[0].options.map((option) => option.label), ["Minimal"])
          assert.equal(request.questions[0].allowCustom, true)
          assert.equal(request.questions[0].allowMultiple, true)
          assert.equal(request.questions[0].allowRefuse, false)
          return {
            answers: [
              {
                answer: "my own scope",
                kind: "custom",
                questionId: "scope",
              },
            ],
          }
        },
      },
    )

    assert.match(result.content, /scope: user wrote "my own scope"/)
  })
})

test("file tools read, write, list, find, glob, and grep inside the workspace", async () => {
  await withWorkspace(async (cwd) => {
    await executeToolCall({ name: "write", arguments: JSON.stringify({ path: "src/example.txt", content: "hello furnace\nsecond line\n" }) }, { cwd })

    const read = await executeToolCall({ name: "read", arguments: JSON.stringify({ path: "src/example.txt", limit: 1 }) }, { cwd })
    assert.match(read.content, /1\|hello furnace/)

    const ls = await executeToolCall({ name: "ls", arguments: JSON.stringify({ path: "src" }) }, { cwd })
    assert.match(ls.content, /file example\.txt/)

    const found = await executeToolCall({ name: "find", arguments: JSON.stringify({ query: "example" }) }, { cwd })
    assert.match(found.content, /src\/example\.txt/)

    const globbed = await executeToolCall({ name: "glob", arguments: JSON.stringify({ pattern: "**/*.txt" }) }, { cwd })
    assert.match(globbed.content, /src\/example\.txt/)

    const grep = await executeToolCall({ name: "grep", arguments: JSON.stringify({ pattern: "furnace" }) }, { cwd })
    assert.match(grep.content, /src\/example\.txt:1:hello furnace/)
  })
})

test("read refuses secret-like env files", async () => {
  await withWorkspace(async (cwd) => {
    await writeFile(join(cwd, ".env"), "OPENROUTER_API_KEY=nope\n", "utf8")
    const result = await executeToolCall({ name: "read", arguments: JSON.stringify({ path: ".env" }) }, { cwd })
    assert.equal(result.status, "error")
    assert.match(result.content, /Refusing to read secret-like file/)
  })
})

test("read returns an unchanged notice for duplicate unchanged ranges", async () => {
  await withWorkspace(async (cwd) => {
    await writeFile(join(cwd, "notes.txt"), "alpha\nbeta\n", "utf8")

    const first = await executeToolCall({ name: "read", arguments: JSON.stringify({ path: "notes.txt", limit: 1 }) }, { cwd })
    assert.match(first.content, /1\|alpha/)

    const second = await executeToolCall({ name: "read", arguments: JSON.stringify({ path: "notes.txt", limit: 1 }) }, { cwd })
    assert.match(second.content, /File unchanged since last read: notes\.txt/)
    assert.match(second.content, /lines 1-1/)

    const differentRange = await executeToolCall({ name: "read", arguments: JSON.stringify({ path: "notes.txt", offset: 2, limit: 1 }) }, { cwd })
    assert.match(differentRange.content, /2\|beta/)
  })
})

test("file read tracking is isolated by session id", async () => {
  await withWorkspace(async (cwd) => {
    await writeFile(join(cwd, "notes.txt"), "alpha\nbeta\n", "utf8")

    const sessionOneFirst = await executeToolCall({ name: "read", arguments: JSON.stringify({ path: "notes.txt", limit: 1 }) }, { cwd, sessionId: "session-one" })
    assert.match(sessionOneFirst.content, /1\|alpha/)

    const sessionOneSecond = await executeToolCall({ name: "read", arguments: JSON.stringify({ path: "notes.txt", limit: 1 }) }, { cwd, sessionId: "session-one" })
    assert.match(sessionOneSecond.content, /File unchanged since last read: notes\.txt/)

    const sessionTwoFirst = await executeToolCall({ name: "read", arguments: JSON.stringify({ path: "notes.txt", limit: 1 }) }, { cwd, sessionId: "session-two" })
    assert.match(sessionTwoFirst.content, /1\|alpha/)
    assert.doesNotMatch(sessionTwoFirst.content, /File unchanged since last read/)

    await sleep(20)
    await writeFile(join(cwd, "notes.txt"), "alpha\nexternal\n", "utf8")

    const unreadSessionWrite = await executeToolCall(
      { name: "write", arguments: JSON.stringify({ path: "notes.txt", content: "unread session overwrite\n", overwrite: true }) },
      { cwd, sessionId: "session-without-read" },
    )
    assert.doesNotMatch(unreadSessionWrite.content, /Warning: notes\.txt changed since Furnace last read it/)

    const sessionTwoWrite = await executeToolCall(
      { name: "write", arguments: JSON.stringify({ path: "notes.txt", content: "session two overwrite\n", overwrite: true }) },
      { cwd, sessionId: "session-two" },
    )
    assert.match(sessionTwoWrite.content, /Warning: notes\.txt changed since Furnace last read it before this write/)

    const sessionOneWrite = await executeToolCall(
      { name: "write", arguments: JSON.stringify({ path: "notes.txt", content: "session one overwrite\n", overwrite: true }) },
      { cwd, sessionId: "session-one" },
    )
    assert.match(sessionOneWrite.content, /Warning: notes\.txt changed since Furnace last read it before this write/)
  })
})

test("file read tracking persists through session store reopen", async () => {
  await withWorkspace(async (cwd) => {
    await writeFile(join(cwd, "notes.txt"), "alpha\nbeta\n", "utf8")

    let store = SessionStore.open(cwd)
    const session = store.createSession({ cwd, title: "Read tracking" })
    const first = await executeToolCall(
      { name: "read", arguments: JSON.stringify({ path: "notes.txt", limit: 1 }) },
      { cwd, fileReadStore: store, sessionId: session.id },
    )
    assert.match(first.content, /1\|alpha/)
    store.close()

    store = SessionStore.open(cwd)
    try {
      const reread = await executeToolCall(
        { name: "read", arguments: JSON.stringify({ path: "notes.txt", limit: 1 }) },
        { cwd, fileReadStore: store, sessionId: session.id },
      )
      assert.match(reread.content, /File unchanged since last read: notes\.txt/)

      await sleep(20)
      await writeFile(join(cwd, "notes.txt"), "alpha\nexternal\n", "utf8")
      const write = await executeToolCall(
        { name: "write", arguments: JSON.stringify({ path: "notes.txt", content: "agent overwrite\n", overwrite: true }) },
        { cwd, fileReadStore: store, sessionId: session.id },
      )
      assert.match(write.content, /Warning: notes\.txt changed since Furnace last read it before this write/)
    } finally {
      store.close()
    }
  })
})

test("write and edit warn when a previously read file changed externally", async () => {
  await withWorkspace(async (cwd) => {
    await writeFile(join(cwd, "notes.txt"), "alpha\nbeta\n", "utf8")
    await executeToolCall({ name: "read", arguments: JSON.stringify({ path: "notes.txt" }) }, { cwd })

    await sleep(20)
    await writeFile(join(cwd, "notes.txt"), "alpha\nexternal\n", "utf8")

    const write = await executeToolCall({ name: "write", arguments: JSON.stringify({ path: "notes.txt", content: "agent overwrite\n", overwrite: true }) }, { cwd })
    assert.match(write.content, /Warning: notes\.txt changed since Furnace last read it before this write/)
    assert.match(write.content, /Wrote notes\.txt/)

    await executeToolCall({ name: "read", arguments: JSON.stringify({ path: "notes.txt" }) }, { cwd })
    await sleep(20)
    await writeFile(join(cwd, "notes.txt"), "agent overwrite\nexternal again\n", "utf8")

    const edit = await executeToolCall(
      {
        name: "edit",
        arguments: JSON.stringify({
          patch: `*** Begin Patch
*** Update File: notes.txt
@@
-agent overwrite
+patched overwrite
 external again
*** End Patch`,
        }),
      },
      { cwd },
    )
    assert.match(edit.content, /Warning: notes\.txt changed since Furnace last read it before this write/)
    assert.match(edit.content, /Updated notes\.txt \(1 hunks\)/)
  })
})

test("recursive searches skip noisy dirs by default but honor explicit noisy paths", async () => {
  await withWorkspace(async (cwd) => {
    await executeToolCall({ name: "write", arguments: JSON.stringify({ path: "src/visible.txt", content: "visible needle\n" }) }, { cwd })
    await executeToolCall({ name: "write", arguments: JSON.stringify({ path: "node_modules/pkg/hidden.txt", content: "dependency needle\n" }) }, { cwd })
    await executeToolCall({ name: "write", arguments: JSON.stringify({ path: ".git/hidden.txt", content: "git needle\n" }) }, { cwd })
    await executeToolCall({ name: "write", arguments: JSON.stringify({ path: ".furnace/hidden.txt", content: "session needle\n" }) }, { cwd })

    const defaultFind = await executeToolCall({ name: "find", arguments: JSON.stringify({ query: "hidden" }) }, { cwd })
    assert.doesNotMatch(defaultFind.content, /node_modules/)
    assert.doesNotMatch(defaultFind.content, /\.git/)
    assert.doesNotMatch(defaultFind.content, /\.furnace/)

    const explicitFind = await executeToolCall({ name: "find", arguments: JSON.stringify({ path: ".git", query: "hidden" }) }, { cwd })
    assert.match(explicitFind.content, /\.git\/hidden\.txt/)

    const explicitGrep = await executeToolCall({ name: "grep", arguments: JSON.stringify({ path: "node_modules", pattern: "dependency" }) }, { cwd })
    assert.match(explicitGrep.content, /node_modules\/pkg\/hidden\.txt:1:dependency needle/)

    const explicitGlob = await executeToolCall({ name: "glob", arguments: JSON.stringify({ path: ".furnace", pattern: "**/*.txt" }) }, { cwd })
    assert.match(explicitGlob.content, /\.furnace\/hidden\.txt/)
  })
})

test("file tools can operate on explicit external paths", async () => {
  await withWorkspace(async (cwd) => {
    const external = await mkdtemp(join(tmpdir(), "furnace-external-"))
    const previousHome = process.env.HOME
    try {
      const externalFile = join(external, "outside.txt")
      await writeFile(externalFile, "external furnace\n", "utf8")

      const read = await executeToolCall({ name: "read", arguments: JSON.stringify({ path: externalFile }) }, { cwd })
      assert.match(read.content, /1\|external furnace/)

      const ls = await executeToolCall({ name: "ls", arguments: JSON.stringify({ path: external }) }, { cwd })
      assert.match(ls.content, /file outside\.txt/)

      const grep = await executeToolCall({ name: "grep", arguments: JSON.stringify({ path: external, pattern: "furnace" }) }, { cwd })
      assert.match(grep.content, /outside\.txt:1:external furnace/)

      const write = await executeToolCall({ name: "write", arguments: JSON.stringify({ path: join(external, "created.txt"), content: "created outside\n" }) }, { cwd })
      assert.match(write.content, /Wrote .*created\.txt/)
      assert.equal(await readFile(join(external, "created.txt"), "utf8"), "created outside\n")

      process.env.HOME = external
      const homeWrite = await executeToolCall({ name: "write", arguments: JSON.stringify({ path: "~/Desktop/home-created.txt", content: "created via home\n" }) }, { cwd })
      assert.match(homeWrite.content, /Wrote .*Desktop\/home-created\.txt/)
      assert.equal(await readFile(join(external, "Desktop/home-created.txt"), "utf8"), "created via home\n")
    } finally {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      await rm(external, { recursive: true, force: true })
    }
  })
})

test("write does not hard-block special repo metadata paths", async () => {
  await withWorkspace(async (cwd) => {
    const result = await executeToolCall({ name: "write", arguments: JSON.stringify({ path: ".git/furnace-test", content: "explicit write\n" }) }, { cwd })

    assert.match(result.content, /Wrote \.git\/furnace-test/)
    assert.equal(await readFile(join(cwd, ".git/furnace-test"), "utf8"), "explicit write\n")
  })
})

test("edit applies apply-patch-style add and update operations", async () => {
  await withWorkspace(async (cwd) => {
    const add = await executeToolCall(
      {
        name: "edit",
        arguments: JSON.stringify({
          patch: `*** Begin Patch
*** Add File: notes.txt
+alpha
+beta
*** End Patch`,
        }),
      },
      { cwd },
    )
    assert.match(add.content, /Added notes\.txt/)

    const update = await executeToolCall(
      {
        name: "edit",
        arguments: JSON.stringify({
          patch: `*** Begin Patch
*** Update File: notes.txt
@@
 alpha
-beta
+gamma
*** End Patch`,
        }),
      },
      { cwd },
    )
    assert.match(update.content, /Updated notes\.txt \(1 hunks\)/)
    assert.equal(await readFile(join(cwd, "notes.txt"), "utf8"), "alpha\ngamma\n")
  })
})

test("edit rejects unified diff syntax with a clear error", async () => {
  await withWorkspace(async (cwd) => {
    await writeFile(join(cwd, "notes.txt"), "alpha\n", "utf8")
    const result = await executeToolCall(
      {
        name: "edit",
        arguments: JSON.stringify({
          patch: `*** Begin Patch
--- notes.txt
+++ notes.txt
@@ -1 +1 @@
-alpha
+beta
*** End Patch`,
        }),
      },
      { cwd },
    )

    assert.match(result.content, /Unified diff syntax is not supported/)
    assert.match(result.content, /\*\*\* Update File: <path>/)
  })
})

test("bash runs a bounded workspace command", async () => {
  await withWorkspace(async (cwd) => {
    const result = await executeToolCall({ name: "bash", arguments: JSON.stringify({ command: "printf ok" }) }, { cwd })
    assert.match(result.content, /exit_code: 0/)
    assert.match(result.content, /stdout:\nok/)
  })
})

test("websearch calls an MCP-style provider and returns parsed text", async () => {
  await withWorkspace(async (cwd) => {
    const requests = []
    const fetchMock = async (url, init) => {
      requests.push({ url, init })
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: "search results" }] },
      })
    }

    const result = await executeToolCall(
      { name: "websearch", arguments: JSON.stringify({ query: "furnace docs 2026", provider: "exa", numResults: 3, contextMaxCharacters: 2500 }) },
      { cwd, services: { fetch: fetchMock } },
    )

    assert.equal(result.content, "search results")
    assert.equal(requests.length, 1)
    assert.equal(requests[0].url, "https://mcp.exa.ai/mcp")
    const body = JSON.parse(requests[0].init.body)
    assert.equal(body.params.name, "web_search_exa")
    assert.deepEqual(body.params.arguments, {
      query: "furnace docs 2026",
      type: "auto",
      numResults: 3,
      livecrawl: "fallback",
      contextMaxCharacters: 2500,
    })
  })
})

test("websearch rejects oversized provider responses", async () => {
  await withWorkspace(async (cwd) => {
    const fetchMock = async () => new Response("x".repeat(256 * 1024 + 1), { status: 200 })
    const result = await executeToolCall(
      { name: "websearch", arguments: JSON.stringify({ query: "too much", provider: "exa" }) },
      { cwd, services: { fetch: fetchMock } },
    )

    assert.match(result.content, /Tool websearch failed: web_search_exa response exceeded/)
  })
})

test("webfetch converts html to markdown and strips active content", async () => {
  await withWorkspace(async (cwd) => {
    const fetchMock = async () =>
      new Response("<html><head><script>bad()</script><style>.x{}</style></head><body><h1>Hello</h1><p>world <strong>wide</strong></p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })
    const result = await executeToolCall(
      { name: "webfetch", arguments: JSON.stringify({ url: "https://example.com/page", format: "markdown" }) },
      { cwd, services: { fetch: fetchMock } },
    )

    assert.equal(result.content, "# Hello\n\nworld **wide**")
    assert.doesNotMatch(result.content, /bad\(\)/)
  })
})

test("webfetch rejects non-http urls and oversized bodies", async () => {
  await withWorkspace(async (cwd) => {
    const invalid = await executeToolCall({ name: "webfetch", arguments: JSON.stringify({ url: "file:///etc/passwd" }) }, { cwd })
    assert.match(invalid.content, /Tool webfetch failed: URL must use http:\/\/ or https:\/\//)

    const fetchMock = async () => new Response("small", { headers: { "content-length": String(5 * 1024 * 1024 + 1), "content-type": "text/plain" } })
    const oversized = await executeToolCall(
      { name: "webfetch", arguments: JSON.stringify({ url: "https://example.com/huge", format: "text" }) },
      { cwd, services: { fetch: fetchMock } },
    )
    assert.match(oversized.content, /Tool webfetch failed: Response too large/)
  })
})

test("large tool outputs are compressed into retrievable context artifacts", async () => {
  await withWorkspace(async (cwd) => {
    const large = Array.from({ length: 3000 }, (_, index) => `line ${index}`).join("\n")
    const fetchMock = async () => new Response(large, { status: 200, headers: { "content-type": "text/plain" } })
    const result = await executeToolCall(
      { name: "webfetch", arguments: JSON.stringify({ url: "https://example.com/large", format: "text" }) },
      { cwd, services: { fetch: fetchMock } },
    )

    assert.match(result.content, /Tool output compressed \(Headroom-lite\)/)
    assert.match(result.content, /Full output artifact: ctx_[a-f0-9]{24}/)
    const artifactId = result.content.match(/Full output artifact: (ctx_[a-f0-9]{24})/)?.[1]
    assert.ok(artifactId)
    assert.equal(await readFile(join(cwd, ".furnace", "context-store", `${artifactId}.txt`), "utf8"), large)

    const retrieved = await executeToolCall(
      { name: "context_retrieve", arguments: JSON.stringify({ id: artifactId, offset: 10, limit: 3 }) },
      { cwd },
    )
    assert.match(retrieved.content, new RegExp(`Context artifact ${artifactId}`))
    assert.match(retrieved.content, /Returned: lines 10-12 of 3000/)
    assert.match(retrieved.content, /line 9\nline 10\nline 11/)
  })
})
