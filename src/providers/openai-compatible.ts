import type {
  Provider,
  ResolvedProvider,
  ChatMessage,
  ToolDefinition,
  ToolChoice,
  ModelInfo,
  AssistantResponse,
  Usage,
} from "./types.js"
import type { ModelSettings } from "../preferences.js"
import { normalizeTokenPricing, parseUsageCostUsd } from "../session/model-pricing.js"
import {
  shouldDisableThinkingForTools,
  shouldOmitToolChoice,
  wantsReasoningEffort,
} from "./model-capabilities.js"

type ChatCompletionChunk = {
  choices?: Array<{
    delta?: {
      content?: string
      tool_calls?: Array<{
        index?: number
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: { cost?: number; prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
  error?: { message?: string }
}

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> } }>
  error?: { message?: string }
}

type ModelsResponse = {
  data?: Array<{
    id?: string
    name?: string
    context_length?: number
    pricing?: { prompt?: string; completion?: string }
    supported_parameters?: string[]
  }>
  error?: { message?: string }
}

function buildHeaders(provider: ResolvedProvider): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${provider.apiKey}`,
    "Content-Type": "application/json",
  }
  if (provider.id === "openrouter") {
    headers["HTTP-Referer"] = provider.siteUrl || "http://localhost"
    headers["X-Title"] = provider.appName || "Furnace"
  }
  return headers
}

function buildRequestOptions(
  provider: ResolvedProvider,
  model: string,
  settings: ModelSettings,
  forTools = false,
): Record<string, unknown> {
  const options: Record<string, unknown> = {}
  if (forTools && shouldDisableThinkingForTools(model, settings)) {
    // DeepSeek V4 thinks by default; disable it for tool turns unless the user
    // opted into reasoning, so tool_choice works and flash stays snappy.
    options.thinking = { type: "disabled" }
  } else if (wantsReasoningEffort(settings)) {
    if (provider.id === "openrouter") {
      options.reasoning = { effort: settings.reasoningEffort }
    } else if (provider.id === "openai") {
      options.reasoning_effort = settings.reasoningEffort
    } else if (provider.id === "deepseek") {
      options.thinking = { type: "enabled" }
      const effort = settings.reasoningEffort === "xhigh" ? "max" : settings.reasoningEffort
      if (effort === "high" || effort === "max") options.reasoning_effort = effort
    }
  }
  if (settings.fast && provider.id === "openrouter") {
    options.provider = { sort: "throughput" }
  }
  return options
}

function hasImageBlocks(messages: ChatMessage[]): boolean {
  return messages.some((message) => Array.isArray(message.content)
    && message.content.some((block) => block.type === "image_url"))
}

function unsupportedImageResponse(status: number, body: string): boolean {
  return (status === 400 || status === 422)
    && /(image_url|image input|vision)/i.test(body)
    && /(unknown variant|expected [`"']?text|not support|unsupported|invalid)/i.test(body)
}

function prepareMessages(provider: ResolvedProvider, messages: ChatMessage[], omitImages = provider.id === "deepseek"): ChatMessage[] {
  const prepared = promptCacheDisabled()
    ? stripPromptCacheControl(messages)
    : provider.id === "openrouter"
      ? markLatestUserMessageCacheable(messages)
      : messages
  return prepared.map((message) => {
    const { cacheControl, ...rest } = message
    if (omitImages && Array.isArray(rest.content)) {
      return {
        ...rest,
        content: rest.content.map((block) => block.type === "image_url"
          ? { type: "text" as const, text: "[Image omitted: the current provider or model does not support image input]" }
          : block),
      }
    }
    if (provider.id === "openrouter" && cacheControl === "ephemeral" && typeof message.content === "string") {
      return {
        ...rest,
        content: [{ type: "text" as const, text: message.content, cache_control: { type: "ephemeral" as const } }],
      }
    }
    return rest
  })
}

