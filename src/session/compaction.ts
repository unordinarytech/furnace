import type { FurnaceConfig } from "../config.js"
import { completeOpenRouterResponse, type OpenRouterMessage, type OpenRouterToolDefinition } from "../openrouter.js"
import { entriesToModelMessages } from "./context.js"
import type { CompactionEntryData, EntryRecord, MessageEntryData, ToolCallEntryData, ToolResultEntryData } from "./types.js"
import type { SessionStore } from "./store.js"

const defaultContextWindow = 200_000
const smallContextReserveTokens = 8_000
const defaultReserveTokens = 16_000
const defaultKeepRecentTokens = 20_000
const summaryOutputTokens = 4_096
const toolResultSummaryChars = 4_000
const maxSerializedEntryChars = 8_000
const ineffectiveSavingsRatio = 0.05

export type CompactionReason = CompactionEntryData["reason"]

export type CompactionSettings = {
  contextWindow: number
  enabled: boolean
  keepRecentTokens: number
  reserveTokens: number
}

export type CompactionResult = {
  entry?: EntryRecord<CompactionEntryData>
  reason: CompactionReason
  skipped?: string
  tokensAfter?: number
  tokensBefore: number
}

export type CompactSessionInput = {
  config: FurnaceConfig
  cwd: string
  focus?: string
  force?: boolean
  reason: CompactionReason
  runtimeContext?: { cwd: string; now?: Date }
  sessionId: string
  store: SessionStore
  systemPrompt: string
  tools?: OpenRouterToolDefinition[]
}

export function resolveCompactionSettings(config: FurnaceConfig): CompactionSettings {
  const contextWindow = Math.max(8_000, config.modelSettings.contextLength || defaultContextWindow)
  const isSmallContext = contextWindow <= 64_000
  return {
    contextWindow,
    enabled: true,
    keepRecentTokens: isSmallContext ? Math.max(4_000, Math.floor(contextWindow * 0.25)) : defaultKeepRecentTokens,
    reserveTokens: isSmallContext ? smallContextReserveTokens : defaultReserveTokens,
  }
}

export function estimateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  if (!text) return 0
  return Math.max(1, Math.ceil(text.length / 4))
}

export function estimateRequestTokens(messages: OpenRouterMessage[], tools: OpenRouterToolDefinition[] = []): number {
  return estimateTokens(messages) + estimateTokens(tools)
}

export function shouldCompactTokenEstimate(tokens: number, settings: CompactionSettings): boolean {
  if (!settings.enabled) return false
  return tokens >= settings.contextWindow - settings.reserveTokens
}

export async function compactSessionIfNeeded(input: CompactSessionInput): Promise<CompactionResult> {
  const settings = resolveCompactionSettings(input.config)
  const activePath = input.store.getActivePath(input.sessionId)
  const messages = entriesToModelMessages(input.systemPrompt, activePath, input.runtimeContext || { cwd: input.cwd })
  const tokensBefore = estimateRequestTokens(messages, input.tools)
  if (!input.force && !shouldCompactTokenEstimate(tokensBefore, settings)) {
    return { reason: input.reason, skipped: "below_threshold", tokensBefore }
  }
  return compactSession({ ...input, tokensBefore })
}

async function compactSession(input: CompactSessionInput & { tokensBefore: number }): Promise<CompactionResult> {
  const activePath = input.store.getActivePath(input.sessionId)
  if (activePath.length === 0) return { reason: input.reason, skipped: "empty_session", tokensBefore: input.tokensBefore }
  if (activePath[activePath.length - 1]?.type === "compaction") return { reason: input.reason, skipped: "already_compacted", tokensBefore: input.tokensBefore }

  const settings = resolveCompactionSettings(input.config)
  const previousCompactionIndex = latestCompactionEntryIndex(activePath)
  const previousCompaction = previousCompactionIndex >= 0 ? (activePath[previousCompactionIndex]?.data as Partial<CompactionEntryData>) : undefined
  const keepStart = findKeepStart(activePath, {
    keepRecentTokens: settings.keepRecentTokens,
    minIndex: previousCompactionIndex + 1,
  })

  const entriesToSummarize = activePath.slice(previousCompactionIndex + 1, keepStart).filter((entry) => entry.type !== "compaction")
  const firstKept = activePath[keepStart]
  if (!firstKept) return { reason: input.reason, skipped: "no_recent_suffix", tokensBefore: input.tokensBefore }
  if (entriesToSummarize.length === 0) return { reason: input.reason, skipped: "nothing_to_summarize", tokensBefore: input.tokensBefore }

  const serialized = serializeEntriesForSummary(entriesToSummarize)
  const generated = await generateCompactionSummary({
    config: input.config,
    focus: input.focus,
    previousSummary: previousCompaction?.kind === "context_compaction" ? previousCompaction.summary : undefined,
    serialized,
  })
  const data: CompactionEntryData = {
    details: {
      fallback: generated.fallback,
      ...collectFileDetails(entriesToSummarize),
      summarizedEntryCount: entriesToSummarize.length,
    },
    firstKeptEntryId: firstKept.id,
    focus: input.focus,
    kind: "context_compaction",
    model: input.config.model,
    reason: input.reason,
    summary: generated.summary,
    tokensBefore: input.tokensBefore,
  }

  const entry = input.store.appendCompaction(input.sessionId, data)
  input.store.clearFileReadState(input.sessionId)

  const compactedPath = input.store.getActivePath(input.sessionId)
  const tokensAfter = estimateRequestTokens(entriesToModelMessages(input.systemPrompt, compactedPath, input.runtimeContext || { cwd: input.cwd }), input.tools)
  const completedData = { ...data, tokensAfter }
  if (tokensAfter < input.tokensBefore || input.reason === "manual") {
    entry.data = completedData
    updateCompactionEntryData(input.store, entry.id, completedData)
  }

  if (input.reason !== "manual" && input.tokensBefore > 0) {
    const ratio = (input.tokensBefore - tokensAfter) / input.tokensBefore
    if (ratio < ineffectiveSavingsRatio) {
      return { entry, reason: input.reason, skipped: "ineffective_compaction", tokensAfter, tokensBefore: input.tokensBefore }
    }
  }

  return { entry, reason: input.reason, tokensAfter, tokensBefore: input.tokensBefore }
}

