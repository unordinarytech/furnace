import type { ProviderDefinition, CustomProvider } from "./types.js"

export const BUILTIN_PROVIDERS: ProviderDefinition[] = [
  {
    id: "openrouter",
    displayName: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    protocol: "openai-compatible",
    envVar: "OPENROUTER_API_KEY",
    defaultModel: "anthropic/claude-sonnet-4.6",
  },
  {
    id: "openai",
    displayName: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    protocol: "openai-compatible",
    envVar: "OPENAI_API_KEY",
    defaultModel: "gpt-4o",
  },
  {
    id: "anthropic",
    displayName: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    protocol: "anthropic",
    envVar: "ANTHROPIC_API_KEY",
    defaultModel: "claude-sonnet-4-20250514",
  },
  {
    id: "deepseek",
    displayName: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    protocol: "openai-compatible",
    envVar: "DEEPSEEK_API_KEY",
    defaultModel: "deepseek-chat",
  },
  {
    id: "glm",
    displayName: "GLM (Zhipu)",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    protocol: "openai-compatible",
    envVar: "GLM_API_KEY",
    defaultModel: "glm-4",
  },
]

export function resolveProvider(
  providerId: string,
  custom: CustomProvider[],
): ProviderDefinition | undefined {
  const builtin = BUILTIN_PROVIDERS.find((p) => p.id === providerId)
  if (builtin) return builtin
  const customMatch = custom.find((p) => p.id === providerId)
  if (customMatch) {
    const { apiKey: _, ...def } = customMatch
    return def
  }
  return undefined
}

export function allProviderIds(custom: CustomProvider[]): string[] {
  return [...BUILTIN_PROVIDERS.map((p) => p.id), ...custom.map((p) => p.id)]
}
