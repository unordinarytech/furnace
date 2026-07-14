import type { FurnaceConfig } from "../config.js"
import type { OpenRouterModel } from "../openrouter.js"
import { createAnthropicProvider } from "./anthropic.js"
import { loadCustomProviders } from "./custom.js"
import { createOpenAICompatibleProvider } from "./openai-compatible.js"
import { BUILTIN_PROVIDERS } from "./registry.js"
import { resolveProviderKey } from "./resolution.js"
import type { CustomProvider, ProviderDefinition } from "./types.js"

export type ProviderModel = OpenRouterModel & {
  providerId: string
  providerLabel: string
}

export type ModelListCache = {
  models?: ProviderModel[]
  promise: Promise<ProviderModel[]>
  settled: boolean
}

export function createModelListCache(config: FurnaceConfig): ModelListCache {
  const promise = fetchAllProviderModels(config)
  const cache: ModelListCache = { promise, settled: false }
  promise.then(
    (models) => {
      cache.models = models
      cache.settled = true
    },
    () => {
      cache.settled = true
    },
  )
  return cache
}

async function fetchAllProviderModels(config: FurnaceConfig): Promise<ProviderModel[]> {
  const customProviders = await loadCustomProviders().catch(() => [] as CustomProvider[])
  const definitions: ProviderDefinition[] = [
    ...BUILTIN_PROVIDERS,
    ...customProviders.map(({ apiKey: _unused, ...definition }) => definition),
  ]
  const results = await Promise.all(
    definitions.map(async (definition) => {
      const { apiKey } = await resolveProviderKey(definition, customProviders)
      if (!apiKey) return []
      const adapter = definition.protocol === "anthropic" ? createAnthropicProvider() : createOpenAICompatibleProvider()
      const models = await adapter
        .listModels({ ...definition, apiKey, siteUrl: config.siteUrl, appName: config.appName })
        .catch(() => [] as OpenRouterModel[])
      return models.map((model) => ({
        ...model,
        providerId: definition.id,
        providerLabel: definition.displayName,
      }))
    }),
  )
  const models = results.flat()
  models.sort((left, right) => (
    (left.providerId === config.provider ? 0 : 1) - (right.providerId === config.provider ? 0 : 1)
  ))
  return models
}
