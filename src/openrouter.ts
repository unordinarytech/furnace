import type { FurnaceConfig } from "./config.js"

export type OpenRouterMessage = {
  role: "system" | "user" | "assistant" | "tool"
  content: string | OpenRouterContentBlock[] | null
  name?: string
  tool_call_id?: string
  tool_calls?: OpenRouterToolCall[]
}

export type OpenRouterContentBlock =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }

export type OpenRouterToolDefinition = {
  type: "function"
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export type OpenRouterToolCall = {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export type OpenRouterAssistantResponse = {
  content: string
  toolCalls: OpenRouterToolCall[]
  usage?: OpenRouterUsage
}

export type OpenRouterToolChoice =
  | "auto"
  | {
      type: "function"
      function: {
        name: string
      }
    }

export type OpenRouterModelPricing = {
  completion: number
  prompt: number
}

export type OpenRouterModel = {
  id: string
  name: string
  contextLength: number | null
  pricing?: OpenRouterModelPricing
  supportedParameters: string[]
}

export type OpenRouterUsage = {
  completionTokens: number
  promptTokens: number
}

type ModelsResponse = {
  data?: Array<{
    id?: string
    name?: string
    context_length?: number
    pricing?: { prompt?: string; completion?: string }
    supported_parameters?: string[]
  }>
  error?: {
    message?: string
  }
}

type ChatCompletionChunk = {
  choices?: Array<{
    delta?: {
      content?: string
      tool_calls?: Array<{
        index?: number
        id?: string
        type?: string
        function?: {
          name?: string
          arguments?: string
        }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
  }
  error?: {
    message?: string
  }
}

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string
      tool_calls?: OpenRouterToolCall[]
    }
  }>
  error?: {
    message?: string
  }
}

export async function* streamOpenRouterResponse(
  config: FurnaceConfig,
  messages: OpenRouterMessage[],
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${config.openRouterApiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": config.siteUrl,
      "X-Title": config.appName,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      ...requestOptions(config),
      stream: true,
    }),
  })

  if (!response.ok || !response.body) {
    const body = await response.text().catch(() => "")
    throw new Error(`OpenRouter request failed (${response.status}): ${body || response.statusText}`)
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

        if (!line || line.startsWith(":")) continue
        if (!line.startsWith("data:")) continue

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
}

export async function completeOpenRouterResponse(
  config: FurnaceConfig,
  messages: OpenRouterMessage[],
  options: { model?: string; maxTokens?: number } = {},
): Promise<string> {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openRouterApiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": config.siteUrl,
      "X-Title": config.appName,
    },
    body: JSON.stringify({
      model: options.model || config.model,
      messages,
      max_tokens: options.maxTokens,
      ...(options.model ? {} : requestOptions(config)),
      stream: false,
    }),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(`OpenRouter request failed (${response.status}): ${body || response.statusText}`)
  }

  const parsed = (await response.json()) as ChatCompletionResponse
  if (parsed.error?.message) throw new Error(parsed.error.message)

  return parsed.choices?.[0]?.message?.content?.trim() || ""
}

export async function completeOpenRouterToolResponse(
  config: FurnaceConfig,
  messages: OpenRouterMessage[],
  tools: OpenRouterToolDefinition[],
  options: { toolChoice?: OpenRouterToolChoice; onTextDelta?: (delta: string) => void } = {},
  signal?: AbortSignal,
): Promise<OpenRouterAssistantResponse> {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${config.openRouterApiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": config.siteUrl,
      "X-Title": config.appName,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      tools,
      tool_choice: options.toolChoice || "auto",
      ...requestOptions(config),
      stream: true,
      usage: { include: true },
    }),
  })

  if (!response.ok || !response.body) {
    const body = await Promise.resolve().then(() => (response as unknown as { text?: () => Promise<string> }).text?.()).catch(() => "") ?? ""
    throw new Error(`OpenRouter request failed (${response.status}): ${body || response.statusText}`)
  }

  type PartialToolCall = { id: string; name: string; arguments: string }
  const toolCallsAccum = new Map<number, PartialToolCall>()
  let textContent = ""
  let usageData: OpenRouterUsage | undefined

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
          usageData = { promptTokens: parsed.usage.prompt_tokens ?? 0, completionTokens: parsed.usage.completion_tokens ?? 0 }
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
}

export async function listOpenRouterModels(config: FurnaceConfig): Promise<OpenRouterModel[]> {
  const response = await fetch("https://openrouter.ai/api/v1/models", {
    headers: {
      Authorization: `Bearer ${config.openRouterApiKey}`,
      "HTTP-Referer": config.siteUrl,
      "X-Title": config.appName,
    },
  })

  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(`OpenRouter models request failed (${response.status}): ${body || response.statusText}`)
  }

  const parsed = (await response.json()) as ModelsResponse
  if (parsed.error?.message) throw new Error(parsed.error.message)

  return (parsed.data || [])
    .flatMap((model) => {
      if (!model.id) return []
      const pricingRaw = model.pricing
      const pricing = pricingRaw
        ? {
            prompt: parseFloat(pricingRaw.prompt ?? "0") || 0,
            completion: parseFloat(pricingRaw.completion ?? "0") || 0,
          }
        : undefined
      return [
        {
          id: model.id,
          name: model.name || model.id,
          contextLength: typeof model.context_length === "number" ? model.context_length : null,
          pricing,
          supportedParameters: Array.isArray(model.supported_parameters) ? model.supported_parameters : [],
        },
      ]
    })
    .sort((left, right) => left.id.localeCompare(right.id))
}

export function isContextOverflowError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /\b(context|token|tokens|input)\b.*\b(length|limit|window|maximum|too large|too long|exceed)/i.test(message)
    || /\b(maximum context|context_length|context window|too many tokens|input is too long|prompt is too long)\b/i.test(message)
}

function requestOptions(config: FurnaceConfig): Record<string, unknown> {
  const options: Record<string, unknown> = {}
  if (config.modelSettings.reasoningEffort && config.modelSettings.reasoningEffort !== "none") {
    options.reasoning = { effort: config.modelSettings.reasoningEffort }
  }
  if (config.modelSettings.fast) {
    options.provider = { sort: "throughput" }
  }
  return options
}

function parseChunk(data: string): ChatCompletionChunk {
  try {
    return JSON.parse(data) as ChatCompletionChunk
  } catch {
    throw new Error(`OpenRouter returned an invalid stream chunk: ${data}`)
  }
}
