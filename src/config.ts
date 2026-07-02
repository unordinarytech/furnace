import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import dotenv from "dotenv"
import { loadPreferences, type ModelSettings } from "./preferences.js"

const currentDir = dirname(fileURLToPath(import.meta.url))
const promptsDir = join(currentDir, "prompts")
const promptPath = join(promptsDir, "base-system.md")
const subagentPromptPath = join(promptsDir, "subagent-system.md")
const titlePromptPath = join(promptsDir, "title-system.md")

export type FurnaceConfig = {
  appName: string
  inputMode: "standard" | "vim"
  model: string
  modelSettings: ModelSettings
  notifications: boolean
  openRouterApiKey: string
  siteUrl: string
  skillPaths: string[]
  subagentSystemPrompt: string
  systemPrompt: string
  theme: string
  titleModel: string
  titleSystemPrompt: string
}

export async function loadConfig(): Promise<FurnaceConfig> {
  dotenv.config({ quiet: true })

  const openRouterApiKey = process.env.OPENROUTER_API_KEY?.trim()
  const preferences = await loadPreferences()

  if (!openRouterApiKey) {
    throw new Error("OPENROUTER_API_KEY is missing. Add it to .env before running Furnace.")
  }

  return {
    appName: process.env.OPENROUTER_APP_NAME?.trim() || "Furnace",
    inputMode: preferences.inputMode || "standard",
    model: preferences.model?.trim() || process.env.OPENROUTER_MODEL?.trim() || "anthropic/claude-sonnet-4.6",
    notifications: preferences.notifications === true,
    modelSettings: preferences.modelSettings || {},
    openRouterApiKey,
    siteUrl: process.env.OPENROUTER_SITE_URL?.trim() || "http://localhost",
    skillPaths: Array.isArray(preferences.skillPaths) ? preferences.skillPaths.filter((path) => typeof path === "string" && path.trim()).map((path) => path.trim()) : [],
    subagentSystemPrompt: await readFile(subagentPromptPath, "utf8"),
    systemPrompt: await readFile(promptPath, "utf8"),
    theme: preferences.theme?.trim() || process.env.FURNACE_THEME?.trim() || "flexoki",
    titleModel: process.env.OPENROUTER_TITLE_MODEL?.trim() || "openai/gpt-4o-mini",
    titleSystemPrompt: await readFile(titlePromptPath, "utf8"),
  }
}
