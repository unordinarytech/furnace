import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { withTemporaryHomeWorkspace } from "../helpers/workspace.mjs"

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()
}

async function initializeVersion(root, content) {
  await mkdir(join(root, "src"), { recursive: true })
  await writeFile(join(root, "src", "feature.ts"), content, "utf8")
  git(root, "init", "-q")
  git(root, "-c", "user.name=Furnace Test", "-c", "user.email=test@furnace.invalid", "add", "-A")
  git(root, "-c", "user.name=Furnace Test", "-c", "user.email=test@furnace.invalid", "commit", "-m", "baseline")
}

function migrationDeps(targetRoot, events) {
  return {
    activate: (root) => events.push(`activate:${root}`),
    createRecovery: () => ({ id: "recover1" }),
    listNewFiles: () => [],
    prepareSource: async () => ({ available: true, managed: true, root: targetRoot }),
    recordCreatedFiles: () => {},
    swap: (root) => events.push(`swap:${root}`),
    verify: async () => ({ ok: true, build: { ok: true, log: "verified" } }),
  }
}

test("/evolve-merge is registered as a built-in command", async () => {
  const { parseSlashCommand, slashCommandDefinitions } = await import("../../dist/commands/builtins.js")
  assert.equal(slashCommandDefinitions.some((command) => command.name === "/evolve-merge"), true)
  assert.deepEqual(parseSlashCommand("/evolve-merge"), { name: "/evolve-merge", argument: "" })
})

test("automatic migration rebases evolved tracked and untracked files onto a new version", async () => {
  const { attemptEvolveMigration, readEvolveMigrationState } = await import("../../dist/evolve/migration.js")
  await withTemporaryHomeWorkspace("furnace-evolve-migrate-clean-", async (workspace) => {
    const oldRoot = join(workspace, "old")
    const newRoot = join(workspace, "new")
    await initializeVersion(oldRoot, "export const first = 1\nexport const value = 2\n")
    await initializeVersion(newRoot, "export const first = 1\nexport const value = 2\n")
    await writeFile(join(newRoot, "src", "upstream.ts"), "export const upstream = true\n", "utf8")
    git(newRoot, "-c", "user.name=Furnace Test", "-c", "user.email=test@furnace.invalid", "add", "-A")
    git(newRoot, "-c", "user.name=Furnace Test", "-c", "user.email=test@furnace.invalid", "commit", "-m", "upstream")

    await writeFile(join(oldRoot, "src", "feature.ts"), "export const first = 1\nexport const value = 99\n", "utf8")
    await writeFile(join(oldRoot, "src", "custom.ts"), "export const evolved = true\n", "utf8")
    const events = []
    const result = await attemptEvolveMigration({
      currentVersion: "2.0.0",
      manifest: { version: 1, packageVersion: "1.0.0", sourceRoot: oldRoot, cliPath: join(oldRoot, "dist", "cli.js") },
      deps: migrationDeps(newRoot, events),
    })

    assert.equal(result.status, "migrated")
    assert.match(await readFile(join(newRoot, "src", "feature.ts"), "utf8"), /value = 99/)
    assert.match(await readFile(join(newRoot, "src", "upstream.ts"), "utf8"), /upstream = true/)
    assert.match(await readFile(join(newRoot, "src", "custom.ts"), "utf8"), /evolved = true/)
    assert.deepEqual(events, [`swap:${newRoot}`, `activate:${newRoot}`])
    assert.equal(await readEvolveMigrationState(), undefined)
  })
})

test("conflicted migration is persisted and can be completed after manual resolution", async () => {
  const {
    attemptEvolveMigration,
    completePendingEvolveMigration,
    readEvolveMigrationState,
  } = await import("../../dist/evolve/migration.js")
  await withTemporaryHomeWorkspace("furnace-evolve-migrate-conflict-", async (workspace) => {
    const oldRoot = join(workspace, "old")
    const newRoot = join(workspace, "new")
    const baseline = "export const value = 1\n"
    await initializeVersion(oldRoot, baseline)
    await initializeVersion(newRoot, baseline)
    await writeFile(join(oldRoot, "src", "feature.ts"), "export const value = 2 // evolved\n", "utf8")
    await writeFile(join(newRoot, "src", "feature.ts"), "export const value = 3 // upstream\n", "utf8")
    git(newRoot, "-c", "user.name=Furnace Test", "-c", "user.email=test@furnace.invalid", "add", "-A")
    git(newRoot, "-c", "user.name=Furnace Test", "-c", "user.email=test@furnace.invalid", "commit", "-m", "upstream")

    const events = []
    const deps = migrationDeps(newRoot, events)
    const result = await attemptEvolveMigration({
      currentVersion: "2.0.0",
      manifest: { version: 1, packageVersion: "1.0.0", sourceRoot: oldRoot, cliPath: join(oldRoot, "dist", "cli.js") },
      deps,
    })

    assert.equal(result.status, "pending")
    assert.equal(result.state.status, "conflict")
    assert.equal((await readEvolveMigrationState()).toVersion, "2.0.0")
    assert.deepEqual(events, [])

    await writeFile(join(newRoot, "src", "feature.ts"), "export const value = 3 // upstream, evolved behavior retained\n", "utf8")
    git(newRoot, "add", "src/feature.ts")
    const completed = await completePendingEvolveMigration({ deps })
    assert.equal(completed.ok, true)
    assert.deepEqual(events, [`swap:${newRoot}`, `activate:${newRoot}`])
    assert.equal(await readEvolveMigrationState(), undefined)
  })
})
