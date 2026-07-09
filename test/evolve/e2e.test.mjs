import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * End-to-end smoke test of the evolve flow. It drives the REAL orchestrator
 * with the REAL recovery module (git snapshot + dist copy + restore) and the
 * REAL performSwap against a temp git repo. Only the model edit turn and the
 * verify *commands* (typecheck/test/build) are stubbed, so no API key or real
 * toolchain is needed — but the git snapshot/restore and atomic dist swap are
 * exercised for real.
 */

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" })
  if ((result.status ?? 1) !== 0 && args[0] !== "stash") {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`)
  }
  return (result.stdout ?? "").trim()
}

async function makeFurnaceRepo() {
  const home = await mkdtemp(join(tmpdir(), "furnace-e2e-home-"))
  const root = await mkdtemp(join(tmpdir(), "furnace-e2e-repo-"))
  git(root, ["init", "-q"])
  git(root, ["config", "user.email", "test@furnace.local"])
  git(root, ["config", "user.name", "Furnace Test"])
  git(root, ["config", "commit.gpgsign", "false"])
  await mkdir(join(root, "src"), { recursive: true })
  await writeFile(join(root, "src", "thing.ts"), "export const value = 1\n", "utf8")
  await mkdir(join(root, "dist", "prompts"), { recursive: true })
  await writeFile(join(root, "dist", "cli.js"), "GOOD-BUNDLE\n", "utf8")
  await writeFile(join(root, "dist", "prompts", "base-system.md"), "old prompt\n", "utf8")
  git(root, ["add", "-A"])
  git(root, ["commit", "-q", "-m", "init"])
  return { home, root }
}

async function loadEngine(verifyOverrides = {}) {
  const recovery = await import("../../dist/evolve/recovery.js")
  const { verifyToTemp, performSwap } = await import("../../dist/evolve/verify.js")
  const verifyDeps = {
    typecheck: async () => ({ ok: true, log: "" }),
    buildToTemp: async () => {
      const staging = mkdtempSync(join(tmpdir(), "furnace-e2e-build-"))
      const tempCliPath = join(staging, "cli.js")
      writeFileSync(tempCliPath, "REBUILT-BUNDLE\n")
      return { ok: true, log: "built", tempCliPath, tempPromptsPath: undefined }
    },
    smoke: async () => ({ ok: true, log: "" }),
    swap: performSwap,
    ...verifyOverrides,
  }
  return {
    createRecoveryPoint: recovery.createRecoveryPoint,
    recordCreatedFiles: recovery.recordCreatedFiles,
    restoreRecoveryPoint: recovery.restoreRecoveryPoint,
    listNewFiles: recovery.listNewFiles,
    verifyToTemp: (root) => verifyToTemp(root, verifyDeps),
    performSwap,
    gitDiff: () => " src/thing.ts | 2 +-",
    runningBinMatchesRoot: () => true,
  }
}

async function withHome(home, fn) {
  const previous = process.env.HOME
  process.env.HOME = home
  try {
    return await fn()
  } finally {
    process.env.HOME = previous
  }
}

test("e2e: approved evolve edits source, swaps dist, and reports a recovery id", async () => {
  const { runEvolve } = await import("../../dist/evolve/orchestrator.js")
  const { home, root } = await makeFurnaceRepo()
  try {
    await withHome(home, async () => {
      const engine = await loadEngine()
      const outcome = await runEvolve({
        request: "add a widget",
        rootResult: { available: true, root },
        engine,
        interaction: {
          notify: () => {},
          confirmApply: async () => true,
          runEditTurn: async ({ root: editRoot }) => {
            // Model edits an existing file and creates a new one.
            await writeFile(join(editRoot, "src", "thing.ts"), "export const value = 2\n", "utf8")
            await writeFile(join(editRoot, "src", "widget.ts"), "export const widget = true\n", "utf8")
          },
        },
      })

      assert.equal(outcome.status, "applied")
      assert.match(outcome.recoveryId, /^[a-z0-9]{6}$/)
      // Dist bundle was atomically swapped.
      assert.equal(await readFile(join(root, "dist", "cli.js"), "utf8"), "REBUILT-BUNDLE\n")
      // Source edit survived.
      assert.equal(await readFile(join(root, "src", "thing.ts"), "utf8"), "export const value = 2\n")
      assert.equal(existsSync(join(root, "src", "widget.ts")), true)
    })
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test("e2e: failed verification rolls back source and created files, dist untouched", async () => {
  const { runEvolve } = await import("../../dist/evolve/orchestrator.js")
  const { home, root } = await makeFurnaceRepo()
  try {
    await withHome(home, async () => {
      const engine = await loadEngine({ smoke: async () => ({ ok: false, log: "bundle crashed on import" }) })
      const outcome = await runEvolve({
        request: "break the build",
        rootResult: { available: true, root },
        engine,
        interaction: {
          notify: () => {},
          confirmApply: async () => { throw new Error("consent must not be reached on verify failure") },
          runEditTurn: async ({ root: editRoot }) => {
            await writeFile(join(editRoot, "src", "thing.ts"), "BROKEN\n", "utf8")
            await writeFile(join(editRoot, "src", "widget.ts"), "leftover\n", "utf8")
          },
        },
      })

      assert.equal(outcome.status, "verify-failed")
      assert.equal(outcome.step, "smoke")
      // Source reverted, created file removed, dist unchanged.
      assert.equal(await readFile(join(root, "src", "thing.ts"), "utf8"), "export const value = 1\n")
      assert.equal(existsSync(join(root, "src", "widget.ts")), false)
      assert.equal(await readFile(join(root, "dist", "cli.js"), "utf8"), "GOOD-BUNDLE\n")
    })
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test("e2e: rejected diff rolls back and never swaps dist", async () => {
  const { runEvolve } = await import("../../dist/evolve/orchestrator.js")
  const { home, root } = await makeFurnaceRepo()
  try {
    await withHome(home, async () => {
      const engine = await loadEngine()
      const outcome = await runEvolve({
        request: "add a widget i will reject",
        rootResult: { available: true, root },
        engine,
        interaction: {
          notify: () => {},
          confirmApply: async () => false,
          runEditTurn: async ({ root: editRoot }) => {
            await writeFile(join(editRoot, "src", "thing.ts"), "export const value = 3\n", "utf8")
            await writeFile(join(editRoot, "src", "widget.ts"), "export const widget = 1\n", "utf8")
          },
        },
      })

      assert.equal(outcome.status, "rejected")
      assert.equal(await readFile(join(root, "src", "thing.ts"), "utf8"), "export const value = 1\n")
      assert.equal(existsSync(join(root, "src", "widget.ts")), false)
      assert.equal(await readFile(join(root, "dist", "cli.js"), "utf8"), "GOOD-BUNDLE\n")
    })
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test("e2e: furnace --recover restores the known-good dist from the recovery copy", async () => {
  const { runEvolve } = await import("../../dist/evolve/orchestrator.js")
  const { restoreRecoveryPoint } = await import("../../dist/evolve/recovery.js")
  const { home, root } = await makeFurnaceRepo()
  try {
    await withHome(home, async () => {
      const engine = await loadEngine()
      const outcome = await runEvolve({
        request: "add a widget then simulate a broken restart",
        rootResult: { available: true, root },
        engine,
        interaction: {
          notify: () => {},
          confirmApply: async () => true,
          runEditTurn: async ({ root: editRoot }) => {
            await writeFile(join(editRoot, "src", "widget.ts"), "export const widget = 1\n", "utf8")
          },
        },
      })
      assert.equal(outcome.status, "applied")

      // Simulate a broken post-evolve dist, then recover.
      await writeFile(join(root, "dist", "cli.js"), "BROKEN-AT-RUNTIME\n", "utf8")
      const restored = restoreRecoveryPoint(outcome.recoveryId, root)
      assert.equal(restored.ok, true)
      assert.equal(await readFile(join(root, "dist", "cli.js"), "utf8"), "GOOD-BUNDLE\n")
      assert.equal(existsSync(join(root, "src", "widget.ts")), false)
    })
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})
