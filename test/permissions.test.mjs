import assert from "node:assert/strict"
import { test } from "node:test"
import {
  createToolPermissionRequest,
  defaultPermissionAction,
  SessionPermissionStore,
} from "../dist/permissions.js"

test("default permissions allow low-risk tools and ask for modifying tools", () => {
  assert.equal(defaultPermissionAction("read"), "allow")
  assert.equal(defaultPermissionAction("grep"), "allow")
  assert.equal(defaultPermissionAction("skill"), "allow")
  assert.equal(defaultPermissionAction("task"), "allow")
  assert.equal(defaultPermissionAction("task_status"), "allow")
  assert.equal(defaultPermissionAction("websearch"), "allow")
  assert.equal(defaultPermissionAction("skill_manage"), "ask")
  assert.equal(defaultPermissionAction("write"), "ask")
  assert.equal(defaultPermissionAction("edit"), "ask")
  assert.equal(defaultPermissionAction("bash"), "ask")
})

test("plan mode denies side effects except the active plan artifact", async () => {
  const store = new SessionPermissionStore()
  const planPath = ".furnace/plans/2026-06-22_174500-plan.md"
  store.setSessionMode("session-1", "plan", planPath)

  const planWrite = createToolPermissionRequest({
    args: JSON.stringify({ path: planPath, content: "# Plan\n", overwrite: true }),
    callId: "call-plan-write",
    cwd: "/tmp/project",
    sessionId: "session-1",
    toolName: "write",
  })
  const sourceWrite = createToolPermissionRequest({
    args: JSON.stringify({ path: "src/app.ts", content: "changed", overwrite: true }),
    callId: "call-source-write",
    cwd: "/tmp/project",
    sessionId: "session-1",
    toolName: "write",
  })
  const mutatingBash = createToolPermissionRequest({
    args: JSON.stringify({ command: "npm install left-pad" }),
    callId: "call-bash",
    cwd: "/tmp/project",
    sessionId: "session-1",
    toolName: "bash",
  })
  const readOnlyBash = createToolPermissionRequest({
    args: JSON.stringify({ command: "git status --short" }),
    callId: "call-status",
    cwd: "/tmp/project",
    sessionId: "session-1",
    toolName: "bash",
  })
  const skillManage = createToolPermissionRequest({
    args: JSON.stringify({ name: "new-skill" }),
    callId: "call-skill-manage",
    cwd: "/tmp/project",
    sessionId: "session-1",
    toolName: "skill_manage",
  })

  assert.equal(await store.authorize(planWrite), "allow_once")
  assert.equal(await store.authorize(sourceWrite, async () => "allow_all_session"), "deny")
  assert.equal(await store.authorize(mutatingBash), "deny")
  assert.equal(await store.authorize(readOnlyBash), "allow_once")
  assert.equal(await store.authorize(skillManage), "deny")
})

test("plan mode overrides inherited broad grants", async () => {
  const store = new SessionPermissionStore()
  const parentWrite = createToolPermissionRequest({
    args: JSON.stringify({ path: "src/app.ts", content: "changed", overwrite: true }),
    callId: "call-parent",
    cwd: "/tmp/project",
    sessionId: "parent",
    toolName: "write",
  })
  await store.authorize(parentWrite, async () => "allow_all_session")
  store.setSessionMode("parent", "plan", ".furnace/plans/2026-06-22_174500-plan.md")
  store.inheritSession("child", "parent")

  assert.equal(store.evaluate({ ...parentWrite, callId: "call-child", sessionId: "child" }), "deny")
})

test("child sessions inherit parent conversation grants", async () => {
  const store = new SessionPermissionStore()
  const parentBash = createToolPermissionRequest({
    args: JSON.stringify({ command: "npm test" }),
    callId: "call-1",
    cwd: "/tmp/project",
    sessionId: "parent",
    toolName: "bash",
  })
  const childBash = { ...parentBash, callId: "call-2", sessionId: "child" }
  const unrelatedBash = { ...parentBash, callId: "call-3", sessionId: "other" }

  assert.equal(await store.authorize(parentBash, async () => "allow_tool_session"), "allow_tool_session")
  store.inheritSession("child", "parent")

  assert.equal(store.evaluate(childBash), "allow")
  assert.equal(store.evaluate(unrelatedBash), "ask")
})

test("deny only applies to the current permission request", async () => {
  const store = new SessionPermissionStore()
  const request = createToolPermissionRequest({
    args: JSON.stringify({ command: "npm test" }),
    callId: "call-1",
    cwd: "/tmp/project",
    sessionId: "session-1",
    toolName: "bash",
  })

  assert.equal(await store.authorize(request, async () => "deny"), "deny")
  assert.equal(store.evaluate(request), "ask")
})

