import type { FurnaceConfig } from "../config.js"
import { completeOpenRouterToolResponse, type OpenRouterMessage, type OpenRouterToolChoice } from "../openrouter.js"
import { createToolPermissionRequest, type PermissionPrompt, type SessionPermissionStore } from "../permissions.js"
import type { AskQuestionPrompt } from "../questions.js"
import type { TaskRunner } from "../tasks/types.js"
import { executeToolCall, toolDefinitions, type ToolFileReadStore } from "../tools/registry.js"

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
  tools?: typeof toolDefinitions
  permissions?: SessionPermissionStore
  onToolStart?: (call: { arguments: string; id: string; name: string }) => void
  onToolResult?: (call: { arguments: string; id: string; name: string }, content: string) => void
}

export type RunAgentTurnResult = {
  content: string
}

export async function runAgentTurn(input: RunAgentTurnInput): Promise<RunAgentTurnResult> {
  const messages = [...input.messages]
  let iteration = 0

  while (true) {
    const toolChoice: OpenRouterToolChoice = iteration === 0 && shouldForceWebSearch(messages) ? { type: "function", function: { name: "websearch" } } : "auto"
    iteration += 1
    if (input.signal?.aborted) throw abortError()
    const response = await completeOpenRouterToolResponse(input.config, messages, input.tools || toolDefinitions, { toolChoice }, input.signal)

    if (response.toolCalls.length === 0) {
      return { content: response.content }
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
        const content = `Tool ${call.name} denied: user denied permission for this specific tool call.`
        input.onToolResult?.(call, content)
        messages.push({
          role: "tool",
          name: call.name,
          tool_call_id: toolCall.id,
          content,
        })
        continue
      }
      if (input.signal?.aborted) throw abortError()
      const result = await executeToolCall(
        {
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        },
        { cwd: input.cwd, fileReadStore: input.fileReadStore, questionPrompt: input.onQuestionRequest, sessionId: input.sessionId, signal: input.signal, taskRunner: input.taskRunner },
      )
      input.onToolResult?.(call, result.content)
      messages.push({
        role: "tool",
        name: result.name,
        tool_call_id: toolCall.id,
        content: result.content,
      })
    }
  }
}

function abortError(): DOMException {
  return new DOMException("The current turn was interrupted.", "AbortError")
}

export function shouldForceWebSearch(messages: OpenRouterMessage[]): boolean {
  const latestUserMessage = [...messages].reverse().find((message) => message.role === "user" && typeof message.content === "string")?.content || ""
  const asksForCurrentInfo = /\b(latest|current|currently|today|right now|recent|newest|news|up[- ]?to[- ]?date|release|version)\b/i.test(latestUserMessage)
  if (!asksForCurrentInfo) return false

  // Keep local development questions on filesystem/git tools.
  const isLocalQuestion = /\b(this repo|this repository|codebase|workspace|working tree|git status|branch|commit|diff|file|folder|directory)\b/i.test(latestUserMessage)
  return !isLocalQuestion
}
