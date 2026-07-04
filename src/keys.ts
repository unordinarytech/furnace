import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export type StoredKeys = {
  openrouter?: string
  anthropic?: string
  openai?: string
}

function keysPath(): string {
  return join(homedir(), ".furnace", "keys.json")
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