export function findKeepStart(entries: EntryRecord[], input: { keepRecentTokens: number; minIndex?: number }): number {
  const minIndex = Math.max(0, input.minIndex || 0)
  if (entries.length === 0) return 0

  let tokens = 0
  let keepStart = entries.length
  for (let index = entries.length - 1; index >= minIndex; index -= 1) {
    const entry = entries[index]
    if (entry.type === "compaction") continue
    const entryTokens = estimateEntryTokens(entry)
    if (keepStart < entries.length && tokens + entryTokens > input.keepRecentTokens) break
    tokens += entryTokens
    keepStart = index
    if (tokens >= input.keepRecentTokens) break
  }
  if (keepStart === entries.length) keepStart = entries.length - 1

  const latestUserIndex = latestUserMessageIndex(entries)
  if (latestUserIndex >= minIndex && latestUserIndex < keepStart) keepStart = latestUserIndex

  while (keepStart > minIndex && entries[keepStart]?.type === "tool_result") keepStart -= 1
  return Math.max(minIndex, keepStart)
}

function updateCompactionEntryData(store: SessionStore, entryId: string, data: CompactionEntryData): void {
  store.updateEntryData(entryId, data)
}

async function generateCompactionSummary(input: {
  config: FurnaceConfig
  focus?: string
  previousSummary?: string
  serialized: string
}): Promise<{ fallback: boolean; summary: string }> {
  const prompt = renderSummaryPrompt(input)
  try {
    const summary = await completeOpenRouterResponse(
      input.config,
      [
        {
          role: "system",
          content: "You compact coding-agent conversation history. Preserve exact operational facts, remove noise, and never include secrets.",
        },
        { role: "user", content: prompt },
      ],
      { maxTokens: summaryOutputTokens },
    )
    const cleaned = redactSecrets(summary).trim()
    if (cleaned) return { fallback: false, summary: cleaned }
  } catch {
    // Hermes-style safety: failed summarization should not make the session unusable.
  }
  return { fallback: true, summary: deterministicSummaryFallback(input.serialized, input.previousSummary) }
}

function renderSummaryPrompt(input: { focus?: string; previousSummary?: string; serialized: string }): string {
  return [
    "Compact the historical conversation into a concise markdown reference for a coding agent.",
    "",
    "Hard rules:",
    "- This summary is reference-only. The latest user message after the summary wins.",
    "- Do not answer questions from the compacted turns.",
    "- Do not resume stale historical remaining work unless the newest user message asks for it.",
    "- Preserve exact file paths, commands, error strings, decisions, tests, changed files, and unresolved blockers.",
    "- Never include credentials, tokens, cookies, private keys, or .env values. Replace them with [REDACTED].",
    "- Keep only facts that help continue the current session safely.",
    input.focus ? `- User-provided compaction focus: ${input.focus}` : "",
    "",
    "Output exactly these sections:",
    "## Historical Task Snapshot",
    "## Goal",
    "## Constraints & Preferences",
    "## Completed Actions",
    "## Active State",
    "## Historical In-Progress State",
    "## Blocked",
    "## Key Decisions",
    "## Resolved Questions",
    "## Historical Pending User Asks",
    "## Relevant Files",
    "## Historical Remaining Work",
    "## Critical Context",
    "",
    input.previousSummary
      ? ["<previous_summary>", redactSecrets(input.previousSummary), "</previous_summary>", ""].join("\n")
      : "",
    "<conversation_to_compact>",
    redactSecrets(input.serialized),
    "</conversation_to_compact>",
  ]
    .filter((line) => line !== "")
    .join("\n")
}

function serializeEntriesForSummary(entries: EntryRecord[]): string {
  return entries
    .map((entry, index) => {
      const label = `${index + 1}. ${entry.type}${entry.role ? `/${entry.role}` : ""} ${entry.id}`
      return `${label}\n${truncateEntryForSummary(entry)}`
    })
    .join("\n\n")
}

