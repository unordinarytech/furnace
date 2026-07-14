import type { ContentBlock, OpenRouterMessage } from "../openrouter.js"
import type { CompactionEntryData, EntryRecord, MessageEntryData, ToolCallEntryData, ToolResultEntryData, TranscriptMessage } from "./types.js"

export type RuntimeContextInput = {
  cwd: string
  now?: Date
}

export function entriesToTranscript(entries: EntryRecord[]): TranscriptMessage[] {
  const transcript: TranscriptMessage[] = []
  const pendingToolCalls = new Map<string, TranscriptMessage>()
  for (const entry of entries) {
    if (entry.type === "tool_call") {
      const data = entry.data as ToolCallEntryData
      const item: TranscriptMessage = {
        role: "assistant",
        content: "",
        toolCall: { args: data.arguments, name: data.name, toolCallId: data.toolCallId },
      }
      pendingToolCalls.set(data.toolCallId, item)
      transcript.push(item)
      continue
    }
    if (entry.type === "tool_result") {
      const data = entry.data as ToolResultEntryData
      const item = pendingToolCalls.get(data.toolCallId)
      if (item?.toolCall) {
        item.toolCall.result = data.content
        item.toolCall.isError = data.status ? data.status === "error" : legacyToolResultIsError(data.content)
        pendingToolCalls.delete(data.toolCallId)
      }
      continue
    }
    if (entry.type !== "message") continue
    if (entry.role !== "user" && entry.role !== "assistant") continue

    const data = entry.data as MessageEntryData
    if (data.hidden) continue
    const imageCount = data.images?.length || 0
    transcript.push({ role: entry.role, content: data.content, imageCount })
  }
  return transcript
}

function legacyToolResultIsError(content: string): boolean {
  return content.startsWith("Error")
    || /^Tool \S+ (failed|denied):/.test(content)
}

export function entriesToModelMessages(systemPrompt: string, entries: EntryRecord[], runtimeContext?: RuntimeContextInput): OpenRouterMessage[] {
  const projectedMessages = projectEntriesForModel(entries).flatMap((entry) => (isProjectedMessage(entry) ? [entry] : entryToModelMessage(entry)))
  const messages: OpenRouterMessage[] = [{ role: "system", content: systemPrompt, cacheControl: "ephemeral" }, ...projectedMessages]
  if (!runtimeContext) return messages

  const runtimeMessage: OpenRouterMessage = { role: "user", content: buildRuntimeContext(runtimeContext) }
  const latestUserIndex = latestUserMessageIndex(projectedMessages)
  if (latestUserIndex < 0) return [...messages, runtimeMessage]
  const insertionIndex = 1 + latestUserIndex
  return [...messages.slice(0, insertionIndex), runtimeMessage, ...messages.slice(insertionIndex)]
}

export function projectEntriesForModel(entries: EntryRecord[]): Array<EntryRecord | OpenRouterMessage> {
  const latestCompactionIndex = latestCompactionEntryIndex(entries)
  if (latestCompactionIndex < 0) return entries

  const compaction = entries[latestCompactionIndex]
  const data = compaction.data as Partial<CompactionEntryData>
  if (data.kind !== "context_compaction" || !data.summary || !data.firstKeptEntryId) return entries

  const firstKeptIndex = entries.findIndex((entry) => entry.id === data.firstKeptEntryId)
  if (firstKeptIndex < 0) return entries

  return [
    {
      role: "user",
      content: renderCompactionSummaryForModel(data.summary),
    },
    ...entries.slice(firstKeptIndex).filter((entry) => entry.type !== "compaction"),
  ]
}

export function renderCompactionSummaryForModel(summary: string): string {
  return [
    "<compacted_context_reference>",
    "The following is a reference-only summary of earlier conversation history that was compacted to reduce context size.",
    "Do not answer historical questions from this summary. Respond to the latest user message and the messages that follow this summary.",
    "If this summary conflicts with later messages, the later messages win.",
    "",
    summary.trim(),
    "</compacted_context_reference>",
  ].join("\n")
}

