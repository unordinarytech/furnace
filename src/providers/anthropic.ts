import type {
  Provider,
  ResolvedProvider,
  ChatMessage,
  ToolDefinition,
  ToolChoice,
  ModelInfo,
  AssistantResponse,
  Usage,
  ContentBlock,
  ChatToolCall,
} from "./types.js"
import type { ModelSettings } from "../preferences.js"

// Anthropic message format (internal to this adapter)
type AnthropicContent =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }

type AnthropicMessage = {
  role: "user" | "assistant"
  content: string | AnthropicContent[]
}

type AnthropicTool = {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

type AnthropicToolUse = {
  id: string
  name: string
  input: Record<string, unknown>
}

// SSE event types from Anthropic streaming
type AnthropicEvent =
  | { type: "message_start"; message: { usage?: { input_tokens?: number; output_tokens?: number } } }
  | { type: "content_block_start"; index: number; content_block: { type: "text" | "tool_use"; id?: string; name?: string } }
  | { type: "content_block_delta"; index: number; delta: { type: "text_delta"; text: string } | { type: "input_json_delta"; partial_json: string } }
  | { type: "content_block_stop"; index: number }
  | { type: "message_delta"; delta: { stop_reason?: string }; usage?: { output_tokens?: number } }
  | { type: "message_stop" }

type AnthropicModelsResponse = {
  data?: Array<{
    id?: string
    display_name?: string
    context_window?: number
  }>
  error?: { message?: string }
}

function buildHeaders(provider: ResolvedProvider): Record<string, string> {
  return {
    "x-api-key": provider.apiKey,
    "anthropic-version": "2023-06-01",
    "Content-Type": "application/json",
  }
}

function buildBody(
  model: string,
  messages: ChatMessage[],
  settings: ModelSettings,
  options: { maxTokens?: number; tools?: AnthropicTool[]; toolChoice?: ToolChoice; stream?: boolean },
): Record<string, unknown> {
  const { systemMessages, converted } = convertMessages(messages)

  const body: Record<string, unknown> = {
    model,
    messages: converted,
    max_tokens: options.maxTokens ?? 4096,
  }

  if (systemMessages.length > 0) {
    body.system = systemMessages.join("\n\n")
  }

  if (settings.reasoningEffort && settings.reasoningEffort !== "none") {
    const budgetMap: Record<string, number> = { low: 5000, medium: 10000, high: 20000, xhigh: 32000 }
    const budget = budgetMap[settings.reasoningEffort] ?? 10000
    body.thinking = { type: "enabled", budget_tokens: budget }
  }

  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools
    if (options.toolChoice) {
      if (options.toolChoice === "auto") {
        body.tool_choice = { type: "auto" }
      } else {
        body.tool_choice = { type: "tool", name: options.toolChoice.function.name }
      }
    }
  }

  if (options.stream !== undefined) {
    body.stream = options.stream
  }

  return body
}

function convertMessages(messages: ChatMessage[]): {
  systemMessages: string[]
  converted: AnthropicMessage[]
} {
  const systemMessages: string[] = []
  const converted: AnthropicMessage[] = []

  for (const msg of messages) {
    if (msg.role === "system") {
      if (typeof msg.content === "string") {
        systemMessages.push(msg.content)
      }
      continue
    }

    if (msg.role === "tool") {
      // OpenAI tool result → Anthropic user message with tool_result content block
      const text = typeof msg.content === "string" ? msg.content : ""
      converted.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: msg.tool_call_id || "", content: text } as unknown as AnthropicContent],
      })
      continue
    }

    if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
      // OpenAI assistant with tool_calls → Anthropic assistant with tool_use blocks
      const content: unknown[] = []
      if (typeof msg.content === "string" && msg.content) {
        content.push({ type: "text", text: msg.content })
      }
      for (const tc of msg.tool_calls) {
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: safeParseJson(tc.function.arguments),
        })
      }
      converted.push({ role: "assistant", content: content as AnthropicContent[] })
      continue
    }

    // Regular user/assistant message
    const role = msg.role as "user" | "assistant"
    if (Array.isArray(msg.content)) {
      const anthropicContent = msg.content.map(convertContentBlock)
      converted.push({ role, content: anthropicContent })
    } else {
      converted.push({ role, content: msg.content || "" })
    }
  }

  return { systemMessages, converted }
}

function convertContentBlock(block: ContentBlock): AnthropicContent {
  if (block.type === "text") {
    return { type: "text", text: block.text }
  }
  // image_url → Anthropic image format
  const url = block.image_url.url
  if (url.startsWith("data:")) {
    const match = url.match(/^data:(image\/\w+);base64,(.+)$/)
    if (match) {
      return { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } }
    }
  }
  // Fallback: skip unsupported images
  return { type: "text", text: "[unsupported image]" }
}

function safeParseJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}

function parseEvent(data: string): AnthropicEvent | undefined {
  try {
    return JSON.parse(data) as AnthropicEvent
  } catch {
    return undefined
  }
}

export function createAnthropicProvider(): Provider {
  return {
    async *streamChat(
      provider: ResolvedProvider,
      model: string,
      messages: ChatMessage[],
      settings: ModelSettings,
      signal?: AbortSignal,
    ): AsyncGenerator<string> {
      const body = buildBody(model, messages, settings, { stream: true })
      const response = await fetch(`${provider.baseUrl}/v1/messages`, {
        method: "POST",
        signal,
        headers: buildHeaders(provider),
        body: JSON.stringify(body),
      })

      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => "")
        throw new Error(`Anthropic request failed (${response.status}): ${text || response.statusText}`)
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
            const event = parseEvent(data)
            if (!event) continue
            if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
              yield event.delta.text
            }
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
      const body = buildBody(model, messages, settings, { maxTokens: options.maxTokens, stream: false })
      const response = await fetch(`${provider.baseUrl}/v1/messages`, {
        method: "POST",
        headers: buildHeaders(provider),
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        const text = await response.text().catch(() => "")
        throw new Error(`Anthropic request failed (${response.status}): ${text || response.statusText}`)
      }

      const parsed = (await response.json()) as { content?: Array<{ type: string; text?: string }>; error?: { message?: string } }
      if (parsed.error?.message) throw new Error(parsed.error.message)
      const textBlock = parsed.content?.find((b) => b.type === "text")
      return textBlock?.text?.trim() || ""
    },

    async completeToolChat(
      provider: ResolvedProvider,
      model: string,
      messages: ChatMessage[],
      tools: ToolDefinition[],
      settings: ModelSettings,
      options: { toolChoice?: ToolChoice; onTextDelta?: (delta: string) => void } = {},
      signal?: AbortSignal,
    ): Promise<AssistantResponse> {
      const anthropicTools: AnthropicTool[] = tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }))

      const body = buildBody(model, messages, settings, {
        tools: anthropicTools,
        toolChoice: options.toolChoice,
        stream: true,
      })

      const response = await fetch(`${provider.baseUrl}/v1/messages`, {
        method: "POST",
        signal,
        headers: buildHeaders(provider),
        body: JSON.stringify(body),
      })

      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => "")
        throw new Error(`Anthropic request failed (${response.status}): ${text || response.statusText}`)
      }

      let textContent = ""
      let usageData: Usage | undefined
      const toolUses: Map<number, { id: string; name: string; args: string }> = new Map()

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
            const event = parseEvent(data)
            if (!event) continue

            if (event.type === "message_start" && event.message?.usage) {
              usageData = {
                promptTokens: event.message.usage.input_tokens ?? 0,
                completionTokens: event.message.usage.output_tokens ?? 0,
              }
            }

            if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
              toolUses.set(event.index, {
                id: event.content_block.id || "",
                name: event.content_block.name || "",
                args: "",
              })
            }

            if (event.type === "content_block_delta") {
              if (event.delta.type === "text_delta") {
                textContent += event.delta.text
                options.onTextDelta?.(event.delta.text)
              } else if (event.delta.type === "input_json_delta") {
                const entry = toolUses.get(event.index)
                if (entry) entry.args += event.delta.partial_json
              }
            }

            if (event.type === "message_delta" && event.usage?.output_tokens !== undefined) {
              usageData = {
                promptTokens: usageData?.promptTokens ?? 0,
                completionTokens: event.usage.output_tokens,
              }
            }
          }
        }
      } finally {
        reader.releaseLock()
      }

      const toolCalls: ChatToolCall[] = [...toolUses.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, tu]) => ({
          id: tu.id,
          type: "function" as const,
          function: { name: tu.name, arguments: tu.args || "{}" },
        }))

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

      const response = await fetch(`${provider.baseUrl}/v1/models`, {
        headers: buildHeaders(provider),
      })

      if (!response.ok) {
        const text = await response.text().catch(() => "")
        throw new Error(`Anthropic models request failed (${response.status}): ${text || response.statusText}`)
      }

      const parsed = (await response.json()) as AnthropicModelsResponse
      if (parsed.error?.message) throw new Error(parsed.error.message)

      return (parsed.data || [])
        .flatMap((model) => {
          if (!model.id) return []
          return [{
            id: model.id,
            name: model.display_name || model.id,
            contextLength: typeof model.context_window === "number" ? model.context_window : null,
            supportedParameters: [],
          }]
        })
        .sort((a, b) => a.id.localeCompare(b.id))
    },
  }
}
