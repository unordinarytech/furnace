import { stdout as output } from "node:process"
import type { MessageContentBlock, TranscriptMessage } from "../session/types.js"

function contentToString(content: string | MessageContentBlock[]): string {
  if (typeof content === "string") return content
  return content
    .map((b) => (b.type === "text" ? b.text : b.type === "image_url" ? "[image]" : ""))
    .join("\n")
    .trim()
}

const colors = {
  accent: "\x1b[38;5;149m",
  border: "\x1b[38;5;67m",
  dim: "\x1b[2m",
  error: "\x1b[38;5;203m",
  reset: "\x1b[0m",
}

export function renderAssistantStart(transcriptOrPrompt?: string | TranscriptMessage[]): void {
  const transcript = typeof transcriptOrPrompt === "string" ? [{ role: "user" as const, content: transcriptOrPrompt }] : transcriptOrPrompt || []
  renderTranscript(transcript)
  output.write(`\n${colors.border}─ response ${"─".repeat(50)}${colors.reset}\n\n`)
}

export function renderDone(): void {
  output.write(`\n\n${colors.dim}done${colors.reset}\n`)
}

export function renderError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  output.write(`\n${colors.error}error:${colors.reset} ${message}\n`)
}

export function renderConversation(transcript: TranscriptMessage[]): void {
  renderTranscript(transcript)
}

function renderUserBlock(prompt: string, width = Math.max(60, output.columns || 80)): void {
  output.write(`${colors.accent}> user ${colors.border}${"─".repeat(Math.max(0, width - 8))}${colors.reset}\n\n`)
  output.write(`${prompt}\n`)
}

function renderAssistantBlock(content: string, width = Math.max(60, output.columns || 80)): void {
  output.write(`${colors.border}─ assistant ${"─".repeat(Math.max(0, width - 12))}${colors.reset}\n\n`)
  output.write(`${content}\n`)
}

function renderTranscript(transcript: TranscriptMessage[], width = Math.max(60, output.columns || 80)): void {
  for (const message of transcript) {
    if (message.toolCall) continue
    const text = contentToString(message.content)
    if (message.role === "user") renderUserBlock(text, width)
    else renderAssistantBlock(text, width)
    output.write("\n")
  }
}
