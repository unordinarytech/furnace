import type { FurnaceConfig } from "../config.js"
import { completeOpenRouterToolResponse, type OpenRouterMessage, type OpenRouterToolChoice } from "../openrouter.js"
import { executeToolCall, toolDefinitions, type ToolFileReadStore } from "../tools/registry.js"

export type RunAgentTurnInput = {
  config: FurnaceConfig
  cwd: string
  fileReadStore?: ToolFileReadStore
  messages: OpenRouterMessage[]
  sessionId?: string
  onToolStart?: (call: { arguments: string; id: string; name: string }) => void
  onToolResult?: (call: { arguments: string; id: string; name: string }, content: string) => void
}

export type RunAgentTurnResult = {
  content: string
}

const maxToolIterations = 8

export async function runAgentTurn(input: RunAgentTurnInput): Promise<RunAgentTurnResult> {
  const messages = [...input.messages]

  for (let iteration = 0; iteration < maxToolIterations; iteration += 1) {
    const toolChoice: OpenRouterToolChoice = iteration === 0 && shouldForceWebSearch(messages) ? { type: "function", function: { name: "websearch" } } : "auto"
    const response = await completeOpenRouterToolResponse(input.config, messages, toolDefinitions, { toolChoice })

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
      const result = await executeToolCall(
        {
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        },
        { cwd: input.cwd, fileReadStore: input.fileReadStore, sessionId: input.sessionId },
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

  return {
    content: `Stopped after ${maxToolIterations} tool iterations. Please narrow the task or continue from the current state.`,
  }
}

export function shouldForceWebSearch(messages: OpenRouterMessage[]): boolean {
  const latestUserMessage = [...messages].reverse().find((message) => message.role === "user" && typeof message.content === "string")?.content || ""
  const asksForCurrentInfo = /\b(latest|current|currently|today|right now|recent|newest|news|up[- ]?to[- ]?date|release|version)\b/i.test(latestUserMessage)
  if (!asksForCurrentInfo) return false

  // Keep local development questions on filesystem/git tools.
  const isLocalQuestion = /\b(this repo|this repository|codebase|workspace|working tree|git status|branch|commit|diff|file|folder|directory)\b/i.test(latestUserMessage)
  return !isLocalQuestion
}
