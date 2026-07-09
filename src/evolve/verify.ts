import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdtempSync, renameSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { VerifyResult, VerifyStep } from "./types.js"

/**
 * Verify an evolve edit and, only when every gate passes, atomically swap the
 * new bundle into place (KTD4). Order is strict: typecheck -> test -> build to
 * a TEMP location -> swap. A failure at any gate leaves the live dist/
 * byte-for-byte untouched. The evolve path never runs scripts/clean-dist.mjs.
 *
 * Prompts are read from disk at runtime (src/config.ts reads dist/prompts/),
 * so the swap replaces BOTH dist/cli.js and dist/prompts/ — omitting prompts
 * makes prompt-only evolves silently no-op.
 *
 * Command execution is injected via VerifyDeps so the ordering and
 * "no swap on failure" invariants can be tested without running real tooling.
 */

export type StepOutcome = { ok: boolean; log: string }

export type BuildOutcome = StepOutcome & { tempCliPath?: string; tempPromptsPath?: string }

export type VerifyDeps = {
  typecheck: (root: string) => StepOutcome
  test: (root: string) => StepOutcome
  buildToTemp: (root: string) => BuildOutcome
  swap: (root: string, build: BuildOutcome) => void
}

export type VerifyToTempResult =
  | { ok: true; build: BuildOutcome }
  | { ok: false; step: VerifyStep; log: string }

/** Gate an edit (typecheck -> test -> build to temp) WITHOUT swapping. */
export function verifyToTemp(root: string, deps: VerifyDeps = defaultDeps): VerifyToTempResult {
  const typecheck = deps.typecheck(root)
  if (!typecheck.ok) return { ok: false, step: "typecheck", log: typecheck.log }

  const test = deps.test(root)
  if (!test.ok) return { ok: false, step: "test", log: test.log }

  const build = deps.buildToTemp(root)
  if (!build.ok) return { ok: false, step: "build", log: build.log }

  return { ok: true, build }
}

/** Verify and, only when every gate passes, atomically swap into dist/. */
export function verifyAndBuild(root: string, deps: VerifyDeps = defaultDeps): VerifyResult {
  const verified = verifyToTemp(root, deps)
  if (!verified.ok) return verified
  try {
    deps.swap(root, verified.build)
  } catch (error) {
    return { ok: false, step: "swap", log: error instanceof Error ? error.message : String(error) }
  }
  return { ok: true }
}

function run(root: string, command: string, args: string[]): StepOutcome {
  const result = spawnSync(command, args, { cwd: resolve(root), encoding: "utf8" })
  const log = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim()
  return { ok: (result.status ?? 1) === 0, log }
}

const withNode = "./scripts/with-node22.sh"

const esbuildArgs = [
  "esbuild",
  "src/cli.ts",
  "--bundle",
  "--platform=node",
  "--format=esm",
  "--target=node22",
  '--banner:js=import { createRequire } from "node:module";const require = createRequire(import.meta.url);',
  "--external:better-sqlite3",
  "--external:@earendil-works/pi-tui",
]

export const defaultDeps: VerifyDeps = {
  typecheck: (root) => run(root, withNode, ["tsc", "-p", "tsconfig.json", "--noEmit"]),
  test: (root) => run(root, "npm", ["test"]),
  buildToTemp: (root) => {
    const absRoot = resolve(root)
    const staging = mkdtempSync(join(tmpdir(), "furnace-evolve-build-"))
    const tempCliPath = join(staging, "cli.js")
    const tempPromptsPath = join(staging, "prompts")
    // Compile the type layer, then bundle to the temp outfile.
    const tsc = run(absRoot, withNode, ["tsc", "-p", "tsconfig.json"])
    if (!tsc.ok) return { ok: false, log: tsc.log }
    const build = run(absRoot, withNode, [...esbuildArgs, `--outfile=${tempCliPath}`])
    if (!build.ok) return { ok: false, log: build.log }
    // Stage prompts (mirrors scripts/copy-prompts.mjs) so prompt edits take effect.
    const promptsSrc = join(absRoot, "src", "prompts")
    if (existsSync(promptsSrc)) cpSync(promptsSrc, tempPromptsPath, { recursive: true })
    return { ok: true, log: build.log, tempCliPath, tempPromptsPath }
  },
  swap: (root, build) => performSwap(root, build),
}

/** Atomically move the temp bundle and prompts over the live dist/. */
export function performSwap(root: string, build: BuildOutcome): void {
  const absRoot = resolve(root)
  const dist = join(absRoot, "dist")
  if (build.tempCliPath && existsSync(build.tempCliPath)) {
    renameOrCopy(build.tempCliPath, join(dist, "cli.js"))
  }
  if (build.tempPromptsPath && existsSync(build.tempPromptsPath)) {
    const target = join(dist, "prompts")
    rmSync(target, { recursive: true, force: true })
    cpSync(build.tempPromptsPath, target, { recursive: true })
  }
}

function renameOrCopy(from: string, to: string): void {
  try {
    renameSync(from, to)
  } catch {
    // Cross-device rename falls back to copy.
    cpSync(from, to, { recursive: true })
    rmSync(from, { recursive: true, force: true })
  }
}
