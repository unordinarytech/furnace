import { spawnSync } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { RecoveryPoint, ResetResult, RestoreResult } from "./types.js"

/**
 * Recovery points let an evolve be rolled back. Each point captures:
 *  - a git snapshot ref of tracked source (HEAD when clean, else a
 *    `git stash create` commit) tagged under a root-namespaced ref,
 *  - a copy of the current known-good `dist/` so recovery can restore a
 *    runnable bundle WITHOUT rebuilding or running the new bundle (KTD8),
 *  - the set of files the evolve created, so restore removes exactly those
 *    without a blanket `git clean` that would destroy unrelated user work.
 *
 * The registry is global (~/.furnace/recovery/registry.json) but every entry
 * is keyed by absolute furnaceRoot and filtered per-root (KTD11).
 */

export function recoveryRegistryPath(): string {
  return join(homedir(), ".furnace", "recovery", "registry.json")
}

function recoveryDir(root: string, id: string): string {
  return join(resolve(root), ".furnace", "recovery", id)
}

function rootHashOf(root: string): string {
  return createHash("sha256").update(resolve(root)).digest("hex").slice(0, 12)
}

function newId(): string {
  return BigInt(`0x${randomBytes(6).toString("hex")}`).toString(36).slice(0, 6).padStart(6, "0")
}

function git(root: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const result = spawnSync("git", args, { cwd: resolve(root), encoding: "utf8" })
  return {
    code: result.status ?? 1,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? result.error?.message ?? "").trim(),
  }
}

function checkedGit(root: string, args: string[]): string {
  const result = git(root, args)
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.code}): ${result.stderr || "no error output"}`)
  }
  return result.stdout
}

function readRegistry(): RecoveryPoint[] {
  try {
    const parsed = JSON.parse(readFileSync(recoveryRegistryPath(), "utf8")) as { points?: RecoveryPoint[] }
    return Array.isArray(parsed.points) ? parsed.points : []
  } catch {
    return []
  }
}

function writeRegistry(points: RecoveryPoint[]): void {
  const path = recoveryRegistryPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ points }, null, 2)}\n`, "utf8")
}

/** All porcelain status paths — used to detect whether the tree is clean. */
export function snapshotStatus(root: string): string[] {
  const stdout = checkedGit(root, ["status", "--porcelain", "-unormal"])
  if (!stdout) return []
  return stdout.split("\n").map((line) => line.slice(3).trim()).filter(Boolean)
}

/**
 * Only NEW files (untracked "??" or staged-add "A ") — used to compute the
 * set of files an evolve created. Modified tracked files are deliberately
 * excluded: they are reverted by `git checkout <ref> -- .`, not deleted.
 */
export function listNewFiles(root: string): string[] {
  const stdout = checkedGit(root, ["status", "--porcelain", "-unormal"])
  if (!stdout) return []
  return stdout
    .split("\n")
    .filter((line) => line.startsWith("??") || line.startsWith("A "))
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
}

export function createRecoveryPoint(root: string, description: string): RecoveryPoint {
  const absRoot = resolve(root)
  const id = newId()
  const rootHash = rootHashOf(absRoot)

  const clean = snapshotStatus(absRoot).length === 0
  const ref = clean
    ? checkedGit(absRoot, ["rev-parse", "HEAD"])
    : checkedGit(absRoot, ["stash", "create", `furnace-evolve pre-change ${id}`]) || checkedGit(absRoot, ["rev-parse", "HEAD"])
  if (!ref) throw new Error("Git did not produce a recovery snapshot ref.")

  // Tag the snapshot so it survives GC; namespace by root for multi-worktree safety.
  checkedGit(absRoot, ["tag", `furnace-recovery/${rootHash}/${id}`, ref])

  // Copy the current known-good dist so recovery never needs a rebuild.
  const distCopyPath = join(recoveryDir(absRoot, id), "dist")
  const liveDist = join(absRoot, "dist")
  if (existsSync(liveDist)) {
    mkdirSync(dirname(distCopyPath), { recursive: true })
    cpSync(liveDist, distCopyPath, { recursive: true })
  }

  const point: RecoveryPoint = {
    id,
    furnaceRoot: absRoot,
    rootHash,
    ref,
    distCopyPath,
    createdFiles: [],
    description,
    createdAt: new Date().toISOString(),
    lastEvolve: true,
  }

  const points = readRegistry()
  for (const existing of points) {
    if (existing.furnaceRoot === absRoot) existing.lastEvolve = false
  }
  points.push(point)
  writeRegistry(points)
  return point
}

