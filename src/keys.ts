import { execSync } from "node:child_process"
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export type StoredKeys = Record<string, string>

function keysPath(): string {
  return join(homedir(), ".furnace", "auth.json")
}

// Cache shell command results for the process lifetime (same as Pi).
const cmdCache = new Map<string, string | undefined>()

/**
 * Resolve a stored key value.
 * If the value starts with "!", the remainder is executed as a shell command
 * and the trimmed stdout is returned (enables 1Password, pass, etc.).
 * Plain strings are returned as-is.
 */
export function resolveKeyValue(raw: string): string | undefined {
  if (!raw) return undefined
  if (!raw.startsWith("!")) return raw
  if (cmdCache.has(raw)) return cmdCache.get(raw)
  try {
    const result = execSync(raw.slice(1), {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    const value = result || undefined
    cmdCache.set(raw, value)
    return value
  } catch {
    cmdCache.set(raw, undefined)
    return undefined
  }
}

export async function loadStoredKeys(): Promise<StoredKeys> {
  try {
    return JSON.parse(await readFile(keysPath(), "utf8")) as StoredKeys
  } catch {
    return {}
  }
}

export async function saveStoredKeys(keys: StoredKeys): Promise<void> {
  const path = keysPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(keys, null, 2)}\n`, "utf8")
  await chmod(path, 0o600)
}

export async function getStoredKey(provider: keyof StoredKeys): Promise<string | undefined> {
  return (await loadStoredKeys())[provider]
}

export async function setStoredKey(provider: keyof StoredKeys, key: string): Promise<void> {
  const current = await loadStoredKeys()
  await saveStoredKeys({ ...current, [provider]: key })
}

export async function removeStoredKey(provider: keyof StoredKeys): Promise<boolean> {
  const current = await loadStoredKeys()
  if (!(provider in current)) return false
  delete current[provider]
  await saveStoredKeys(current)
  return true
}
