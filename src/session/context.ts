import type { OpenRouterMessage } from "../openrouter.js"
import type { EntryRecord, MessageEntryData, TranscriptMessage } from "./types.js"

export function entriesToTranscript(entries: EntryRecord[]): TranscriptMessage[] {
  return entries.flatMap((entry) => {
    if (entry.type !== "message") return []
    if (entry.role !== "user" && entry.role !== "assistant") return []

    const data = entry.data as MessageEntryData
    return [{ role: entry.role, content: data.content }]
  })
}

export function entriesToModelMessages(systemPrompt: string, entries: EntryRecord[]): OpenRouterMessage[] {
  return [
    { role: "system", content: systemPrompt },
    ...entriesToTranscript(entries).map((message) => ({
      role: message.role,
      content: message.content,
    })),
  ]
}
