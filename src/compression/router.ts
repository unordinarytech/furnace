import type { StoredArtifact } from "./artifacts.js"

export type CompressionKind = "json" | "diff" | "log" | "search" | "generic"

export type ToolOutputCompressionInput = {
  artifact: StoredArtifact
  content: string
  maxBytes: number
  maxLines: number
}

export type ToolOutputCompressionResult = {
  artifact: StoredArtifact
  compressed: boolean
  content: string
  kind: CompressionKind
}

export function compressToolOutput(input: ToolOutputCompressionInput): ToolOutputCompressionResult {
  const kind = detectContentKind(input.content)
  const body = compressByKind(kind, input.content, input.maxLines, input.maxBytes)
  const beforeLines = input.content.split(/\r?\n/).length
  const beforeBytes = Buffer.byteLength(input.content, "utf8")
  const header = [
    "Tool output compressed (Headroom-lite).",
    `Detected content: ${kind}`,
    `Original: ${beforeLines.toLocaleString()} lines, ${beforeBytes.toLocaleString()} bytes`,
    `Full output artifact: ${input.artifact.id} (${input.artifact.relativePath})`,
    `Retrieve with: context_retrieve({\"id\":\"${input.artifact.id}\"})`,
    "",
  ].join("\n")
  return {
    artifact: input.artifact,
    compressed: true,
    content: `${header}${body}`,
    kind,
  }
}

export function detectContentKind(content: string): CompressionKind {
  const trimmed = content.trim()
  if (looksLikeJson(trimmed)) return "json"
  if (looksLikeDiff(content)) return "diff"
  if (looksLikeSearchOutput(content)) return "search"
  if (looksLikeLog(content)) return "log"
  return "generic"
}

function compressByKind(kind: CompressionKind, content: string, maxLines: number, maxBytes: number): string {
  switch (kind) {
    case "json":
      return compressJson(content)
    case "diff":
      return compressDiff(content)
    case "search":
      return compressSearch(content)
    case "log":
      return compressLog(content)
    default:
      return compressGeneric(content, maxLines, maxBytes)
  }
}

function looksLikeJson(trimmed: string): boolean {
  if (!(trimmed.startsWith("{") && trimmed.endsWith("}")) && !(trimmed.startsWith("[") && trimmed.endsWith("]"))) return false
  try {
    JSON.parse(trimmed)
    return true
  } catch {
    return false
  }
}

function looksLikeDiff(content: string): boolean {
  return /(^|\n)(diff --git |@@ |\+\+\+ |--- )/.test(content)
}

function looksLikeSearchOutput(content: string): boolean {
  const lines = content.split(/\r?\n/).slice(0, 80)
  if (lines.length < 20) return false
  const matchLines = lines.filter((line) => /^.+:\d+:.+/.test(line)).length
  return matchLines >= Math.min(10, Math.floor(lines.length * 0.4))
}

function looksLikeLog(content: string): boolean {
  const lower = content.toLowerCase()
  return /\b(error|failed|failure|exception|traceback|warning|warn|panic|fatal|stack trace|tests? failed)\b/.test(lower) || /(^|\n)\s*(at\s+.+:\d+:\d+|\d+\)\s+)/.test(content)
}

function compressJson(content: string): string {
  try {
    const value = JSON.parse(content)
    if (Array.isArray(value)) return compressJsonArray(value)
    if (value && typeof value === "object") return compressJsonObject(value as Record<string, unknown>)
    return `JSON scalar preserved:\n${JSON.stringify(value)}`
  } catch {
    return compressGeneric(content, 120, 16 * 1024)
  }
}

function compressJsonArray(values: unknown[]): string {
  const keyCounts = new Map<string, number>()
  const important: unknown[] = []
  for (const value of values) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const key of Object.keys(value)) keyCounts.set(key, (keyCounts.get(key) || 0) + 1)
    }
    if (important.length < 20 && JSON.stringify(value).match(/error|fail|failed|failure|exception|fatal|warn|warning|denied|invalid/i)) important.push(value)
  }
  const keys = [...keyCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([key]) => key)
  const sample = values.slice(0, 5)
  return [
    "JSON array summary:",
    `- items: ${values.length.toLocaleString()}`,
    keys.length ? `- common keys: ${keys.join(", ")}` : undefined,
    important.length ? `- important/error-like items preserved: ${important.length}` : "- no obvious error-like items detected in sampled scan",
    "",
    important.length ? `Important items:\n${safeJson(important)}` : undefined,
    "Sample items:",
    safeJson(sample),
    values.length > sample.length ? `\nOmitted ${Math.max(0, values.length - sample.length - important.length).toLocaleString()} routine/sample-overflow items.` : undefined,
  ].filter(Boolean).join("\n")
}

