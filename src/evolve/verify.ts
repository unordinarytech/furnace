import { spawn } from "node:child_process"
import { cpSync, existsSync, mkdtempSync, renameSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { VerifyResult, VerifyStep } from "./types.js"

/**
 * Verify an evolve edit and, only when every gate passes, atomically swap the
 * new bundle into place (KTD4). Order is strict: typecheck -> build to a TEMP
 * location -> launch-smoke the temp bundle -> swap. A failure at any gate
 * leaves the live dist/ byte-for-byte untouched.
 *
 * Everything runs ASYNC (never blocks the TUI event loop) and nothing touches
 * the live dist/ before the swap: no `npm test`, no `npm run build`, no
 * scripts/clean-dist.mjs. Type errors are caught by `tsc --noEmit`; a bundle
 * that builds but crashes on import is caught by the launch smoke before it
 * can reach the live bin.
 *
 * Prompts are read from disk at runtime (src/config.ts reads dist/prompts/),
 * so the swap replaces BOTH dist/cli.js and dist/prompts/.
 *
 * Command execution is injected via VerifyDeps so the ordering and
 * "no swap on failure" invariants can be tested without running real tooling.
 */

export type StepOutcome = { ok: boolean; log: string }

export type BuildOutcome = StepOutcome & { tempCliPath?: string; tempPromptsPath?: string }

export type VerifyDeps = {
  typecheck: (root: string) => Promise<StepOutcome>
  buildToTemp: (root: string) => Promise<BuildOutcome>
  smoke: (root: string, build: BuildOutcome) => Promise<StepOutcome>
  swap: (root: string, build: BuildOutcome) => void
}

export type VerifyToTempResult =
  | { ok: true; build: BuildOutcome }
  | { ok: false; step: VerifyStep; log: string }

/** Gate an edit (typecheck -> build to temp -> launch smoke) WITHOUT swapping. */
export async function verifyToTemp(root: string, deps: VerifyDeps = defaultDeps): Promise<VerifyToTempResult> {
  const typecheck = await deps.typecheck(root)
  if (!typecheck.ok) return { ok: false, step: "typecheck", log: typecheck.log }

  const build = await deps.buildToTemp(root)
  if (!build.ok) return { ok: false, step: "build", log: build.log }

  const smoke = await deps.smoke(root, build)
  if (!smoke.ok) return { ok: false, step: "smoke", log: smoke.log }

  return { ok: true, build }
}

/** Verify and, only when every gate passes, atomically swap into dist/. */
export async function verifyAndBuild(root: string, deps: VerifyDeps = defaultDeps): Promise<VerifyResult> {
  const verified = await verifyToTemp(root, deps)
  if (!verified.ok) return verified
  try {
    deps.swap(root, verified.build)
  } catch (error) {
    return { ok: false, step: "swap", log: error instanceof Error ? error.message : String(error) }
  }
  return { ok: true }
}

function runAsync(root: string, command: string, args: string[]): Promise<StepOutcome> {
  return new Promise((resolveOutcome) => {
    const child = spawn(command, args, { cwd: resolve(root) })
    let log = ""
    child.stdout?.on("data", (chunk) => { log += chunk.toString() })
    child.stderr?.on("data", (chunk) => { log += chunk.toString() })
    child.on("error", (error) => resolveOutcome({ ok: false, log: `${log}\n${error.message}`.trim() }))
    child.on("close", (code) => resolveOutcome({ ok: code === 0, log: log.trim() }))
  })
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
  typecheck: (root) => runAsync(root, withNode, ["tsc", "-p", "tsconfig.json", "--noEmit"]),
  buildToTemp: async (root) => {
    const absRoot = resolve(root)
    const staging = mkdtempSync(join(tmpdir(), "furnace-evolve-build-"))
    const tempCliPath = join(staging, "cli.js")
    const tempPromptsPath = join(staging, "prompts")
    // Bundle straight from src to the temp outfile — esbuild is self-contained,
    // so there is no tsc emit into dist and nothing touches the live bundle.
    const build = await runAsync(absRoot, withNode, [...esbuildArgs, `--outfile=${tempCliPath}`])
    if (!build.ok) return { ok: false, log: build.log }
    // Stage prompts (mirrors scripts/copy-prompts.mjs) so prompt edits take effect.
    const promptsSrc = join(absRoot, "src", "prompts")
    if (existsSync(promptsSrc)) cpSync(promptsSrc, tempPromptsPath, { recursive: true })
    return { ok: true, log: build.log, tempCliPath, tempPromptsPath }
  },
  smoke: async (root, build) => {
    if (!build.tempCliPath) return { ok: true, log: "" }
    // Launch the freshly built bundle in isolation; a crash-on-import bug fails
    // here, before it can ever reach the live dist/.
    return runAsync(root, "node", [build.tempCliPath, "--version"])
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
