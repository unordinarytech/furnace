import { mkdirSync } from "node:fs"
import { join, resolve } from "node:path"

export function projectStateDir(cwd: string): string {
  return join(resolve(cwd), ".furnace")
}

export function isProtectedSystemPath(cwd: string, platform: NodeJS.Platform = process.platform): boolean {
  const resolved = resolve(cwd)
  const absolute = resolved === "/" ? "/" : resolved.replace(/[/\\]+$/, "")

  if (platform === "win32") {
    // Resolve on non-Windows turns "C:\Windows\..." into a relative path under cwd.
    // Match the raw input as well so capability checks stay accurate cross-platform.
    const candidate = /^[a-z]:[\\/]/i.test(cwd)
      ? cwd.replace(/\//g, "\\").replace(/\\+$/, "")
      : absolute.replace(/\//g, "\\")
    const value = candidate.toLowerCase()
    if (/^[a-z]:$/i.test(value)) return true
    if (/\\windows(\\system32|\\syswow64)?$/i.test(value)) return true
    if (/\\windows\\(system32|syswow64)(\\|$)/i.test(value)) return true
    if (/\\program files( \(x86\))?(\\|$)/i.test(value)) return true
    if (/\\programdata(\\|$)/i.test(value)) return true
    return false
  }

  if (absolute === "/") return true
  const parts = absolute.split("/").filter(Boolean)
  const top = parts[0]
  return Boolean(top && parts.length === 1 && ["bin", "boot", "dev", "etc", "lib", "lib64", "proc", "root", "sbin", "sys", "usr"].includes(top))
}

export function formatWorkspaceStateError(cwd: string, cause: unknown): Error {
  const stateDir = projectStateDir(cwd)
  const code = cause && typeof cause === "object" && "code" in cause
    ? String((cause as { code?: unknown }).code || "")
    : ""
  const detail = cause instanceof Error ? cause.message : String(cause)
  const protectedHint = isProtectedSystemPath(cwd)
    ? ` "${cwd}" looks like a system directory.`
    : ""
  const example = process.platform === "win32" ? "C:\\path\\to\\your-project" : "/path/to/your-project"
  return new Error(
    `Cannot create project state at ${stateDir}${code ? ` (${code})` : ""}.${protectedHint}\n`
    + "Run furnace from a writable project folder instead, for example:\n"
    + `  cd ${example}\n`
    + "  furnace\n"
    + `(${detail})`,
  )
}

export function ensureProjectStateDir(cwd: string): string {
  const stateDir = projectStateDir(cwd)
  if (isProtectedSystemPath(cwd)) {
    throw formatWorkspaceStateError(cwd, Object.assign(new Error("refusing protected system path"), { code: "EPERM" }))
  }
  try {
    mkdirSync(stateDir, { recursive: true })
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code || "")
      : ""
    if (code === "EPERM" || code === "EACCES" || code === "EROFS" || code === "ENOENT") {
      throw formatWorkspaceStateError(cwd, error)
    }
    throw error
  }
  return stateDir
}
