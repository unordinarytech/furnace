import type { OpenRouterMessage } from "../openrouter.js"
import type { EntryRecord, MessageEntryData, ToolCallEntryData, ToolResultEntryData, TranscriptMessage } from "./types.js"

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
    ...entries.flatMap(entryToModelMessage),
  ]
}

function entryToModelMessage(entry: EntryRecord): OpenRouterMessage[] {
  if (entry.type === "message" && (entry.role === "user" || entry.role === "assistant")) {
    const data = entry.data as MessageEntryData
    return [{ role: entry.role, content: data.content }]
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