function compressJsonObject(value: Record<string, unknown>): string {
  const entries = Object.entries(value)
  const important = entries.filter(([key, val]) => /error|fail|exception|fatal|warn|status|message|code/i.test(key) || JSON.stringify(val).match(/error|fail|exception|fatal|warn/i)).slice(0, 20)
  return [
    "JSON object summary:",
    `- keys: ${entries.length.toLocaleString()}`,
    `- top-level keys: ${entries.slice(0, 40).map(([key]) => key).join(", ")}${entries.length > 40 ? ", ..." : ""}`,
    important.length ? "" : undefined,
    important.length ? `Important fields:\n${safeJson(Object.fromEntries(important))}` : undefined,
    "",
    `Sample:\n${safeJson(Object.fromEntries(entries.slice(0, 10)))}`,
  ].filter(Boolean).join("\n")
}

function compressDiff(content: string): string {
  const lines = content.split(/\r?\n/)
  const files = new Set<string>()
  let additions = 0
  let deletions = 0
  const hunks: string[] = []
  for (const line of lines) {
    const diffMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/)
    if (diffMatch) files.add(diffMatch[2])
    if (line.startsWith("+++") || line.startsWith("---")) continue
    if (line.startsWith("+")) additions += 1
    if (line.startsWith("-")) deletions += 1
    if (line.startsWith("@@") && hunks.length < 30) hunks.push(line)
  }
  return [
    "Diff summary:",
    `- files touched: ${files.size}`,
    `- additions: ${additions}`,
    `- deletions: ${deletions}`,
    files.size ? `- files: ${[...files].slice(0, 30).join(", ")}${files.size > 30 ? ", ..." : ""}` : undefined,
    hunks.length ? "" : undefined,
    hunks.length ? `Hunks:\n${hunks.join("\n")}` : undefined,
    "",
    `Preview:\n${headTail(lines, 80)}`,
  ].filter(Boolean).join("\n")
}

function compressSearch(content: string): string {
  const lines = content.split(/\r?\n/).filter(Boolean)
  const fileCounts = new Map<string, number>()
  const important: string[] = []
  for (const line of lines) {
    const match = line.match(/^(.+?):\d+:/)
    if (match) fileCounts.set(match[1], (fileCounts.get(match[1]) || 0) + 1)
    if (important.length < 40 && /error|fail|todo|fixme|warn|deprecated|throw|panic|fatal/i.test(line)) important.push(line)
  }
  const topFiles = [...fileCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
  return [
    "Search output summary:",
    `- matches: ${lines.length.toLocaleString()}`,
    `- files: ${fileCounts.size.toLocaleString()}`,
    topFiles.length ? "- top files:" : undefined,
    ...topFiles.map(([file, count]) => `  - ${file}: ${count}`),
    important.length ? "" : undefined,
    important.length ? `Important-looking matches:\n${important.join("\n")}` : undefined,
    "",
    `Preview:\n${headTail(lines, 80)}`,
  ].filter(Boolean).join("\n")
}

function compressLog(content: string): string {
  const lines = content.split(/\r?\n/)
  const important = lines.filter((line) => /error|failed|failure|exception|traceback|warning|warn|panic|fatal|expected|received|assert|stack|\bat\s+.+:\d+/i.test(line)).slice(0, 120)
  const repeated = repeatedLineSummary(lines)
  return [
    "Log/test output summary:",
    `- lines: ${lines.length.toLocaleString()}`,
    important.length ? `- important lines preserved: ${important.length}` : "- no obvious error lines detected",
    repeated.length ? "- repeated noise:" : undefined,
    ...repeated.map(({ line, count }) => `  - ${JSON.stringify(line.slice(0, 140))} x${count}`),
    "",
    important.length ? `Important lines:\n${important.join("\n")}` : `Preview:\n${headTail(lines, 120)}`,
  ].filter(Boolean).join("\n")
}

function compressGeneric(content: string, maxLines: number, maxBytes: number): string {
  const marker = "... middle omitted from generic preview ..."
  const lines = content.split(/\r?\n/)
  const preview = headTail(lines, Math.min(maxLines, 240))
  return takeBytes(["Generic bounded preview:", preview.includes(marker) ? preview : preview].join("\n"), Math.min(maxBytes, 24 * 1024))
}

function repeatedLineSummary(lines: string[]): Array<{ count: number; line: string }> {
  const counts = new Map<string, number>()
  for (const line of lines) {
    const normalized = line.trim()
    if (!normalized || normalized.length > 220) continue
    counts.set(normalized, (counts.get(normalized) || 0) + 1)
  }
  return [...counts.entries()].filter(([, count]) => count >= 5).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([line, count]) => ({ count, line }))
}

function headTail(lines: string[], maxLines: number): string {
  if (lines.length <= maxLines) return lines.join("\n")
  const headCount = Math.ceil(maxLines / 2)
  const tailCount = Math.floor(maxLines / 2)
  return `${lines.slice(0, headCount).join("\n")}\n... ${lines.length - maxLines} middle lines omitted ...\n${lines.slice(-tailCount).join("\n")}`
}

function safeJson(value: unknown): string {
  return takeBytes(JSON.stringify(value, null, 2), 16 * 1024)
}

function takeBytes(value: string, maxBytes: number): string {
  let bytes = 0
  let output = ""
  for (const char of value) {
    const size = Buffer.byteLength(char, "utf8")
    if (bytes + size > maxBytes) return `${output}\n... truncated ...`
    output += char
    bytes += size
  }
  return output
}