async function postChatCompletion(
  provider: ResolvedProvider,
  messages: ChatMessage[],
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response> {
  const send = (omitImages = false) => fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    signal,
    headers: buildHeaders(provider),
    body: JSON.stringify({
      ...payload,
      messages: prepareMessages(provider, messages, omitImages || provider.id === "deepseek"),
    }),
  })

  let response = await send()
  if (response.ok) return response

  let body = await response.text().catch(() => "")
  if (provider.id !== "deepseek" && hasImageBlocks(messages) && unsupportedImageResponse(response.status, body)) {
    response = await send(true)
    if (response.ok) return response
    body = await response.text().catch(() => "")
  }
  throw new Error(`Request failed (${response.status}): ${body || response.statusText}`)
}

function promptCacheDisabled(): boolean {
  return process.env.FURNACE_DISABLE_PROMPT_CACHE === "1"
}

function stripPromptCacheControl(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    const { cacheControl: _cacheControl, ...rest } = message
    if (!Array.isArray(rest.content)) return rest
    return {
      ...rest,
      content: rest.content.map((block) => {
        if (block.type !== "text") return block
        const { cache_control: _cache_control, ...textBlock } = block
        return textBlock
      }),
    }
  })
}

function markLatestUserMessageCacheable(messages: ChatMessage[]): ChatMessage[] {
  const index = findLatestTextUserMessageIndex(messages)
  if (index < 0) return messages
  return messages.map((message, messageIndex) => {
    if (messageIndex !== index || message.cacheControl === "ephemeral") return message
    if (typeof message.content === "string") return { ...message, cacheControl: "ephemeral" }
    if (!Array.isArray(message.content)) return message
    const blocks = [...message.content]
    for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = blocks[blockIndex]
      if (block?.type !== "text") continue
      blocks[blockIndex] = { ...block, cache_control: { type: "ephemeral" } }
      return { ...message, content: blocks }
    }
    return message
  })
}

function findLatestTextUserMessageIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message?.role !== "user") continue
    if (typeof message.content === "string" && message.content.trim()) return i
    if (Array.isArray(message.content) && message.content.some((block) => block.type === "text" && block.text.trim())) return i
  }
  return -1
}

function parseChunk(data: string): ChatCompletionChunk {
  try {
    return JSON.parse(data) as ChatCompletionChunk
  } catch {
    throw new Error(`Invalid stream chunk: ${data}`)
  }
}

