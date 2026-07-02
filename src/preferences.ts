import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export type FurnacePreferences = {
  inputMode?: "standard" | "vim"
  model?: string
  modelSettings?: ModelSettings
  notifications?: boolean
  skillPaths?: string[]
  theme?: string
}

export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh"

export type ModelSettings = {
  contextLength?: number
  reasoningEffort?: ReasoningEffort
  fast?: boolean
}

async function readPreferencesFile(filePath: string): Promise<FurnacePreferences> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as FurnacePreferences
  } catch {
    return {}
  }
}

export async function loadPreferences(cwd = process.cwd()): Promise<FurnacePreferences> {
  const globalPrefs = await readPreferencesFile(globalPreferencesPath())
  const projectPrefs = await readPreferencesFile(preferencesPath(cwd))
  return Object.assign({}, globalPrefs, projectPrefs)
}

export async function saveGlobalPreferences(update: FurnacePreferences): Promise<void> {
  const path = globalPreferencesPath()
  const preferences = await readPreferencesFile(path)
  Object.assign(preferences, update)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(preferences, null, 2)}\n`, "utf8")
}

function globalPreferencesPath(): string {
  return join(homedir(), ".furnace", "preferences.json")
}

export async function saveModelPreference(cwd: string, model: string): Promise<void> {
  await saveModelPreferences(cwd, { model })
}

export async function saveModelPreferences(cwd: string, update: FurnacePreferences): Promise<void> {
  const path = preferencesPath(cwd)
  const preferences = await loadPreferences(cwd)
  Object.assign(preferences, update)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(preferences, null, 2)}\n`, "utf8")
}

export async function saveThemePreference(cwd: string, theme: string): Promise<void> {
  await saveModelPreferences(cwd, { theme })
}

function preferencesPath(cwd: string): string {
  return join(cwd, ".furnace", "preferences.json")
}
