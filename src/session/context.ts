import type { OpenRouterContentBlock, OpenRouterMessage } from "../openrouter.js"
import type { CompactionEntryData, EntryRecord, MessageContentBlock, MessageEntryData, ToolCallEntryData, ToolResultEntryData, TranscriptMessage } from "./types.js"

export type RuntimeContextInput = {
  cwd: string
  now?: Date
}

export function entriesToTranscript(entries: EntryRecord[]): TranscriptMessage[] {
  return entries.flatMap((entry) => {
    if (entry.type !== "message") return []
    if (entry.role !== "user" && entry.role !== "assistant") return []

    const data = entry.data as MessageEntryData
    if (data.hidden) return []
    return [{ role: entry.role, content: data.content }]
  })
}

export function entriesToModelMessages(systemPrompt: string, entries: EntryRecord[], runtimeContext?: RuntimeContextInput): OpenRouterMessage[] {
  return [
    { role: "system", content: systemPrompt },
    ...(runtimeContext ? [{ role: "system" as const, content: buildRuntimeContext(runtimeContext) }] : []),
    ...projectEntriesForModel(entries).flatMap((entry) => (isProjectedMessage(entry) ? [entry] : entryToModelMessage(entry))),
  ]
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

function entryToModelMessage(entry: EntryRecord): OpenRouterMessage[] {
  if (entry.type === "message" && (entry.role === "user" || entry.role === "assistant")) {
    const data = entry.data as MessageEntryData
    const content: string | OpenRouterContentBlock[] | null =
      Array.isArray(data.content)
        ? (data.content as MessageContentBlock[]).map((block) => {
            if (block.type === "text") return { type: "text" as const, text: block.text }
            return { type: "image_url" as const, image_url: block.image_url }
          })
        : data.content
    return [{ role: entry.role, content }]
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
    "Runtime context:",
    `- Current date/time: ${formatter.format(now)}`,
    `- Current ISO timestamp: ${now.toISOString()}`,
    `- Current year: ${now.getFullYear()}`,
    `- Current workspace: ${input.cwd}`,
    "- Interpret words like latest, current, recent, today, and now relative to this timestamp.",
  ].join("\n")
}