function truncateEntryForSummary(entry: EntryRecord): string {
  if (entry.type === "message") {
    const data = entry.data as MessageEntryData
    const text = Array.isArray(data.content)
      ? data.content.filter((b) => b.type === "text").map((b) => (b as { type: "text"; text: string }).text).join("\n")
      : data.content
    return truncateForSummary(text)
  }
  if (entry.type === "tool_call") {
    const data = entry.data as ToolCallEntryData
    return truncateForSummary(`tool: ${data.name}\narguments: ${data.arguments}\ncontent: ${data.content || ""}`)
  }
  if (entry.type === "tool_result") {
    const data = entry.data as ToolResultEntryData
    return truncateForSummary(`tool: ${data.name}\ntool_call_id: ${data.toolCallId}\nresult:\n${truncate(data.content, toolResultSummaryChars)}`)
  }
  return truncateForSummary(JSON.stringify(entry.data))
}

function deterministicSummaryFallback(serialized: string, previousSummary?: string): string {
  const criticalContext = previousSummary
    ? `${redactSecrets(previousSummary)}\n\nNew compacted excerpts:\n${redactSecrets(serialized)}`
    : redactSecrets(serialized)
  const lines = [
    "## Historical Task Snapshot",
    "The previous conversation was compacted with a deterministic fallback because LLM summarization was unavailable.",
    "",
    "## Goal",
    "See the preserved historical excerpts and newer messages after this summary.",
    "",
    "## Constraints & Preferences",
    previousSummary ? "Previous summary was preserved below." : "No additional constraints could be inferred reliably.",
    "",
    "## Completed Actions",
    "Review newer messages and tool history after this summary for exact completed work.",
    "",
    "## Active State",
    "The latest user message after this summary is authoritative.",
    "",
    "## Historical In-Progress State",
    "Unknown from deterministic fallback.",
    "",
    "## Blocked",
    "Unknown from deterministic fallback.",
    "",
    "## Key Decisions",
    "Unknown from deterministic fallback.",
    "",
    "## Resolved Questions",
    "Unknown from deterministic fallback.",
    "",
    "## Historical Pending User Asks",
    "Do not resume historical asks unless the latest user message requests it.",
    "",
    "## Relevant Files",
    extractFileMentions(serialized).map((file) => `- ${file}`).join("\n") || "- Unknown",
    "",
    "## Historical Remaining Work",
    "Use only if confirmed by newer messages.",
    "",
    "## Critical Context",
    truncate(criticalContext, maxSerializedEntryChars),
  ]
  return lines.join("\n")
}

function collectFileDetails(entries: EntryRecord[]): { modifiedFiles: string[]; readFiles: string[] } {
  const readFiles = new Set<string>()
  const modifiedFiles = new Set<string>()
  for (const entry of entries) {
    if (entry.type !== "tool_call") continue
    const data = entry.data as ToolCallEntryData
    const args = parseJsonObject(data.arguments)
    const path = typeof args.path === "string" ? args.path : undefined
    if (!path) continue
    if (["read", "ls", "find", "glob", "grep"].includes(data.name)) readFiles.add(path)
    if (["write", "edit"].includes(data.name)) modifiedFiles.add(path)
  }
  return { modifiedFiles: [...modifiedFiles].sort(), readFiles: [...readFiles].sort() }
}

function latestCompactionEntryIndex(entries: EntryRecord[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index].type !== "compaction") continue
    const data = entries[index].data as Partial<CompactionEntryData>
    if (data.kind === "context_compaction") return index
  }
  return -1
}

function latestUserMessageIndex(entries: EntryRecord[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index].type === "message" && entries[index].role === "user") return index
  }
  return -1
}

function estimateEntryTokens(entry: EntryRecord): number {
  if (entry.type === "message") return estimateTokens((entry.data as MessageEntryData).content)
  if (entry.type === "tool_call") return estimateTokens((entry.data as ToolCallEntryData).arguments) + 16
  if (entry.type === "tool_result") return estimateTokens((entry.data as ToolResultEntryData).content) + 16
  return estimateTokens(entry.data)
}

function truncateForSummary(value: string): string {
  return truncate(redactSecrets(value), maxSerializedEntryChars)
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}\n... truncated ${value.length - maxChars} chars`
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = value.trim() ? JSON.parse(value) : {}
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function extractFileMentions(value: string): string[] {
  const matches = value.match(/(?:\.{0,2}\/|[A-Za-z0-9_.-]+\/)[A-Za-z0-9_./-]+\.[A-Za-z0-9]+/g) || []
  return [...new Set(matches)].slice(0, 40)
}

function redactSecrets(value: string): string {
  return value
    .replace(/(sk-[A-Za-z0-9_-]{16,})/g, "[REDACTED]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|token|secret|password|passwd|pwd)\s*[:=]\s*)["']?[^"'\s]+["']?/gi, "$1[REDACTED]")
    .replace(/(-----BEGIN [A-Z ]+PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]+PRIVATE KEY-----)/g, "$1\n[REDACTED]\n$2")
}
