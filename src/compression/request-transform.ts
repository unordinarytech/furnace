import type { OpenRouterMessage } from "../openrouter.js"
import { storeContextArtifact } from "./artifacts.js"
import { compressToolOutput } from "./router.js"

const requestTransformMinBytes = 24 * 1024
const requestTransformMinLines = 800
const requestTransformMaxBytes = 32 * 1024
const requestTransformMaxLines = 800
const readMaturationQuietMessages = 6
const readMaturationMinBytes = 8 * 1024
const readMaturationMinLines = 240
const readMaturationPreviewLines = 24

export type RequestTransformStats = {
  compressedToolResults: number
  maturedReadResults: number
}

export async function applyHeadroomLiteRequestTransforms(input: { cwd: string; messages: OpenRouterMessage[] }): Promise<{ messages: OpenRouterMessage[]; stats: RequestTransformStats }> {
  let compressedToolResults = 0
  let maturedReadResults = 0
  const messages: OpenRouterMessage[] = []
  const toolCalls = collectToolCalls(input.messages)
  const lastActivityByPath = collectLastFileActivity(input.messages, toolCalls)

  for (const [index, message] of input.messages.entries()) {
    const readMaturation = await matureReadResultIfQuiet({
      content: message.content,
      cwd: input.cwd,
      index,
      lastActivityByPath,
      message,
      totalMessages: input.messages.length,
      toolCalls,
    })
    if (readMaturation) {
      maturedReadResults += 1
      messages.push({ ...message, content: readMaturation })
      continue
    }

    if (message.role !== "tool" || typeof message.content !== "string" || !shouldCompressToolMessage(message.content)) {
      messages.push(message)
      continue
    }

    const artifact = await storeContextArtifact({ content: message.content, cwd: input.cwd })
    const compressed = compressToolOutput({
      artifact,
      content: message.content,
      maxBytes: requestTransformMaxBytes,
      maxLines: requestTransformMaxLines,
    })
    compressedToolResults += 1
    messages.push({ ...message, content: compressed.content })
  }

  return { messages, stats: { compressedToolResults, maturedReadResults } }
}

function shouldCompressToolMessage(content: string): boolean {
  if (content.includes("Tool output compressed (Headroom-lite).")) return false
  if (content.includes("Read result matured (Headroom-lite).")) return false
  return Buffer.byteLength(content, "utf8") > requestTransformMinBytes || content.split(/\r?\n/).length > requestTransformMinLines
}

type ToolCallMeta = {
  filePath?: string
  name: string
}

function collectToolCalls(messages: OpenRouterMessage[]): Map<string, ToolCallMeta> {
  const calls = new Map<string, ToolCallMeta>()
  for (const message of messages) {
    if (message.role !== "assistant" || !message.tool_calls) continue
    for (const call of message.tool_calls) {
      calls.set(call.id, {
        filePath: filePathFromToolCall(call.function.name, call.function.arguments),
        name: call.function.name,
      })
    }
  }
  return calls
}

function collectLastFileActivity(messages: OpenRouterMessage[], toolCalls: Map<string, ToolCallMeta>): Map<string, number> {
  const lastActivity = new Map<string, number>()
  for (const [index, message] of messages.entries()) {
    if (message.role !== "assistant" || !message.tool_calls) continue
    for (const call of message.tool_calls) {
      const meta = toolCalls.get(call.id)
      if (!meta?.filePath || !isFileActivityTool(meta.name)) continue
      lastActivity.set(meta.filePath, index)
    }
  }
  return lastActivity
}

async function matureReadResultIfQuiet(input: {
  content: OpenRouterMessage["content"]
  cwd: string
  index: number
  lastActivityByPath: Map<string, number>
  message: OpenRouterMessage
  totalMessages: number
  toolCalls: Map<string, ToolCallMeta>
}): Promise<string | undefined> {
  if (input.message.role !== "tool" || typeof input.content !== "string") return undefined
  if (input.content.includes("Read result matured (Headroom-lite).")) return undefined
  const meta = input.message.tool_call_id ? input.toolCalls.get(input.message.tool_call_id) : undefined
  if (meta?.name !== "read" || !meta.filePath) return undefined
  if (!shouldMatureReadContent(input.content)) return undefined

  const lastActivity = input.lastActivityByPath.get(meta.filePath) ?? input.index
  const quietMessages = input.totalMessages - Math.max(input.index, lastActivity) - 1
  if (quietMessages < readMaturationQuietMessages) return undefined

  const artifact = await storeContextArtifact({ content: input.content, cwd: input.cwd })
  const byteLength = Buffer.byteLength(input.content, "utf8")
  const lines = input.content.split(/\r?\n/)
  const preview = renderReadPreview(lines)
  return [
    "Read result matured (Headroom-lite).",
    `Path: ${meta.filePath}`,
    `Full read artifact: ${artifact.id}`,
    `Original size: ${byteLength.toLocaleString()} bytes, ${lines.length.toLocaleString()} lines`,
    "The full read was omitted from this request because the file has been quiet for several turns.",
    `Retrieve it with context_retrieve({"id":"${artifact.id}"}) or read the file again if current contents matter.`,
    "",
    preview,
  ].join("\n")
}

function shouldMatureReadContent(content: string): boolean {
  const byteLength = Buffer.byteLength(content, "utf8")
  const lines = content.split(/\r?\n/).length
  return byteLength > readMaturationMinBytes || lines > readMaturationMinLines
}

function renderReadPreview(lines: string[]): string {
  if (lines.length <= readMaturationPreviewLines * 2) {
    return ["Preview:", ...lines].join("\n")
  }
  return [
    `Preview: first ${readMaturationPreviewLines} lines and last ${readMaturationPreviewLines} lines`,
    ...lines.slice(0, readMaturationPreviewLines),
    `... ${lines.length - readMaturationPreviewLines * 2} lines omitted from matured read preview ...`,
    ...lines.slice(-readMaturationPreviewLines),
  ].join("\n")
}

function filePathFromToolCall(name: string, rawArguments: string): string | undefined {
  if (!isFileActivityTool(name)) return undefined
  try {
    const parsed = JSON.parse(rawArguments) as Record<string, unknown>
    const path = parsed.path ?? parsed.file ?? parsed.target
    return typeof path === "string" && path.trim() ? path.trim() : undefined
  } catch {
    return undefined
  }
}

function isFileActivityTool(name: string): boolean {
  return name === "read" || name === "write" || name === "edit"
}
