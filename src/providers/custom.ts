import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { CustomProvider } from "./types.js"

function providersPath(): string {
  return join(homedir(), ".furnace", "providers.json")
}

let writeQueue: Promise<unknown> = Promise.resolve()
let tempCounter = 0

export async function loadCustomProviders(): Promise<CustomProvider[]> {
  try {
    const raw = JSON.parse(await readFile(providersPath(), "utf8")) as { providers?: CustomProvider[] }
    return Array.isArray(raw.providers) ? raw.providers : []
  } catch {
    return []
  }
}

export async function saveCustomProviders(providers: CustomProvider[]): Promise<void> {
  const next = writeQueue.catch(() => undefined).then(() => writeProviders(providers))
  writeQueue = next
  await next
}

async function writeProviders(providers: CustomProvider[]): Promise<void> {
  const path = providersPath()
  await mkdir(dirname(path), { recursive: true })
  tempCounter += 1
  const tempPath = `${path}.${process.pid}.${tempCounter}.tmp`
  try {
    await writeFile(tempPath, `${JSON.stringify({ providers }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
    await chmod(tempPath, 0o600)
    await rename(tempPath, path)
    await chmod(path, 0o600)
  } finally {
    await rm(tempPath, { force: true }).catch(() => {})
  }
}
