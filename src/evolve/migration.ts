import { execFile } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { promisify } from "node:util"
import {
  activateManagedFurnaceRoot,
  clearActiveEvolve,
  readActiveEvolveManifest,
  type ActiveEvolveManifest,
} from "./activation.js"
import { prepareManagedFurnaceSource } from "./managed-source.js"
import { createRecoveryPoint, listNewFiles, recordCreatedFiles } from "./recovery.js"
import { performSwap, verifyToTemp, type BuildOutcome, type VerifyToTempResult } from "./verify.js"

const execFileAsync = promisify(execFile)
const MAX_GIT_OUTPUT = 50 * 1024 * 1024

export type EvolveMigrationState = {
  createdAt: string
  error: string
  fromVersion: string
  oldRoot: string
  patchPath: string
  recoveryId?: string
  status: "conflict" | "failed"
  targetRoot: string
  toVersion: string
  version: 1
}

export type EvolveMigrationResult =
  | { status: "none" }
  | { status: "no-changes" }
  | { status: "migrated"; recoveryId: string; root: string }
  | { status: "pending"; state: EvolveMigrationState }

type MigrationDeps = {
  activate: (root: string) => void
  applyPatch: (root: string, patchPath: string) => Promise<{ log: string; ok: boolean }>
  capturePatch: (root: string) => Promise<string>
  createRecovery: (root: string, description: string) => { id: string }
  listNewFiles: (root: string) => string[]
  prepareSource: (version: string, onStatus?: (message: string) => void) => ReturnType<typeof prepareManagedFurnaceSource>
  recordCreatedFiles: (id: string, files: string[]) => void
  status: (root: string) => Promise<string>
  swap: (root: string, build: BuildOutcome) => void
  verify: (root: string) => Promise<VerifyToTempResult>
}

export function evolveMigrationStatePath(): string {
  return join(homedir(), ".furnace", "evolve", "migration.json")
}

export async function readEvolveMigrationState(): Promise<EvolveMigrationState | undefined> {
  try {
    const state = JSON.parse(await readFile(evolveMigrationStatePath(), "utf8")) as Partial<EvolveMigrationState>
    if (
      state.version !== 1
      || (state.status !== "conflict" && state.status !== "failed")
      || typeof state.fromVersion !== "string"
      || typeof state.toVersion !== "string"
      || typeof state.oldRoot !== "string"
      || typeof state.targetRoot !== "string"
      || typeof state.patchPath !== "string"
      || typeof state.error !== "string"
      || typeof state.createdAt !== "string"
    ) return undefined
    return state as EvolveMigrationState
  } catch {
    return undefined
  }
}

export async function attemptEvolveMigration(input: {
  currentVersion: string
  onStatus?: (message: string) => void
  deps?: Partial<MigrationDeps>
  manifest?: ActiveEvolveManifest
}): Promise<EvolveMigrationResult> {
  const manifest = input.manifest ?? readActiveEvolveManifest()
  if (!manifest || manifest.packageVersion === input.currentVersion) return { status: "none" }

  const existing = await readEvolveMigrationState()
  if (existing?.toVersion === input.currentVersion) return { status: "pending", state: existing }
  if (!existsSync(manifest.sourceRoot)) {
    return pendingState({
      error: `The previous evolved source is missing: ${manifest.sourceRoot}`,
      manifest,
      patchPath: "",
      status: "failed",
      targetRoot: "",
      toVersion: input.currentVersion,
    })
  }

  const deps = { ...defaultMigrationDeps, ...input.deps }
  input.onStatus?.(`Migrating evolved changes from ${manifest.packageVersion} to ${input.currentVersion}…`)
  const prepared = await deps.prepareSource(input.currentVersion, input.onStatus)
  if (!prepared.available) {
    return pendingState({
      error: prepared.message,
      manifest,
      patchPath: "",
      status: "failed",
      targetRoot: "",
      toVersion: input.currentVersion,
    })
  }
  const targetRoot = prepared.root
  const targetStatus = await deps.status(targetRoot)
  if (targetStatus.trim()) {
    return pendingState({
      error: `The target checkout is not clean: ${targetStatus.trim().split("\n")[0]}`,
      manifest,
      patchPath: "",
      status: "failed",
      targetRoot,
      toVersion: input.currentVersion,
    })
  }

  const patch = await deps.capturePatch(manifest.sourceRoot)
  if (!patch.trim()) {
    clearActiveEvolve()
    await clearEvolveMigrationState()
    return { status: "no-changes" }
  }
  const patchPath = await writeMigrationPatch(manifest.packageVersion, input.currentVersion, patch)
  const point = deps.createRecovery(targetRoot, `migrate evolved changes from ${manifest.packageVersion}`)
  const applied = await deps.applyPatch(targetRoot, patchPath)
  const createdFiles = deps.listNewFiles(targetRoot)
  deps.recordCreatedFiles(point.id, createdFiles)
  if (!applied.ok) {
    return pendingState({
      error: applied.log || "Git could not apply the evolved changes cleanly.",
      manifest,
      patchPath,
      recoveryId: point.id,
      status: "conflict",
      targetRoot,
      toVersion: input.currentVersion,
    })
  }

  input.onStatus?.("Verifying migrated evolve changes…")
  const verified = await deps.verify(targetRoot)
  if (!verified.ok) {
    return pendingState({
      error: `${verified.step}: ${verified.log}`,
      manifest,
      patchPath,
      recoveryId: point.id,
      status: "failed",
      targetRoot,
      toVersion: input.currentVersion,
    })
  }

  deps.swap(targetRoot, verified.build)
  deps.activate(targetRoot)
  await clearEvolveMigrationState()
  return { status: "migrated", recoveryId: point.id, root: targetRoot }
}