export function createOpenAICompatibleProvider(): Provider {
  return {
    async *streamChat(
      provider: ResolvedProvider,
      model: string,
      messages: ChatMessage[],
      settings: ModelSettings,
      signal?: AbortSignal,
    ): AsyncGenerator<string> {
      const response = await postChatCompletion(provider, messages, {
        model,
        ...buildRequestOptions(provider, model, settings),
        stream: true,
      }, signal)
      if (!response.body) {
        throw new Error("Request failed: provider returned an empty response body")
      }

      const decoder = new TextDecoder()
      let buffer = ""
      const reader = response.body.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split("\n")
          buffer = lines.pop() || ""
          for (const rawLine of lines) {
            const line = rawLine.trim()
            if (!line || line.startsWith(":") || !line.startsWith("data:")) continue
            const data = line.slice("data:".length).trim()
            if (data === "[DONE]") return
            const parsed = parseChunk(data)
            if (parsed.error?.message) throw new Error(parsed.error.message)
            const content = parsed.choices?.[0]?.delta?.content
            if (content) yield content
          }
        }
      } finally {
        reader.releaseLock()
      }
    },

    async completeChat(
      provider: ResolvedProvider,
      model: string,
      messages: ChatMessage[],
      settings: ModelSettings,
      options: { maxTokens?: number } = {},
    ): Promise<string> {
      const response = await postChatCompletion(provider, messages, {
        model,
        max_tokens: options.maxTokens,
        ...buildRequestOptions(provider, model, settings),
        stream: false,
      })

      const parsed = (await response.json()) as ChatCompletionResponse
      if (parsed.error?.message) throw new Error(parsed.error.message)
      return parsed.choices?.[0]?.message?.content?.trim() || ""
    },

    async completeToolChat(
      provider: ResolvedProvider,
      model: string,
      messages: ChatMessage[],
      tools: ToolDefinition[],
      settings: ModelSettings,
      options: { maxTokens?: number; toolChoice?: ToolChoice; onTextDelta?: (delta: string) => void } = {},
      signal?: AbortSignal,
    ): Promise<AssistantResponse> {
      const payload: Record<string, unknown> = {
        model,
        tools,
        ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
        ...buildRequestOptions(provider, model, settings, true),
        stream: true,
        usage: { include: true },
      }
      // DeepSeek V4 thinking mode rejects tool_choice; omit it when thinking stays on.
      if (!shouldOmitToolChoice(model, settings)) {
        payload.tool_choice = options.toolChoice || "auto"
      }
      const response = await postChatCompletion(provider, messages, payload, signal)
      if (!response.body) {
        throw new Error("Request failed: provider returned an empty response body")
      }

      type PartialToolCall = { id: string; name: string; arguments: string }
      const toolCallsAccum = new Map<number, PartialToolCall>()
      let textContent = ""
      let usageData: Usage | undefined

      const decoder = new TextDecoder()
      let buffer = ""
      const reader = response.body.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split("\n")
          buffer = lines.pop() || ""
          for (const rawLine of lines) {
            const line = rawLine.trim()
            if (!line || line.startsWith(":") || !line.startsWith("data:")) continue
            const data = line.slice("data:".length).trim()
            if (data === "[DONE]") break
            const parsed = parseChunk(data)
            if (parsed.error?.message) throw new Error(parsed.error.message)
            const delta = parsed.choices?.[0]?.delta
            if (parsed.usage?.prompt_tokens !== undefined) {
              usageData = {
                cacheReadTokens: parsed.usage.prompt_tokens_details?.cached_tokens ?? 0,
                completionTokens: parsed.usage.completion_tokens ?? 0,
                costUsd: parseUsageCostUsd(parsed.usage.cost),
                promptTokens: parsed.usage.prompt_tokens ?? 0,
              }
            }
            if (delta?.content) {
              textContent += delta.content
              options.onTextDelta?.(delta.content)
            }
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const index = tc.index ?? 0
                if (!toolCallsAccum.has(index)) {
                  toolCallsAccum.set(index, { id: tc.id || "", name: tc.function?.name || "", arguments: "" })
                }
                const entry = toolCallsAccum.get(index)!
                if (tc.id && !entry.id) entry.id = tc.id
                if (tc.function?.name) entry.name = entry.name || tc.function.name
                entry.arguments += tc.function?.arguments || ""
              }
            }
          }
        }
      } finally {
        reader.releaseLock()
      }

      const toolCalls = [...toolCallsAccum.entries()]
        .sort(([a], [b]) => a - b)
        .flatMap(([, tc]) => {
          if (!tc.id || !tc.name) return []
          return [{ id: tc.id, type: "function" as const, function: { name: tc.name, arguments: tc.arguments } }]
        })

      return { content: textContent.trim(), toolCalls, usage: usageData }
    },

    async listModels(provider: ResolvedProvider): Promise<ModelInfo[]> {
      if (provider.models && provider.models.length > 0) {
        return provider.models.map((m) => ({
          id: m.id,
          name: m.displayName || m.id,
          contextLength: m.contextLength ?? null,
          supportedParameters: [],
        }))
      }

      const response = await fetch(`${provider.baseUrl}/models`, {
        headers: buildHeaders(provider),
      })

      if (!response.ok) {
        const body = await response.text().catch(() => "")
        throw new Error(`Models request failed (${response.status}): ${body || response.statusText}`)
      }

      const parsed = (await response.json()) as ModelsResponse
      if (parsed.error?.message) throw new Error(parsed.error.message)

      return (parsed.data || [])
        .flatMap((model) => {
          if (!model.id) return []
          const pricingRaw = model.pricing
          const pricing = normalizeTokenPricing(pricingRaw
            ? {
                prompt: parseFloat(pricingRaw.prompt ?? "0") || 0,
                completion: parseFloat(pricingRaw.completion ?? "0") || 0,
              }
            : undefined)
          return [{
            id: model.id,
            name: model.name || model.id,
            contextLength: typeof model.context_length === "number" ? model.context_length : null,
            pricing,
            supportedParameters: Array.isArray(model.supported_parameters) ? model.supported_parameters : [],
          }]
        })
        .sort((left, right) => left.id.localeCompare(right.id))
    },
  }
}
