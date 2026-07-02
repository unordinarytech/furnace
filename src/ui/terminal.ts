import readline from "node:readline/promises"
import { stdin as input, stdout as output } from "node:process"
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
  text: "\x1b[38;5;252m",
  title: "\x1b[1m",
}

export type PromptContext = {
  cwd: string
  model: string
  title?: string
}

type Layout = {
  inputTop: number
  responseBottom: number
  responseTop: number
  rows: number
  width: number
}

let activeLayout: Layout | undefined
let activeContext: PromptContext | undefined
let streamTranscript: TranscriptMessage[] = []

export function clearScreen(): void {
  output.write("\x1b[2J\x1b[H")
}

export function renderHeader(context: PromptContext): void {
  activeLayout = getLayout()
  activeContext = context

  renderTitle(activeLayout)
  renderInputPanel(context, activeLayout)
}

export async function readPrompt(context: PromptContext, transcript: TranscriptMessage[] = []): Promise<string> {
  renderHeader(context)
  renderTranscriptArea(transcript)

  const rl = readline.createInterface({ input, output })
  const layout = activeLayout || getLayout()
  const prompt = await rl.question(`${moveTo(layout.inputTop + 1, 5)}${colors.accent}>${colors.reset} `)
  rl.close()

  return prompt.trim()
}

export function renderAssistantStart(transcriptOrPrompt?: string | TranscriptMessage[]): void {
  const transcript = typeof transcriptOrPrompt === "string" ? [{ role: "user" as const, content: transcriptOrPrompt }] : transcriptOrPrompt || []
  streamTranscript = transcript

  if (!activeLayout || !activeContext) {
    renderTranscript(transcript)
    output.write(`\n${colors.border}─ response ${"─".repeat(50)}${colors.reset}\n\n`)
    return
  }

  const responseRow = renderTranscriptArea(transcript, 4)
  output.write(moveTo(responseRow, 1))
  output.write(`${colors.border}─ response ${"─".repeat(Math.min(50, activeLayout.width - 12))}${colors.reset}\n\n`)
}

export function renderAssistantToken(token: string): void {
  output.write(token)
}

export function renderDone(): void {
  output.write(`\n\n${colors.dim}done${colors.reset}\n`)
}

export function renderError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  output.write(resetScrollRegion())
  output.write(`\n${colors.error}error:${colors.reset} ${message}\n`)
}

export function renderConversation(transcript: TranscriptMessage[]): void {
  streamTranscript = transcript
  renderTranscriptArea(transcript)
}

function renderTitle(layout: Layout): void {
  const label = " Furnace "
  const ruleWidth = Math.max(0, layout.width - label.length)
  const left = Math.floor(ruleWidth / 2)
  const right = ruleWidth - left

  output.write(moveTo(1, 1))
  output.write(`${colors.accent}${"─".repeat(left)}${colors.reset}`)
  output.write(`${colors.title}${colors.text}${label}${colors.reset}`)
  output.write(`${colors.accent}${"─".repeat(right)}${colors.reset}`)
}

function renderInputPanel(context: PromptContext, layout: Layout): void {
  const width = layout.width
  const cwd = shortenHome(context.cwd)
  const status = "0.0%/auto"
  const model = context.model

  output.write(moveTo(layout.inputTop, 1))
  output.write(`${colors.border}${"─".repeat(width)}${colors.reset}`)
  output.write(moveTo(layout.inputTop + 1, 1))
  output.write(`${colors.text}│${colors.reset}${" ".repeat(width - 1)}`)
  output.write(moveTo(layout.inputTop + 2, 1))
  output.write(`${colors.border}${"─".repeat(width)}${colors.reset}`)
  output.write(moveTo(layout.inputTop + 3, 1))
  output.write(`${colors.dim}${truncate(context.title ? `${cwd} · ${context.title}` : cwd, width)}${colors.reset}${clearToEndOfLine()}`)
  output.write(moveTo(layout.inputTop + 4, 1))
  output.write(`${colors.dim}${status}${colors.reset}${colors.dim}${alignRight(model, width - status.length)}${colors.reset}`)
  output.write(clearToEndOfLine())
}

