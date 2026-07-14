import type { FurnaceConfig } from "../config.js"
import { completeOpenRouterToolResponse, isContextOverflowError, type OpenRouterMessage, type OpenRouterToolChoice, type OpenRouterUsage } from "../openrouter.js"
import { createToolPermissionRequest, type PermissionPrompt, type SessionPermissionStore } from "../permissions.js"
import { defaultMaxOutputTokens } from "../preferences.js"
import type { AskQuestionPrompt } from "../questions.js"
import type { TaskRunner } from "../tasks/types.js"
import { executeToolCall, toolDefinitions, type ToolExecution, type ToolFileReadStore, type ToolTodoStore } from "../tools/registry.js"

export type RunAgentTurnInput = {
  config: FurnaceConfig
  cwd: string
  fileReadStore?: ToolFileReadStore
  messages: OpenRouterMessage[]
  onPermissionRequest?: PermissionPrompt
  onQuestionRequest?: AskQuestionPrompt
  sessionId?: string
  signal?: AbortSignal
  taskRunner?: TaskRunner
  todoStore?: ToolTodoStore
  tools?: typeof toolDefinitions
  permissions?: SessionPermissionStore
  onBeforeModelRequest?: (messages: OpenRouterMessage[], tools: typeof toolDefinitions) => Promise<OpenRouterMessage[]>
  onContextOverflow?: (messages: OpenRouterMessage[], tools: typeof toolDefinitions) => Promise<OpenRouterMessage[] | undefined>
  onTextDelta?: (delta: string) => void
  onToolStart?: (call: { arguments: string; id: string; name: string }) => void
  onToolResult?: (call: { arguments: string; id: string; name: string }, content: string, execution: ToolExecution) => void
}

export type RunAgentTurnResult = {
  backgrounded?: boolean
  content: string
  usage?: OpenRouterUsage
}

export async function runAgentTurn(input: RunAgentTurnInput): Promise<RunAgentTurnResult> {
  let messages = [...input.messages]
  const tools = input.tools || toolDefinitions
  let iteration = 0
  let overflowRecoveryAttempted = false
  let accumulatedCacheReadTokens = 0
  let accumulatedCacheWriteTokens = 0
  let accumulatedCostUsd = 0
  let hasActualCostUsd = false
  let accumulatedPromptTokens = 0
  let lastCompletionTokens = 0
  const maxTokens = configuredMaxOutputTokens(input.config.modelSettings.maxOutputTokens)

  while (true) {
    messages = input.onBeforeModelRequest ? await input.onBeforeModelRequest(messages, tools) : messages
    const toolChoice: OpenRouterToolChoice = iteration === 0 && shouldForceWebSearch(messages) ? { type: "function", function: { name: "websearch" } } : "auto"
    iteration += 1
    if (input.signal?.aborted) throw abortError()
    let response
    try {
      response = await completeOpenRouterToolResponse(input.config, messages, tools, { maxTokens, toolChoice, onTextDelta: input.onTextDelta }, input.signal)
    } catch (error) {
      if (!overflowRecoveryAttempted && input.onContextOverflow && isContextOverflowError(error)) {
        overflowRecoveryAttempted = true
        const recoveredMessages = await input.onContextOverflow(messages, tools)
        if (recoveredMessages) {
          messages = recoveredMessages
          iteration -= 1
          continue
        }
      }
      throw error
    }

    if (response.usage) {
      accumulatedCacheReadTokens += response.usage.cacheReadTokens ?? 0
      accumulatedCacheWriteTokens += response.usage.cacheWriteTokens ?? 0
      if (typeof response.usage.costUsd === "number") {
        accumulatedCostUsd += response.usage.costUsd
        hasActualCostUsd = true
      }
      accumulatedPromptTokens += response.usage.promptTokens
      lastCompletionTokens = response.usage.completionTokens
    }
    if (response.toolCalls.length === 0) {
      const usage = hasUsage(accumulatedPromptTokens, lastCompletionTokens, accumulatedCacheReadTokens, accumulatedCacheWriteTokens)
        ? {
          cacheReadTokens: accumulatedCacheReadTokens,
          cacheWriteTokens: accumulatedCacheWriteTokens,
          costUsd: hasActualCostUsd ? accumulatedCostUsd : undefined,
          promptTokens: accumulatedPromptTokens,
          completionTokens: lastCompletionTokens,
        }
        : undefined
      return { content: response.content, usage }
    }

    messages.push({
      role: "assistant",
      content: response.content || null,
      tool_calls: response.toolCalls,
    })

    for (const toolCall of response.toolCalls) {
      const call = {
        arguments: toolCall.function.arguments,
        id: toolCall.id,
        name: toolCall.function.name,
      }
      input.onToolStart?.(call)
      const permissionRequest = createToolPermissionRequest({
        args: call.arguments,
        callId: call.id,
        cwd: input.cwd,
        sessionId: input.sessionId,
        toolName: call.name,
      })
      const permissionDecision = await input.permissions?.authorize(permissionRequest, input.onPermissionRequest)
      if (permissionDecision === "deny") {
        const denied: ToolExecution = {
          content: `Tool ${call.name} denied: user denied permission for this specific tool call.`,
          name: call.name,
          status: "error",
        }
        input.onToolResult?.(call, denied.content, denied)
        messages.push({
          role: "tool",
          name: call.name,
          tool_call_id: toolCall.id,
          content: denied.content,
        })
        continue
      }
      if (input.signal?.aborted) throw abortError()
      const result = await executeToolCall(
        {
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        },
        { cwd: input.cwd, fileReadStore: input.fileReadStore, questionPrompt: input.onQuestionRequest, sessionId: input.sessionId, signal: input.signal, skillPaths: input.config.skillPaths, taskRunner: input.taskRunner, todoStore: input.todoStore },
      )
      input.onToolResult?.(call, result.content, result)
      if (result.control?.backgrounded) {
        const usage = hasUsage(accumulatedPromptTokens, lastCompletionTokens, accumulatedCacheReadTokens, accumulatedCacheWriteTokens)
          ? {
            cacheReadTokens: accumulatedCacheReadTokens,
            cacheWriteTokens: accumulatedCacheWriteTokens,
            costUsd: hasActualCostUsd ? accumulatedCostUsd : undefined,
            promptTokens: accumulatedPromptTokens,
            completionTokens: lastCompletionTokens,
          }
          : undefined
        return { backgrounded: true, content: "Subagents are running in the background. I'll continue when they finish.", usage }
      }
      messages.push({
        role: "tool",
        name: result.name,
        tool_call_id: toolCall.id,
        content: result.content,
      })
    }
  }
}

