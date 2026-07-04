import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { CustomProvider } from "./types.js"

function providersPath(): string {
  return join(homedir(), ".furnace", "providers.json")
}

export async function loadCustomProviders(): Promise<CustomProvider[]> {
  try {
    const raw = JSON.parse(await readFile(providersPath(), "utf8")) as { providers?: CustomProvider[] }
    return Array.isArray(raw.providers) ? raw.providers : []
  } catch {
    return []
  }
}

export async function saveCustomProviders(providers: CustomProvider[]): Promise<void> {
  const path = providersPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify({ providers }, null, 2)}\n`, "utf8")
  await chmod(path, 0o600)
}