function renderUserBlock(prompt: string, width = Math.max(60, output.columns || 80)): void {
  output.write(`${colors.accent}> user ${colors.border}${"─".repeat(Math.max(0, width - 8))}${colors.reset}\n\n`)
  output.write(`${prompt}\n`)
}

function renderAssistantBlock(content: string, width = Math.max(60, output.columns || 80)): void {
  output.write(`${colors.border}─ assistant ${"─".repeat(Math.max(0, width - 12))}${colors.reset}\n\n`)
  output.write(`${content}\n`)
}

function renderTranscriptArea(transcript: TranscriptMessage[], reserveLines = 0): number {
  if (!activeLayout || !activeContext) return 1

  clearResponseArea(activeLayout)
  renderInputPanel(activeContext, activeLayout)
  return renderTranscriptLines(transcript, activeLayout, reserveLines)
}

function renderTranscript(transcript: TranscriptMessage[], width = Math.max(60, output.columns || 80)): void {
  for (const message of transcript) {
    const text = contentToString(message.content)
    if (message.role === "user") renderUserBlock(text, width)
    else renderAssistantBlock(text, width)
    output.write("\n")
  }
}

function renderTranscriptLines(transcript: TranscriptMessage[], layout: Layout, reserveLines: number): number {
  const lines = buildTranscriptLines(transcript, layout.width)
  const available = Math.max(1, layout.responseBottom - layout.responseTop + 1 - reserveLines)
  const visible = lines.slice(Math.max(0, lines.length - available))

  for (let index = 0; index < visible.length; index += 1) {
    output.write(moveTo(layout.responseTop + index, 1))
    output.write(truncate(visible[index] ?? "", layout.width))
    output.write(clearToEndOfLine())
  }

  return Math.min(layout.responseBottom, layout.responseTop + visible.length)
}

function buildTranscriptLines(transcript: TranscriptMessage[], width: number): string[] {
  const lines: string[] = []

  for (const message of transcript) {
    const label = message.role === "user" ? "> user " : "─ assistant "
    // Keep these fixed-area transcript lines plain. They are clipped to the
    // terminal width, and clipping ANSI-colored strings can leak escape codes.
    lines.push(`${label}${"─".repeat(Math.max(0, width - label.length))}`)
    lines.push("")
    lines.push(...wrap(contentToString(message.content), width))
    lines.push("")
  }

  return lines
}

function wrap(text: string, width: number): string[] {
  const result: string[] = []
  for (const sourceLine of text.split("\n")) {
    let line = sourceLine
    if (!line) {
      result.push("")
      continue
    }
    while (line.length > width) {
      result.push(line.slice(0, width))
      line = line.slice(width)
    }
    result.push(line)
  }
  return result
}

function clearResponseArea(layout: Layout): void {
  for (let row = 2; row <= layout.responseBottom; row += 1) {
    output.write(moveTo(row, 1))
    output.write(clearLine())
  }
}

function getLayout(): Layout {
  const width = Math.max(60, output.columns || 80)
  const rows = Math.max(14, output.rows || 24)
  const inputHeight = 5
  const inputTop = Math.max(5, rows - inputHeight + 1)
  const responseTop = 3
  const responseBottom = Math.max(responseTop, inputTop - 2)

  return {
    inputTop,
    responseBottom,
    responseTop,
    rows,
    width,
  }
}

function shortenHome(path: string): string {
  const home = process.env.HOME
  if (!home) return path
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path
}

function alignRight(value: string, available: number): string {
  return `${" ".repeat(Math.max(1, available - value.length))}${value}`
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return value
  if (width <= 1) return value.slice(0, width)
  return `…${value.slice(value.length - width + 1)}`
}

function moveTo(row: number, column: number): string {
  return `\x1b[${row};${column}H`
}

function clearLine(): string {
  return "\x1b[2K"
}

function clearToEndOfLine(): string {
  return "\x1b[0K"
}

function setScrollRegion(top: number, bottom: number): string {
  return `\x1b[${top};${bottom}r`
}

function resetScrollRegion(): string {
  return "\x1b[r"
}
