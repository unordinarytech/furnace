import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import dotenv from "dotenv"
import { loadPreferences, normalizeTerminalLayout, type ModelSettings, type StatusLinePreferences, type TerminalLayout, type TypingIndicatorStyle } from "./preferences.js"
import { getStoredKey, resolveKeyValue } from "./keys.js"
import { loadCustomProviders } from "./providers/custom.js"
import { resolveProvider, BUILTIN_PROVIDERS } from "./providers/registry.js"
import type { ResolvedProvider } from "./providers/types.js"

const currentDir = dirname(fileURLToPath(import.meta.url))
const promptsDir = join(currentDir, "prompts")
const promptPath = join(promptsDir, "base-system.md")
const subagentPromptPath = join(promptsDir, "subagent-system.md")
const titlePromptPath = join(promptsDir, "title-system.md")

export type FurnaceConfig = {
  appName: string
  layout: TerminalLayout
  model: string
  modelSettings: ModelSettings
  notifications: boolean
  provider: string
  apiKey: string
  providerConfig: ResolvedProvider
  openRouterApiKey: string
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
  return !config.apiKey
}

export async function loadConfig(): Promise<FurnaceConfig> {
  dotenv.config({ quiet: true })
  const preferences = await loadPreferences()
  const providerId = preferences.provider?.trim() || "openrouter"
  const customProviders = await loadCustomProviders()
  const def = resolveProvider(providerId, customProviders)

  const effectiveProviderId = def ? providerId : "openrouter"
  const effectiveDef = def || BUILTIN_PROVIDERS[0]

  const envVarName = effectiveDef.envVar
  const envKey = envVarName ? process.env[envVarName]?.trim() : undefined
  const rawStoredKey = envKey ? undefined : await getStoredKey(effectiveProviderId)
  const storedKey = rawStoredKey ? resolveKeyValue(rawStoredKey) : undefined

  const customProvider = customProviders.find((p) => p.id === effectiveProviderId)
  const customKey = (!envKey && !storedKey && customProvider?.apiKey) ? resolveKeyValue(customProvider.apiKey) : undefined

  const apiKey = envKey || storedKey || customKey || ""

  const providerConfig: ResolvedProvider = {
    ...effectiveDef,
    apiKey,
    siteUrl: process.env.OPENROUTER_SITE_URL?.trim() || "http://localhost",
    appName: process.env.OPENROUTER_APP_NAME?.trim() || "Furnace",
  }

  return {
    appName: process.env.OPENROUTER_APP_NAME?.trim() || "Furnace",
    layout: normalizeTerminalLayout(preferences.layout || process.env.FURNACE_LAYOUT?.trim()),
    model: preferences.model?.trim() || process.env.OPENROUTER_MODEL?.trim() || "anthropic/claude-sonnet-4-6",
    notifications: preferences.notifications === true,
    modelSettings: preferences.modelSettings || {},
    provider: effectiveProviderId,
    apiKey,
    providerConfig,
    openRouterApiKey: apiKey,
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
    statusShowCost: preferences.statusShowCost,
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