function configuredMaxOutputTokens(configured: number | undefined): number {
  const raw = process.env.FURNACE_MAX_OUTPUT_TOKENS
  if (!raw) return validMaxOutputTokens(configured) ?? defaultMaxOutputTokens
  const value = Number(raw)
  return validMaxOutputTokens(value) ?? validMaxOutputTokens(configured) ?? defaultMaxOutputTokens
}

function validMaxOutputTokens(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined
}

function abortError(): DOMException {
  return new DOMException("The current turn was interrupted.", "AbortError")
}

export function shouldForceWebSearch(messages: OpenRouterMessage[]): boolean {
  const latestUserMessage = [...messages].reverse().find((message) => message.role === "user" && !messageContainsRuntimeContext(message))
  const contentText = latestUserMessage
    ? typeof latestUserMessage.content === "string"
      ? latestUserMessage.content
      : Array.isArray(latestUserMessage.content)
        ? latestUserMessage.content.find((block) => block.type === "text")?.text || ""
        : ""
    : ""
  const asksForCurrentInfo = /\b(latest|current|currently|today|right now|recent|newest|news|up[- ]?to[- ]?date|release|version)\b/i.test(contentText)
  if (!asksForCurrentInfo) return false

  const isLocalQuestion = /\b(this repo|this repository|codebase|workspace|working tree|git status|branch|commit|diff|file|folder|directory)\b/i.test(contentText)
  return !isLocalQuestion
}

function hasUsage(promptTokens: number, completionTokens: number, cacheReadTokens: number, cacheWriteTokens: number): boolean {
  return promptTokens > 0 || completionTokens > 0 || cacheReadTokens > 0 || cacheWriteTokens > 0
}

function messageContainsRuntimeContext(message: OpenRouterMessage): boolean {
  return typeof message.content === "string" && message.content.includes("<runtime_context>")
}
