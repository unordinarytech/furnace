export type EvolveUnavailableReason = "no-source" | "not-git"

export type FurnaceRootResult =
  | { available: true; root: string }
  | { available: false; reason: EvolveUnavailableReason; message: string }

export type RecoveryPoint = {
  id: string
  furnaceRoot: string
  rootHash: string
  ref: string
  distCopyPath: string
  createdFiles: string[]
  description: string
  createdAt: string
  lastEvolve: boolean
}

export type RestoreResult =
  | { ok: true; point: RecoveryPoint }
  | { ok: false; reason: "not-found" | "cross-root" | "error"; message: string }

export type ResetResult =
  | { ok: true; baseline: RecoveryPoint; undoneCount: number; deletedFiles: string[] }
  | { ok: false; reason: "nothing" | "error"; message: string }

export type VerifyStep = "typecheck" | "build" | "smoke" | "swap"

export type VerifyResult =
  | { ok: true }
  | { ok: false; step: VerifyStep; log: string }

export type EvolveOutcome =
  | { status: "applied"; recoveryId: string; runningBinMatchesRoot: boolean; createdFiles: string[] }
  | { status: "verify-failed"; recoveryId: string; step: VerifyStep; log: string; createdFiles: string[] }
  | { status: "rejected"; recoveryId: string; createdFiles: string[] }
  | { status: "unavailable"; reason: EvolveUnavailableReason; message: string }