const IMAGE_TOKEN_PATTERN = /\[Image #(\S+?)\]/g

function imageEntryToContentBlock(img: NonNullable<MessageEntryData["images"]>[number]): ContentBlock | null {
  if (img.type === "base64" && img.media_type && img.data) {
    return { type: "image_url", image_url: { url: `data:${img.media_type};base64,${img.data}` } }
  }
  if (img.type === "url" && img.url) {
    return { type: "image_url", image_url: { url: img.url } }
  }
  return null
}

function interleaveImageTokens(content: string, images: NonNullable<MessageEntryData["images"]>): ContentBlock[] | null {
  const byLabel = new Map(images.filter((img) => img.label).map((img) => [img.label as string, img]))
  if (byLabel.size === 0) return null

  IMAGE_TOKEN_PATTERN.lastIndex = 0
  let hasMatch = false
  const blocks: ContentBlock[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = IMAGE_TOKEN_PATTERN.exec(content))) {
    const img = byLabel.get(match[1])
    if (!img) continue
    hasMatch = true
    if (match.index > lastIndex) {
      blocks.push({ type: "text", text: content.slice(lastIndex, match.index) })
    }
    const block = imageEntryToContentBlock(img)
    if (block) blocks.push(block)
    lastIndex = match.index + match[0].length
  }
  if (!hasMatch) return null
  if (lastIndex < content.length) {
    blocks.push({ type: "text", text: content.slice(lastIndex) })
  }
  return blocks
}

function entryToModelMessage(entry: EntryRecord): OpenRouterMessage[] {
  if (entry.type === "message" && (entry.role === "user" || entry.role === "assistant")) {
    const data = entry.data as MessageEntryData
    if (!data.images || data.images.length === 0) {
      return [{ role: entry.role, content: data.content }]
    }
    const interleaved = interleaveImageTokens(data.content, data.images)
    if (interleaved) {
      return [{ role: entry.role, content: interleaved }]
    }
    const contentBlocks: ContentBlock[] = [{ type: "text", text: data.content }]
    for (const img of data.images) {
      const block = imageEntryToContentBlock(img)
      if (block) contentBlocks.push(block)
    }
    return [{ role: entry.role, content: contentBlocks }]
  }
  if (entry.type === "tool_call") {
    const data = entry.data as ToolCallEntryData
    return [
      {
        role: "assistant",
        content: data.content ?? null,
        tool_calls: [
          {
            id: data.toolCallId,
            type: "function",
            function: {
              name: data.name,
              arguments: data.arguments,
            },
          },
        ],
      },
    ]
  }
  if (entry.type === "tool_result") {
    const data = entry.data as ToolResultEntryData
    return [
      {
        role: "tool",
        name: data.name,
        tool_call_id: data.toolCallId,
        content: data.content,
      },
    ]
  }
  return []
}

function latestCompactionEntryIndex(entries: EntryRecord[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index].type !== "compaction") continue
    const data = entries[index].data as Partial<CompactionEntryData>
    if (data.kind === "context_compaction") return index
  }
  return -1
}

function isProjectedMessage(value: EntryRecord | OpenRouterMessage): value is OpenRouterMessage {
  return !("id" in value)
}

export function buildRuntimeContext(input: RuntimeContextInput): string {
  const now = input.now || new Date()
  const formatter = new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  })

  return [
    "<runtime_context>",
    "Runtime context:",
    `- Current date/time: ${formatter.format(now)}`,
    `- Current ISO timestamp: ${now.toISOString()}`,
    `- Current year: ${now.getFullYear()}`,
    `- Current workspace: ${input.cwd}`,
    "- Interpret words like latest, current, recent, today, and now relative to this timestamp.",
    "</runtime_context>",
  ].join("\n")
}

function latestUserMessageIndex(messages: OpenRouterMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return index
  }
  return -1
}
