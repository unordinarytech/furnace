import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import dotenv from "dotenv"
import { loadPreferences, type ModelSettings, type StatusLinePreferences, type TypingIndicatorStyle } from "./preferences.js"
import { getStoredKey } from "./keys.js"

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
  sidebarEnabled: boolean
  siteUrl: string
  skillPaths: string[]
  statusLine: StatusLinePreferences
  subagentSystemPrompt: string
  systemPrompt: string
  theme: string
  typingIndicatorBlink: boolean
  typingIndicator: TypingIndicatorStyle
  titleModel: string
  titleSystemPrompt: string
}

export function isApiKeyMissing(config: FurnaceConfig): boolean {
  return !config.openRouterApiKey
}

export async function loadConfig(): Promise<FurnaceConfig> {
  dotenv.config({ quiet: true })

  const envKey = process.env.OPENROUTER_API_KEY?.trim()
  const storedKey = envKey ? undefined : await getStoredKey("openrouter")
  const openRouterApiKey = envKey || storedKey || ""
  const preferences = await loadPreferences()

  return {
    appName: process.env.OPENROUTER_APP_NAME?.trim() || "Furnace",
    inputMode: preferences.inputMode || "standard",
    model: preferences.model?.trim() || process.env.OPENROUTER_MODEL?.trim() || "anthropic/claude-sonnet-4.6",
    notifications: preferences.notifications === true,
    modelSettings: preferences.modelSettings || {},
    openRouterApiKey,
    sidebarEnabled: preferences.sidebarEnabled !== false,
    siteUrl: process.env.OPENROUTER_SITE_URL?.trim() || "http://localhost",
    skillPaths: Array.isArray(preferences.skillPaths) ? preferences.skillPaths.filter((path) => typeof path === "string" && path.trim()).map((path) => path.trim()) : [],
    statusLine: statusLinePreferences(preferences),
    subagentSystemPrompt: await readFile(subagentPromptPath, "utf8"),
    systemPrompt: await readFile(promptPath, "utf8"),
    theme: preferences.theme?.trim() || process.env.FURNACE_THEME?.trim() || "flexoki",
    typingIndicatorBlink: preferences.typingIndicatorBlink === true,
    typingIndicator: (preferences.typingIndicator as string) === "blink" ? "block" : preferences.typingIndicator || "block",
    titleModel: process.env.OPENROUTER_TITLE_MODEL?.trim() || "openai/gpt-4o-mini",
    titleSystemPrompt: await readFile(titlePromptPath, "utf8"),
  }
}

function statusLinePreferences(preferences: Awaited<ReturnType<typeof loadPreferences>>): StatusLinePreferences {
  return {
    statusShowAppName: preferences.statusShowAppName,
    statusShowContext: preferences.statusShowContext,
    statusShowContextPercent: preferences.statusShowContextPercent,
    statusContextMode: preferences.statusContextMode,
    statusShowCwd: preferences.statusShowCwd,
    statusShowFast: preferences.statusShowFast,
    statusShowForkParent: preferences.statusShowForkParent,
    statusShowMode: preferences.statusShowMode,
    statusShowModel: preferences.statusShowModel,
    statusShowReasoning: preferences.statusShowReasoning,
    statusShowTheme: preferences.statusShowTheme,
    statusShowTitle: preferences.statusShowTitle,
    statusShowWindow: preferences.statusShowWindow,
  }
}