export function recordCreatedFiles(id: string, createdFiles: string[]): void {
  const points = readRegistry()
  const point = points.find((candidate) => candidate.id === id)
  if (!point) return
  point.createdFiles = createdFiles
  writeRegistry(points)
}

export function listRecoveryPoints(): RecoveryPoint[] {
  return readRegistry()
}

export function latestForRoot(root: string): RecoveryPoint | undefined {
  const absRoot = resolve(root)
  return readRegistry()
    .filter((point) => point.furnaceRoot === absRoot)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
}

/** All recovery points for a root, oldest first. */
export function pointsForRoot(root: string): RecoveryPoint[] {
  const absRoot = resolve(root)
  return readRegistry()
    .filter((point) => point.furnaceRoot === absRoot)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
}

/**
 * Reset the harness to its default state: revert tracked source to the earliest
 * recovery point (the state before the first evolve), delete every file any
 * evolve created, restore that baseline's known-good dist, and clear this
 * root's recovery history. Keeps git-committed work; discards evolve's
 * uncommitted source edits.
 */
export function resetToBaseline(root: string): ResetResult {
  const absRoot = resolve(root)
  const points = pointsForRoot(absRoot)
  if (points.length === 0) {
    return { ok: false, reason: "nothing", message: "No evolve changes recorded — furnace is already at its default state." }
  }
  const baseline = points[0]!
  const deletedFiles = [...new Set(points.flatMap((point) => point.createdFiles))]
  try {
    // Restore the pre-evolve known-good dist (no rebuild needed).
    if (baseline.distCopyPath && existsSync(baseline.distCopyPath)) {
      const liveDist = join(absRoot, "dist")
      rmSync(liveDist, { recursive: true, force: true })
      cpSync(baseline.distCopyPath, liveDist, { recursive: true })
    }
    // Revert tracked source to the baseline snapshot (no branch move).
    checkedGit(absRoot, ["checkout", baseline.ref, "--", "."])
    // Delete exactly the files evolve created (never a blanket clean).
    for (const relative of deletedFiles) {
      rmSync(join(absRoot, relative), { recursive: true, force: true })
    }
    // Drop this root's recovery history — we are back at baseline.
    writeRegistry(readRegistry().filter((point) => point.furnaceRoot !== absRoot))
    return { ok: true, baseline, undoneCount: points.length, deletedFiles }
  } catch (error) {
    return { ok: false, reason: "error", message: error instanceof Error ? error.message : String(error) }
  }
}

export function restoreRecoveryPoint(id: string, runningRoot: string): RestoreResult {
  const points = readRegistry()
  const point = points.find((candidate) => candidate.id === id)
  if (!point) return { ok: false, reason: "not-found", message: `No recovery point with id "${id}".` }
  if (point.furnaceRoot !== resolve(runningRoot)) {
    return {
      ok: false,
      reason: "cross-root",
      message: `Recovery point "${id}" belongs to ${point.furnaceRoot}, not the current furnace root ${resolve(runningRoot)}.`,
    }
  }

  try {
    // 1. Restore the known-good dist first (KTD8 — no rebuild, no running the new bundle).
    if (point.distCopyPath && existsSync(point.distCopyPath)) {
      const liveDist = join(point.furnaceRoot, "dist")
      rmSync(liveDist, { recursive: true, force: true })
      cpSync(point.distCopyPath, liveDist, { recursive: true })
    }
    // 2. Revert tracked source to the snapshot (no branch move).
    checkedGit(point.furnaceRoot, ["checkout", point.ref, "--", "."])
    // 3. Delete exactly the files the evolve created (never a blanket clean).
    for (const relative of point.createdFiles) {
      rmSync(join(point.furnaceRoot, relative), { recursive: true, force: true })
    }
    return { ok: true, point }
  } catch (error) {
    return { ok: false, reason: "error", message: error instanceof Error ? error.message : String(error) }
  }
}
