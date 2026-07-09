import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { createRecoveryPoint, listNewFiles, recordCreatedFiles, restoreRecoveryPoint } from "./recovery.js"
import { performSwap, verifyToTemp, type BuildOutcome, type VerifyToTempResult } from "./verify.js"
import type { EvolveOutcome, FurnaceRootResult } from "./types.js"

/**
 * End-to-end evolve flow (KTD1, KTD6, KTD7, KTD9, KTD10):
 *   notice -> recovery point -> agent edit (source only) -> verify (no swap)
 *   -> content-level consent on the real diff -> atomic swap -> optional theme
 *   pref -> running-bin check -> mandatory restart prompt.
 *
 * UI and the agent edit are injected via EvolveInteraction so the ordering and
 * both rollback branches (verify-fail, diff-reject) are testable without a TUI
 * or a real model turn.
 */

export type EvolveInteraction = {
  notify: (message: string) => void
  /** Content-level consent: shown the real diff + verified build, before swap. */
  confirmApply: (summary: { diff: string; createdFiles: string[]; verifyLog: string }) => Promise<boolean>
  /** Runs the agent turn that edits furnace source (must not build). */
  runEditTurn: (input: { root: string; request: string }) => Promise<void>
  /** Optional KTD7: apply a matching theme preference so it is live next start. */
  applyThemePreference?: (input: { root: string; request: string }) => void | Promise<void>
}

export type EvolveEngine = {
  createRecoveryPoint: typeof createRecoveryPoint
  recordCreatedFiles: typeof recordCreatedFiles
  restoreRecoveryPoint: typeof restoreRecoveryPoint
  listNewFiles: typeof listNewFiles
  verifyToTemp: (root: string) => Promise<VerifyToTempResult>
  performSwap: (root: string, build: BuildOutcome) => void
  gitDiff: (root: string) => string
  runningBinMatchesRoot: (root: string) => boolean
}

export function defaultEngine(): EvolveEngine {
  return {
    createRecoveryPoint,
    recordCreatedFiles,
    restoreRecoveryPoint,
    listNewFiles,
    verifyToTemp: (root) => verifyToTemp(root),
    performSwap,
    gitDiff,
    runningBinMatchesRoot,
  }
}

export async function runEvolve(input: {
  request: string
  rootResult: FurnaceRootResult
  interaction: EvolveInteraction
  engine?: EvolveEngine
}): Promise<EvolveOutcome> {
  const { request, rootResult, interaction } = input
  const engine = input.engine ?? defaultEngine()

  if (!rootResult.available) {
    interaction.notify(rootResult.message)
    return { status: "unavailable", reason: rootResult.reason, message: rootResult.message }
  }
  const root = rootResult.root

  interaction.notify(`Evolving furnace: ${request}`)
  const point = engine.createRecoveryPoint(root, request)

  const before = new Set(engine.listNewFiles(root))
  await interaction.runEditTurn({ root, request })
  const created = engine.listNewFiles(root).filter((path) => !before.has(path))
  engine.recordCreatedFiles(point.id, created)

  interaction.notify("Verifying change (typecheck, build, launch check)…")
  const verified = await engine.verifyToTemp(root)
  if (!verified.ok) {
    engine.restoreRecoveryPoint(point.id, root)
    interaction.notify(`Verification failed at ${verified.step}. Reverted. Recovery point ${point.id} left in place.`)
    return { status: "verify-failed", recoveryId: point.id, step: verified.step, log: verified.log, createdFiles: created }
  }

  const diff = engine.gitDiff(root)
  const approved = await interaction.confirmApply({ diff, createdFiles: created, verifyLog: verified.build.log })
  if (!approved) {
    engine.restoreRecoveryPoint(point.id, root)
    interaction.notify(`Change not applied. Reverted. Recovery point ${point.id} left in place.`)
    return { status: "rejected", recoveryId: point.id, createdFiles: created }
  }

  engine.performSwap(root, verified.build)

  if (interaction.applyThemePreference && /\btheme\b/i.test(request)) {
    await interaction.applyThemePreference({ root, request })
  }

  const matches = engine.runningBinMatchesRoot(root)
  const restart = `Applied and verified. Restart furnace to load your changes. If startup breaks, run: furnace --recover ${point.id}`
  interaction.notify(
    matches
      ? restart
      : `${restart}\nNote: the change was built into ${root}/dist, but the furnace you are running appears to live elsewhere — restart the one at ${root}.`,
  )
  return { status: "applied", recoveryId: point.id, runningBinMatchesRoot: matches, createdFiles: created }
}

function gitDiff(root: string): string {
  // Compact stat only — a full diff can be thousands of lines and is unsafe to
  // stuff into a TUI question prompt. The stat gives files + line counts.
  const result = spawnSync("git", ["--no-pager", "diff", "--stat", "HEAD"], { cwd: resolve(root), encoding: "utf8" })
  return (result.stdout ?? "").trim()
}

/** True when the running process entry resolves under `${root}/dist`. */
export function runningBinMatchesRoot(root: string): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  return resolve(entry).startsWith(resolve(root))
}