export async function completePendingEvolveMigration(input: {
  onStatus?: (message: string) => void
  deps?: Partial<Pick<MigrationDeps, "activate" | "listNewFiles" | "recordCreatedFiles" | "status" | "swap" | "verify">>
} = {}): Promise<
  | { ok: true; recoveryId?: string; root: string }
  | { ok: false; message: string; state?: EvolveMigrationState }
> {
  const state = await readEvolveMigrationState()
  if (!state) return { ok: false, message: "No evolved-change migration is waiting to be resolved." }
  const deps = { ...defaultMigrationDeps, ...input.deps }
  const status = await deps.status(state.targetRoot)
  if (/^UU |^AA |^DD |^AU |^UA |^DU |^UD /m.test(status)) {
    const updated = { ...state, error: "Git merge conflicts are still unresolved.", status: "conflict" as const }
    await writeEvolveMigrationState(updated)
    return { ok: false, message: updated.error, state: updated }
  }
  input.onStatus?.("Verifying the resolved evolve migration…")
  const verified = await deps.verify(state.targetRoot)
  if (!verified.ok) {
    const updated = { ...state, error: `${verified.step}: ${verified.log}`, status: "failed" as const }
    await writeEvolveMigrationState(updated)
    return { ok: false, message: updated.error, state: updated }
  }
  if (state.recoveryId) {
    deps.recordCreatedFiles(state.recoveryId, deps.listNewFiles(state.targetRoot))
  }
  deps.swap(state.targetRoot, verified.build)
  deps.activate(state.targetRoot)
  await clearEvolveMigrationState()
  return { ok: true, recoveryId: state.recoveryId, root: state.targetRoot }
}

async function pendingState(input: {
  error: string
  manifest: ActiveEvolveManifest
  patchPath: string
  recoveryId?: string
  status: EvolveMigrationState["status"]
  targetRoot: string
  toVersion: string
}): Promise<EvolveMigrationResult> {
  const state: EvolveMigrationState = {
    createdAt: new Date().toISOString(),
    error: input.error,
    fromVersion: input.manifest.packageVersion,
    oldRoot: input.manifest.sourceRoot,
    patchPath: input.patchPath,
    recoveryId: input.recoveryId,
    status: input.status,
    targetRoot: input.targetRoot,
    toVersion: input.toVersion,
    version: 1,
  }
  await writeEvolveMigrationState(state)
  return { status: "pending", state }
}

async function writeEvolveMigrationState(state: EvolveMigrationState): Promise<void> {
  const path = evolveMigrationStatePath()
  const temp = `${path}.${process.pid}.tmp`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8")
  await rename(temp, path)
}

async function clearEvolveMigrationState(): Promise<void> {
  await rm(evolveMigrationStatePath(), { force: true })
}

async function writeMigrationPatch(fromVersion: string, toVersion: string, patch: string): Promise<string> {
  const path = join(homedir(), ".furnace", "evolve", "migrations", `${fromVersion}-to-${toVersion}.patch`)
  const temp = `${path}.${process.pid}.tmp`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(temp, patch, "utf8")
  await rename(temp, path)
  return path
}

async function gitResult(root: string, args: string[], env?: NodeJS.ProcessEnv): Promise<{ log: string; ok: boolean; stdout: string }> {
  try {
    const result = await execFileAsync("git", ["-C", resolve(root), ...args], {
      encoding: "utf8",
      env: env ? { ...process.env, ...env } : process.env,
      maxBuffer: MAX_GIT_OUTPUT,
    })
    return { ok: true, stdout: result.stdout, log: [result.stdout, result.stderr].filter(Boolean).join("\n").trim() }
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string }
    return {
      ok: false,
      stdout: failure.stdout ?? "",
      log: [failure.stdout, failure.stderr, failure.message].filter(Boolean).join("\n").trim(),
    }
  }
}

export async function captureManagedEvolvePatch(root: string): Promise<string> {
  const indexPath = join(homedir(), ".furnace", "evolve", "tmp", `index-${process.pid}-${randomBytes(4).toString("hex")}`)
  await mkdir(dirname(indexPath), { recursive: true })
  const env = { GIT_INDEX_FILE: indexPath }
  try {
    const readTree = await gitResult(root, ["read-tree", "HEAD"], env)
    if (!readTree.ok) throw new Error(readTree.log)
    const add = await gitResult(root, ["add", "-A"], env)
    if (!add.ok) throw new Error(add.log)
    const diff = await gitResult(root, ["diff", "--cached", "--binary", "HEAD"], env)
    if (!diff.ok) throw new Error(diff.log)
    return diff.stdout
  } finally {
    await rm(indexPath, { force: true })
  }
}

const defaultMigrationDeps: MigrationDeps = {
  activate: activateManagedFurnaceRoot,
  applyPatch: async (root, patchPath) => {
    const result = await gitResult(root, ["apply", "--3way", "--index", patchPath])
    return { ok: result.ok, log: result.log }
  },
  capturePatch: captureManagedEvolvePatch,
  createRecovery: createRecoveryPoint,
  listNewFiles,
  prepareSource: (version, onStatus) => prepareManagedFurnaceSource({ version, onStatus }),
  recordCreatedFiles,
  status: async (root) => (await gitResult(root, ["status", "--porcelain"])).stdout,
  swap: performSwap,
  verify: verifyToTemp,
}