test("tool session allow only allows that tool in that session", async () => {
  const store = new SessionPermissionStore()
  const bashRequest = createToolPermissionRequest({
    args: JSON.stringify({ command: "npm test" }),
    callId: "call-1",
    cwd: "/tmp/project",
    sessionId: "session-1",
    toolName: "bash",
  })
  const writeRequest = createToolPermissionRequest({
    args: JSON.stringify({ path: "notes.txt", content: "hello" }),
    callId: "call-2",
    cwd: "/tmp/project",
    sessionId: "session-1",
    toolName: "write",
  })
  const otherSessionBash = { ...bashRequest, sessionId: "session-2" }

  assert.equal(await store.authorize(bashRequest, async () => "allow_tool_session"), "allow_tool_session")
  assert.equal(store.evaluate(bashRequest), "allow")
  assert.equal(store.evaluate(writeRequest), "ask")
  assert.equal(store.evaluate(otherSessionBash), "ask")
})

test("allow all tools for session allows future asked tools in that session", async () => {
  const store = new SessionPermissionStore()
  const writeRequest = createToolPermissionRequest({
    args: JSON.stringify({ path: "notes.txt", content: "hello" }),
    callId: "call-1",
    cwd: "/tmp/project",
    sessionId: "session-1",
    toolName: "write",
  })
  const bashRequest = createToolPermissionRequest({
    args: JSON.stringify({ command: "npm test" }),
    callId: "call-2",
    cwd: "/tmp/project",
    sessionId: "session-1",
    toolName: "bash",
  })
  const otherSessionBash = { ...bashRequest, sessionId: "session-2" }

  assert.equal(await store.authorize(writeRequest, async () => "allow_all_session"), "allow_all_session")
  assert.equal(store.evaluate(writeRequest), "allow")
  assert.equal(store.evaluate(bashRequest), "allow")
  assert.equal(store.evaluate(otherSessionBash), "ask")
})

test("clearing a session removes only that conversation's grants", async () => {
  const store = new SessionPermissionStore()
  const sessionOneBash = createToolPermissionRequest({
    args: JSON.stringify({ command: "npm test" }),
    callId: "call-1",
    cwd: "/tmp/project",
    sessionId: "session-1",
    toolName: "bash",
  })
  const sessionTwoBash = { ...sessionOneBash, sessionId: "session-2" }

  assert.equal(await store.authorize(sessionOneBash, async () => "allow_all_session"), "allow_all_session")
  assert.equal(await store.authorize(sessionTwoBash, async () => "allow_tool_session"), "allow_tool_session")
  assert.equal(store.evaluate(sessionOneBash), "allow")
  assert.equal(store.evaluate(sessionTwoBash), "allow")

  assert.equal(store.clearSession("session-1"), 1)
  assert.equal(store.evaluate(sessionOneBash), "ask")
  assert.equal(store.evaluate(sessionTwoBash), "allow")
})

test("listSessionGrants and removeGrant expose and revoke individual grants", async () => {
  const store = new SessionPermissionStore()
  const bashRequest = createToolPermissionRequest({
    args: JSON.stringify({ command: "npm test" }),
    callId: "call-1",
    cwd: "/tmp/project",
    sessionId: "session-1",
    toolName: "bash",
  })
  const writeRequest = createToolPermissionRequest({
    args: JSON.stringify({ path: "src/app.ts", content: "changed", overwrite: true }),
    callId: "call-2",
    cwd: "/tmp/project",
    sessionId: "session-1",
    toolName: "write",
  })

  await store.authorize(bashRequest, async () => "allow_tool_session")
  assert.deepEqual(store.listSessionGrants("session-1").map((grant) => grant.kind), ["rule"])

  await store.authorize(writeRequest, async () => "allow_all_session")
  const grants = store.listSessionGrants("session-1")
  assert.deepEqual(
    grants.map((grant) => grant.kind),
    ["allow_all", "rule"],
  )
  assert.equal(store.evaluate(bashRequest), "allow")

  store.removeGrant("session-1", grants.find((grant) => grant.kind === "allow_all"))
  assert.equal(store.evaluate(bashRequest), "allow")
  assert.equal(store.evaluate(writeRequest), "ask")

  store.removeGrant("session-1", grants.find((grant) => grant.kind === "rule"))
  assert.equal(store.evaluate(bashRequest), "ask")
  assert.deepEqual(store.listSessionGrants("session-1"), [])
})
