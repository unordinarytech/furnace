import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

export type FurnacePreferences = {
  model?: string
  modelSettings?: ModelSettings
}

export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh"

export type ModelSettings = {
  contextLength?: number
  reasoningEffort?: ReasoningEffort
  fast?: boolean
}

export async function loadPreferences(cwd = process.cwd()): Promise<FurnacePreferences> {
  try {
    return JSON.parse(await readFile(preferencesPath(cwd), "utf8")) as FurnacePreferences
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {}
    return {}
  }
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

function preferencesPath(cwd: string): string {
  return join(cwd, ".furnace", "preferences.json")
}
