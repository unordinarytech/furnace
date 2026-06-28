import type { OpenRouterMessage } from "../openrouter.js"
import { storeContextArtifact } from "./artifacts.js"
import { compressToolOutput } from "./router.js"

const requestTransformMinBytes = 24 * 1024
const requestTransformMinLines = 800
const requestTransformMaxBytes = 32 * 1024
const requestTransformMaxLines = 800

export type RequestTransformStats = {
  compressedToolResults: number
}

export async function applyHeadroomLiteRequestTransforms(input: { cwd: string; messages: OpenRouterMessage[] }): Promise<{ messages: OpenRouterMessage[]; stats: RequestTransformStats }> {
  let compressedToolResults = 0
  const messages: OpenRouterMessage[] = []

  for (const message of input.messages) {
    if (message.role !== "tool" || typeof message.content !== "string" || !shouldCompressToolMessage(message.content)) {
      messages.push(message)
      continue
    }

    const artifact = await storeContextArtifact({ content: message.content, cwd: input.cwd, label: "request-tool-result" })
    const compressed = compressToolOutput({
      artifact,
      content: message.content,
      maxBytes: requestTransformMaxBytes,
      maxLines: requestTransformMaxLines,
    })
    compressedToolResults += 1
    messages.push({ ...message, content: compressed.content })
  }

  return { messages, stats: { compressedToolResults } }
}

function shouldCompressToolMessage(content: string): boolean {
  if (content.includes("Tool output compressed (Headroom-lite).")) return false
  return Buffer.byteLength(content, "utf8") > requestTransformMinBytes || content.split(/\r?\n/).length > requestTransformMinLines
}
