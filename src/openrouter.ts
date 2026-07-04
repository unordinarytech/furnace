import type { FurnaceConfig } from "./config.js"
import { createOpenAICompatibleProvider } from "./providers/openai-compatible.js"
import { createAnthropicProvider } from "./providers/anthropic.js"
import type { Provider, ResolvedProvider, ChatMessage, ToolDefinition, ToolChoice, ModelInfo, AssistantResponse } from "./providers/types.js"

// Re-export types for backward compatibility
export type ContentBlock = import("./providers/types.js").ContentBlock
export type OpenRouterMessage = ChatMessage
export type OpenRouterToolDefinition = ToolDefinition
export type OpenRouterToolCall = import("./providers/types.js").ChatToolCall
export type OpenRouterAssistantResponse = AssistantResponse
export type OpenRouterToolChoice = ToolChoice
export type OpenRouterModel = ModelInfo
export type OpenRouterModelPricing = { completion: number; prompt: number }
export type OpenRouterUsage = import("./providers/types.js").Usage

function getAdapter(config: FurnaceConfig): Provider {
  if (config.providerConfig.protocol === "anthropic") {
    return createAnthropicProvider()
  }
  return createOpenAICompatibleProvider()
}

function toResolvedProvider(config: FurnaceConfig): ResolvedProvider {
  return config.providerConfig
}

export async function* streamOpenRouterResponse(
  config: FurnaceConfig,
  messages: ChatMessage[],
  signal?: AbortSignal,
): AsyncGenerator<string> {
  yield* getAdapter(config).streamChat(toResolvedProvider(config), config.model, messages, config.modelSettings, signal)
}

export async function completeOpenRouterResponse(
  config: FurnaceConfig,
  messages: ChatMessage[],
  options: { model?: string; maxTokens?: number } = {},
): Promise<string> {
  return getAdapter(config).completeChat(
    toResolvedProvider(config),
    options.model || config.model,
    messages,
    config.modelSettings,
    { maxTokens: options.maxTokens },
  )
}

export async function completeOpenRouterToolResponse(
  config: FurnaceConfig,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  options: { toolChoice?: ToolChoice; onTextDelta?: (delta: string) => void } = {},
  signal?: AbortSignal,
): Promise<AssistantResponse> {
  return getAdapter(config).completeToolChat(
    toResolvedProvider(config),
    config.model,
    messages,
    tools,
    config.modelSettings,
    options,
    signal,
  )
}

export async function listOpenRouterModels(config: FurnaceConfig): Promise<ModelInfo[]> {
  return getAdapter(config).listModels(toResolvedProvider(config))
}

export function isContextOverflowError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /\b(context|token|tokens|input)\b.*\b(length|limit|window|maximum|too large|too long|exceed)/i.test(message)
    || /\b(maximum context|context_length|context window|too many tokens|input is too long|prompt is too long)\b/i.test(message)
}
