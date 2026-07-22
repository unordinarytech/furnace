import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const {
  ensureProjectStateDir,
  formatWorkspaceStateError,
  isProtectedSystemPath,
  projectStateDir,
} = await import("../dist/workspace-state.js")

test("project state dir nests under the workspace cwd", () => {
  assert.equal(projectStateDir("/tmp/project"), join("/tmp/project", ".furnace"))
})

test("windows system paths are treated as protected", () => {
  assert.equal(isProtectedSystemPath("C:\\WINDOWS\\system32", "win32"), true)
  assert.equal(isProtectedSystemPath("C:\\Windows", "win32"), true)
  assert.equal(isProtectedSystemPath("C:\\Program Files", "win32"), true)
  assert.equal(isProtectedSystemPath("C:\\Users\\91876\\Downloads\\AI CMO", "win32"), false)
})

test("unix system roots are treated as protected", () => {
  assert.equal(isProtectedSystemPath("/", "linux"), true)
  assert.equal(isProtectedSystemPath("/usr", "darwin"), true)
  assert.equal(isProtectedSystemPath("/etc", "linux"), true)
  assert.equal(isProtectedSystemPath("/tmp/project", "linux"), false)
  assert.equal(isProtectedSystemPath("/Users/ronish/dev/app", "darwin"), false)
})

test("ensureProjectStateDir creates .furnace in a writable workspace", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "furnace-workspace-"))
  try {
    const stateDir = ensureProjectStateDir(cwd)
    assert.equal(stateDir, join(cwd, ".furnace"))
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test("workspace state errors tell the user to cd into a project", () => {
  const error = formatWorkspaceStateError("C:\\WINDOWS\\system32", Object.assign(new Error("boom"), { code: "EPERM" }))
  assert.match(error.message, /Cannot create project state/)
  assert.match(error.message, /cd /)
  assert.match(error.message, /furnace/)
  assert.match(error.message, /EPERM/)
})
