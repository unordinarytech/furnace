import { Parser } from "htmlparser2"
import TurndownService from "turndown"
import { clamp, optionalEnum, optionalNumber, requiredString } from "./common.js"
import type { ToolContext } from "./types.js"

const maxWebSearchResponseBytes = 256 * 1024
const maxWebFetchResponseBytes = 5 * 1024 * 1024
const defaultWebFetchTimeoutMs = 30_000
const maxWebFetchTimeoutMs = 120_000
const exaUrl = process.env.EXA_API_KEY ? `https://mcp.exa.ai/mcp?exaApiKey=${encodeURIComponent(process.env.EXA_API_KEY)}` : "https://mcp.exa.ai/mcp"
const parallelUrl = "https://search.parallel.ai/mcp"

export async function websearchTool(args: unknown, context: ToolContext): Promise<string> {
  const query = requiredString(args, "query")
  const numResults = clamp(optionalNumber(args, "numResults") || 8, 1, 20)
  const livecrawl = optionalEnum(args, "livecrawl", ["fallback", "preferred"]) || "fallback"
  const type = optionalEnum(args, "type", ["auto", "fast", "deep"]) || "auto"
  const contextMaxCharacters = optionalNumber(args, "contextMaxCharacters")
  const boundedContextMaxCharacters = typeof contextMaxCharacters === "number" ? clamp(contextMaxCharacters, 1, 50_000) : undefined
  const provider = optionalEnum(args, "provider", ["exa", "parallel"]) || selectWebSearchProvider(query)
  const fetchImpl = context.services?.fetch || fetch

  const result =
    provider === "parallel"
      ? await callMcpWebTool(
          fetchImpl,
          parallelUrl,
          "web_search",
          {
            objective: query,
            search_queries: [query],
            session_id: "furnace",
          },
          parallelAuthHeaders(),
        )
      : await callMcpWebTool(fetchImpl, exaUrl, "web_search_exa", {
          query,
          type,
          numResults,
          livecrawl,
          ...(boundedContextMaxCharacters ? { contextMaxCharacters: boundedContextMaxCharacters } : {}),
        })

  return result || "No search results found. Please try a different query."
}

export async function webfetchTool(args: unknown, context: ToolContext): Promise<string> {
  const url = requiredString(args, "url")
  const format = optionalEnum(args, "format", ["markdown", "text", "html"]) || "markdown"
  const timeoutMs = clamp((optionalNumber(args, "timeout") || defaultWebFetchTimeoutMs / 1000) * 1000, 1, maxWebFetchTimeoutMs)
  const parsed = new URL(url)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("URL must use http:// or https://")

  const fetchImpl = context.services?.fetch || fetch
  const response = await fetchWithTimeout(fetchImpl, parsed.toString(), {
    headers: webFetchHeaders(format),
    timeoutMs,
  })
  if (!response.ok) throw new Error(`Web fetch failed (${response.status}): ${response.statusText}`)

  const contentLength = response.headers.get("content-length")
  if (contentLength && Number.parseInt(contentLength, 10) > maxWebFetchResponseBytes) {
    throw new Error(`Response too large (exceeds ${maxWebFetchResponseBytes} byte limit)`)
  }

  const arrayBuffer = await response.arrayBuffer()
  if (arrayBuffer.byteLength > maxWebFetchResponseBytes) {
    throw new Error(`Response too large (exceeds ${maxWebFetchResponseBytes} byte limit)`)
  }

  const contentType = response.headers.get("content-type") || ""
  const mime = mimeFrom(contentType)
  if (!isTextualMime(mime)) throw new Error(`Unsupported fetched content type: ${mime || "unknown"}`)

  const content = new TextDecoder().decode(arrayBuffer)
  if (format === "html") return content
  if (contentType.toLowerCase().includes("text/html")) {
    return format === "text" ? extractTextFromHTML(content) : convertHTMLToMarkdown(content)
  }
  return content
}

async function callMcpWebTool(fetchImpl: typeof fetch, url: string, tool: string, toolArguments: Record<string, unknown>, headers: Record<string, string> = {}): Promise<string | undefined> {
  const response = await fetchWithTimeout(fetchImpl, url, {
    method: "POST",
    timeoutMs: 25_000,
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: tool,
        arguments: toolArguments,
      },
    }),
  })
  if (!response.ok) throw new Error(`${tool} request failed (${response.status}): ${response.statusText}`)
  const body = await response.text()
  if (Buffer.byteLength(body, "utf8") > maxWebSearchResponseBytes) {
    throw new Error(`${tool} response exceeded ${maxWebSearchResponseBytes} bytes`)
  }
  return parseMcpWebResponse(body)
}

async function fetchWithTimeout(fetchImpl: typeof fetch, url: string, options: RequestInit & { timeoutMs: number }): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs)
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

function parseMcpWebResponse(body: string): string | undefined {
  const direct = parseMcpWebPayload(body.trim())
  if (direct) return direct
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue
    const parsed = parseMcpWebPayload(line.slice("data: ".length).trim())
    if (parsed) return parsed
  }
  return undefined
}

function parseMcpWebPayload(payload: string): string | undefined {
  if (!payload.startsWith("{")) return undefined
  try {
    const parsed = JSON.parse(payload) as { result?: { content?: Array<{ text?: string; type?: string }> } }
    return parsed.result?.content?.find((item) => item.text)?.text
  } catch {
    return undefined
  }
}

function selectWebSearchProvider(seed: string): "exa" | "parallel" {
  const configured = process.env.FURNACE_WEBSEARCH_PROVIDER || process.env.OPENCODE_WEBSEARCH_PROVIDER
  if (configured === "exa" || configured === "parallel") return configured
  let hash = 0
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return hash % 2 === 0 ? "exa" : "parallel"
}

function parallelAuthHeaders(): Record<string, string> {
  const headers = { "User-Agent": "furnace/0.1.0-alpha.0" }
  return process.env.PARALLEL_API_KEY ? { ...headers, Authorization: `Bearer ${process.env.PARALLEL_API_KEY}` } : headers
}

function webFetchHeaders(format: "html" | "markdown" | "text"): Record<string, string> {
  const accept =
    format === "markdown"
      ? "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
      : format === "text"
        ? "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1"
        : "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1"
  return {
    Accept: accept,
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
  }
}

function mimeFrom(contentType: string): string {
  return contentType.split(";")[0]?.trim().toLowerCase() || ""
}

function isTextualMime(mime: string): boolean {
  return (
    !mime ||
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime.endsWith("+json") ||
    mime === "application/xml" ||
    mime.endsWith("+xml") ||
    mime === "application/javascript" ||
    mime === "application/x-javascript"
  )
}

function extractTextFromHTML(html: string): string {
  let text = ""
  let skipDepth = 0
  const parser = new Parser({
    onopentag(name) {
      if (skipDepth > 0 || ["script", "style", "noscript", "iframe", "object", "embed"].includes(name)) skipDepth += 1
    },
    ontext(input) {
      if (skipDepth === 0) text += input
    },
    onclosetag() {
      if (skipDepth > 0) skipDepth -= 1
    },
  })
  parser.write(html)
  parser.end()
  return text.trim()
}

function convertHTMLToMarkdown(html: string): string {
  const turndown = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  })
  turndown.remove(["script", "style", "meta", "link"])
  return turndown.turndown(html)
}
