import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

function stubDeps(overrides = {}) {
  const calls = []
  const base = {
    typecheck: async () => { calls.push("typecheck"); return { ok: true, log: "" } },
    buildToTemp: async () => { calls.push("build"); return { ok: true, log: "", tempCliPath: "/tmp/x", tempPromptsPath: "/tmp/p" } },
    smoke: async () => { calls.push("smoke"); return { ok: true, log: "" } },
    swap: () => { calls.push("swap") },
  }
  return { deps: { ...base, ...overrides }, calls }
}

test("verifyAndBuild runs typecheck -> build -> smoke -> swap in order on success", async () => {
  const { verifyAndBuild } = await import("../../dist/evolve/verify.js")
  const { deps, calls } = stubDeps()
  const result = await verifyAndBuild("/root", deps)
  assert.equal(result.ok, true)
  assert.deepEqual(calls, ["typecheck", "build", "smoke", "swap"])
})

test("verifyAndBuild stops at a failing smoke and never swaps", async () => {
  const { verifyAndBuild } = await import("../../dist/evolve/verify.js")
  const { deps, calls } = stubDeps({ smoke: async () => ({ ok: false, log: "crash on import" }) })
  const result = await verifyAndBuild("/root", deps)
  assert.equal(result.ok, false)
  assert.equal(result.step, "smoke")
  assert.equal(calls.includes("swap"), false)
})

test("verifyAndBuild stops at a failing build and never swaps or smokes", async () => {
  const { verifyAndBuild } = await import("../../dist/evolve/verify.js")
  const { deps, calls } = stubDeps({ buildToTemp: async () => ({ ok: false, log: "esbuild error" }) })
  const result = await verifyAndBuild("/root", deps)
  assert.equal(result.ok, false)
  assert.equal(result.step, "build")
  assert.equal(calls.includes("smoke"), false)
  assert.equal(calls.includes("swap"), false)
})

test("verifyAndBuild leaves live dist untouched when a gate fails", async () => {
  const { verifyAndBuild, performSwap } = await import("../../dist/evolve/verify.js")
  const root = await mkdtemp(join(tmpdir(), "furnace-evolve-verify-"))
  try {
    await mkdir(join(root, "dist"), { recursive: true })
    await writeFile(join(root, "dist", "cli.js"), "LIVE\n", "utf8")
    const { deps } = stubDeps({
      typecheck: async () => ({ ok: false, log: "type error" }),
      swap: (r, build) => performSwap(r, build),
    })
    const result = await verifyAndBuild(root, deps)
    assert.equal(result.ok, false)
    assert.equal(await readFile(join(root, "dist", "cli.js"), "utf8"), "LIVE\n")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("defaultDeps run the real toolchain end-to-end (catches 'command not found')", async () => {
  const { verifyToTemp } = await import("../../dist/evolve/verify.js")
  // Runs real tsc --noEmit + esbuild-to-temp + node launch-smoke against this
  // repo. Would fail if tsc/esbuild/node aren't resolvable from the evolve path
  // (the exact regression where node_modules/.bin wasn't on PATH). Does NOT swap.
  const result = await verifyToTemp(process.cwd())
  assert.equal(result.ok, true, JSON.stringify(result))
})

test("performSwap replaces dist/cli.js and dist/prompts from the temp build", async () => {
  const { performSwap } = await import("../../dist/evolve/verify.js")
  const root = await mkdtemp(join(tmpdir(), "furnace-evolve-swap-"))
  try {
    await mkdir(join(root, "dist", "prompts"), { recursive: true })
    await writeFile(join(root, "dist", "cli.js"), "OLD\n", "utf8")
    await writeFile(join(root, "dist", "prompts", "base-system.md"), "old prompt\n", "utf8")

    const staging = await mkdtemp(join(tmpdir(), "furnace-evolve-staging-"))
    await writeFile(join(staging, "cli.js"), "NEW\n", "utf8")
    await mkdir(join(staging, "prompts"), { recursive: true })
    await writeFile(join(staging, "prompts", "base-system.md"), "new prompt\n", "utf8")

    performSwap(root, { ok: true, log: "", tempCliPath: join(staging, "cli.js"), tempPromptsPath: join(staging, "prompts") })

    assert.equal(await readFile(join(root, "dist", "cli.js"), "utf8"), "NEW\n")
    assert.equal(await readFile(join(root, "dist", "prompts", "base-system.md"), "utf8"), "new prompt\n")
    await rm(staging, { recursive: true, force: true })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
