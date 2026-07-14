import { getStoredKey, resolveKeyValue } from "../keys.js"
import type { FurnaceConfig } from "../config.js"
import type { CustomProvider, ProviderDefinition, ResolvedProvider } from "./types.js"

export type ProviderKeySource = "custom" | "environment" | "fallback" | "missing" | "saved"

export type ProviderKeyState = {
  apiKey: string
  hasCustomKey: boolean
  hasSavedKey: boolean
  source: ProviderKeySource
}

export async function resolveProviderKey(
  definition: ProviderDefinition,
  customProviders: CustomProvider[],
  fallbackKey = "",
): Promise<ProviderKeyState> {
  const envKey = definition.envVar ? process.env[definition.envVar]?.trim() : undefined
  const rawStoredKey = await getStoredKey(definition.id)
  const storedKey = rawStoredKey ? resolveKeyValue(rawStoredKey) : undefined
  const rawCustomKey = customProviders.find((provider) => provider.id === definition.id)?.apiKey
  const customKey = rawCustomKey ? resolveKeyValue(rawCustomKey) : undefined
  const flags = { hasCustomKey: Boolean(rawCustomKey), hasSavedKey: Boolean(rawStoredKey) }

  if (envKey) return { apiKey: envKey, ...flags, source: "environment" }
  if (storedKey) return { apiKey: storedKey, ...flags, source: "saved" }
  if (customKey) return { apiKey: customKey, ...flags, source: "custom" }
  if (fallbackKey) return { apiKey: fallbackKey, ...flags, source: "fallback" }
  return { apiKey: "", ...flags, source: "missing" }
}

export function createResolvedProvider(
  definition: ProviderDefinition,
  apiKey: string,
  metadata: { appName: string; siteUrl: string },
): ResolvedProvider {
  return {
    ...definition,
    apiKey,
    appName: metadata.appName,
    siteUrl: metadata.siteUrl,
  }
}

export function activateProvider(config: FurnaceConfig, definition: ProviderDefinition, apiKey: string): void {
  config.provider = definition.id
  config.apiKey = apiKey
  config.providerConfig = createResolvedProvider(definition, apiKey, config)
}
