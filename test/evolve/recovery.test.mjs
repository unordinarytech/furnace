import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"

// Recovery writes its registry to ~/.furnace/recovery/registry.json. To keep
// tests isolated from a real user registry, redirect HOME to a temp dir per test.
function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" })
  if ((result.status ?? 1) !== 0 && args[0] !== "stash") {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`)
  }
  return (result.stdout ?? "").trim()
}

async function makeGitRepo() {
  const home = await mkdtemp(join(tmpdir(), "furnace-evolve-home-"))
  const root = await mkdtemp(join(tmpdir(), "furnace-evolve-repo-"))
  git(root, ["init", "-q"])
  git(root, ["config", "user.email", "test@furnace.local"])
  git(root, ["config", "user.name", "Furnace Test"])
  git(root, ["config", "commit.gpgsign", "false"])
  await writeFile(join(root, "tracked.txt"), "original\n", "utf8")
  await mkdir(join(root, "dist"), { recursive: true })
  await writeFile(join(root, "dist", "cli.js"), "good-bundle\n", "utf8")
  git(root, ["add", "-A"])
  git(root, ["commit", "-q", "-m", "init"])
  return { home, root }
}

async function withRecovery(home, fn) {
  const previousHome = process.env.HOME
  process.env.HOME = home
  try {
    const mod = await import("../../dist/evolve/recovery.js")
    return await fn(mod)
  } finally {
    process.env.HOME = previousHome
  }
}

test("createRecoveryPoint on a clean tree records HEAD and copies dist", async () => {
  const { home, root } = await makeGitRepo()
  try {
    await withRecovery(home, async ({ createRecoveryPoint }) => {
      const head = git(root, ["rev-parse", "HEAD"])
      const point = createRecoveryPoint(root, "clean snapshot")
      assert.equal(point.ref, head)
      assert.equal(point.furnaceRoot, root)
      assert.equal(point.lastEvolve, true)
      assert.ok(existsSync(join(point.distCopyPath, "cli.js")))
    })
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test("restore reverts a modified tracked file and restores the dist copy", async () => {
  const { home, root } = await makeGitRepo()
  try {
    await withRecovery(home, async ({ createRecoveryPoint, restoreRecoveryPoint }) => {
      const point = createRecoveryPoint(root, "before edit")
      await writeFile(join(root, "tracked.txt"), "MUTATED\n", "utf8")
      await writeFile(join(root, "dist", "cli.js"), "BROKEN-BUNDLE\n", "utf8")

      const result = restoreRecoveryPoint(point.id, root)
      assert.equal(result.ok, true)
      assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "original\n")
      assert.equal(await readFile(join(root, "dist", "cli.js"), "utf8"), "good-bundle\n")
    })
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test("restore deletes recorded created files but leaves unrelated untracked files", async () => {
  const { home, root } = await makeGitRepo()
  try {
    await withRecovery(home, async ({ createRecoveryPoint, recordCreatedFiles, restoreRecoveryPoint }) => {
      const point = createRecoveryPoint(root, "adds a file")
      await writeFile(join(root, "created-by-evolve.txt"), "new\n", "utf8")
      await writeFile(join(root, "user-scratch.txt"), "mine\n", "utf8")
      recordCreatedFiles(point.id, ["created-by-evolve.txt"])

      const result = restoreRecoveryPoint(point.id, root)
      assert.equal(result.ok, true)
      assert.equal(existsSync(join(root, "created-by-evolve.txt")), false)
      assert.equal(existsSync(join(root, "user-scratch.txt")), true)
    })
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test("restore refuses unknown id and cross-root ids", async () => {
  const { home, root } = await makeGitRepo()
  const otherRoot = await mkdtemp(join(tmpdir(), "furnace-evolve-other-"))
  try {
    await withRecovery(home, async ({ createRecoveryPoint, restoreRecoveryPoint }) => {
      const missing = restoreRecoveryPoint("zzzzzz", root)
      assert.equal(missing.ok, false)
      assert.equal(missing.reason, "not-found")

      const point = createRecoveryPoint(root, "for cross-root")
      const crossed = restoreRecoveryPoint(point.id, otherRoot)
      assert.equal(crossed.ok, false)
      assert.equal(crossed.reason, "cross-root")
    })
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
    await rm(otherRoot, { recursive: true, force: true })
  }
})

test("restore reports failure when the snapshot checkout fails", async () => {
  const { home, root } = await makeGitRepo()
  try {
    await withRecovery(home, async ({ createRecoveryPoint, recoveryRegistryPath, restoreRecoveryPoint }) => {
      const point = createRecoveryPoint(root, "broken snapshot")
      const registryPath = recoveryRegistryPath()
      const registry = JSON.parse(await readFile(registryPath, "utf8"))
      registry.points.find((candidate) => candidate.id === point.id).ref = "definitely-not-a-git-ref"
      await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8")
      await writeFile(join(root, "tracked.txt"), "still-mutated\n", "utf8")

      const result = restoreRecoveryPoint(point.id, root)
      assert.equal(result.ok, false)
      assert.equal(result.reason, "error")
      assert.match(result.message, /git checkout/)
      assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "still-mutated\n")
    })
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test("resetToBaseline reverts to the earliest point, removes all created files, and clears history", async () => {
  const { home, root } = await makeGitRepo()
  try {
    await withRecovery(home, async ({ createRecoveryPoint, recordCreatedFiles, resetToBaseline, pointsForRoot }) => {
      // First evolve: baseline captured with dist "good-bundle" and tracked.txt "original".
      const p1 = createRecoveryPoint(root, "evolve one")
      await writeFile(join(root, "tracked.txt"), "changed by evolve one\n", "utf8")
      await writeFile(join(root, "one.ts"), "one\n", "utf8")
      recordCreatedFiles(p1.id, ["one.ts"])
      // Second evolve on top.
      const p2 = createRecoveryPoint(root, "evolve two")
      await writeFile(join(root, "tracked.txt"), "changed again by evolve two\n", "utf8")
      await writeFile(join(root, "two.ts"), "two\n", "utf8")
      await writeFile(join(root, "dist", "cli.js"), "EVOLVED-BUNDLE\n", "utf8")
      recordCreatedFiles(p2.id, ["two.ts"])

      const result = resetToBaseline(root)
      assert.equal(result.ok, true)
      assert.equal(result.undoneCount, 2)
      // Tracked file back to original; both created files gone; dist back to baseline.
      assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "original\n")
      assert.equal(existsSync(join(root, "one.ts")), false)
      assert.equal(existsSync(join(root, "two.ts")), false)
      assert.equal(await readFile(join(root, "dist", "cli.js"), "utf8"), "good-bundle\n")
      // History cleared for this root.
      assert.equal(pointsForRoot(root).length, 0)
    })
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test("resetToBaseline reports nothing when there are no recovery points", async () => {
  const { home, root } = await makeGitRepo()
  try {
    await withRecovery(home, async ({ resetToBaseline }) => {
      const result = resetToBaseline(root)
      assert.equal(result.ok, false)
      assert.equal(result.reason, "nothing")
    })
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test("lastEvolve is cleared per-root and latestForRoot filters by root", async () => {
  const { home, root } = await makeGitRepo()
  const { root: rootB } = await makeGitRepo()
  try {
    await withRecovery(home, async ({ createRecoveryPoint, latestForRoot }) => {
      const a1 = createRecoveryPoint(root, "a1")
      const b1 = createRecoveryPoint(rootB, "b1")
      const a2 = createRecoveryPoint(root, "a2")

      // Root A's latest is a2 with lastEvolve; root B's b1 is untouched by A's clears.
      assert.equal(latestForRoot(root).id, a2.id)
      assert.equal(latestForRoot(root).lastEvolve, true)
      assert.equal(latestForRoot(rootB).id, b1.id)
      assert.equal(latestForRoot(rootB).lastEvolve, true)
      assert.ok(a1.id)
    })
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
    await rm(rootB, { recursive: true, force: true })
  }
})
