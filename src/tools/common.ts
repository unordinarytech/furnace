import { constants } from "node:fs"
import { access, readdir } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { storeContextArtifact } from "../compression/artifacts.js"
import { compressToolOutput } from "../compression/router.js"
import type { ToolContext } from "./types.js"

export const maxToolOutputBytes = 50 * 1024
export const maxToolOutputLines = 2_000
export const noisyDirectoryNames = new Set(["node_modules", ".git", ".furnace"])

export function resolveToolPath(cwd: string, inputPath: string): string {
  if (inputPath === "~") return resolve(homeDirectory())
  if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) return resolve(homeDirectory(), inputPath.slice(2))
  return resolve(cwd, inputPath)
}

function homeDirectory(): string {
  return process.env.HOME || process.env.USERPROFILE || cwdFallback()
}

function cwdFallback(): string {
  return process.cwd()
}

export function assertReadablePath(cwd: string, file: string): void {
  if (isSecretLikePath(file)) throw new Error(`Refusing to read secret-like file: ${displayPath(cwd, file)}`)
}

export function isSecretLikePath(file: string): boolean {
  const parts = file.split(/[\\/]/)
  const name = parts[parts.length - 1] || ""
  return name !== ".env.example" && (name === ".env" || name.startsWith(".env."))
}

export function isInsideNoisyDirectory(file: string): boolean {
  return resolve(file).split(/[\\/]/).some((part) => noisyDirectoryNames.has(part))
}

export function displayPath(cwd: string, file: string): string {
  const normalizedCwd = resolve(cwd)
  const normalizedFile = resolve(file)
  const relativeFile = relative(normalizedCwd, normalizedFile)
  if (relativeFile === "") return "."
  if (!relativeFile.startsWith("..") && !isAbsolute(relativeFile) && !relativeFile.includes(`..${sep}`)) return relativeFile
  return normalizedFile
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

export async function listFiles(root: string, cwd: string, maxResults: number, query: string, options: { skipNoisyDirs: boolean }): Promise<string[]> {
  const results: string[] = []
  async function visit(directory: string): Promise<void> {
    if (results.length >= maxResults) return
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (results.length >= maxResults) return
      if (options.skipNoisyDirs && noisyDirectoryNames.has(entry.name)) continue
      const fullPath = resolve(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(fullPath)
        continue
      }
      if (!entry.isFile()) continue
      const label = displayPath(cwd, fullPath)
      if (!query || label.toLowerCase().includes(query)) results.push(fullPath)
    }
  }
  await visit(root)
  return results.sort((left, right) => displayPath(cwd, left).localeCompare(displayPath(cwd, right)))
}

export function objectSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required,
    properties,
  }
}

export function arraySchema(items: Record<string, unknown>, description: string): Record<string, unknown> {
  return { type: "array", items, description }
}

export function stringSchema(description: string): Record<string, unknown> {
  return { type: "string", description }
}

export function numberSchema(description: string): Record<string, unknown> {
  return { type: "number", description }
}

export function booleanSchema(description: string): Record<string, unknown> {
  return { type: "boolean", description }
}

export function enumSchema(values: string[], description: string): Record<string, unknown> {
  return { type: "string", enum: values, description }
}

export function requiredString(args: unknown, key: string): string {
  const value = getArg(args, key)
  if (typeof value !== "string") throw new Error(`Expected string argument: ${key}`)
  return value
}

export function optionalString(args: unknown, key: string): string | undefined {
  const value = getArg(args, key)
  return typeof value === "string" ? value : undefined
}

export function optionalNumber(args: unknown, key: string): number | undefined {
  const value = getArg(args, key)
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function optionalBoolean(args: unknown, key: string): boolean | undefined {
  const value = getArg(args, key)
  return typeof value === "boolean" ? value : undefined
}

export function optionalEnum<TValue extends string>(args: unknown, key: string, values: readonly TValue[]): TValue | undefined {
  const value = getArg(args, key)
  return typeof value === "string" && values.includes(value as TValue) ? (value as TValue) : undefined
}

export function getArg(args: unknown, key: string): unknown {
  return args && typeof args === "object" ? (args as Record<string, unknown>)[key] : undefined
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function globToRegExp(pattern: string): RegExp {
  let source = "^"
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    const next = pattern[index + 1]
    const afterNext = pattern[index + 2]
    if (char === "*" && next === "*" && afterNext === "/") {
      source += "(?:.*/)?"
      index += 2
      continue
    }
    if (char === "*" && next === "*") {
      source += ".*"
      index += 1
      continue
    }
    if (char === "*") {
      source += "[^/]*"
      continue
    }
    if (char === "?") {
      source += "[^/]"
      continue
    }
    source += escapeRegExp(char)
  }
  return new RegExp(`${source}$`)
}

export function escapeRegExp(value: string): string {
  return value.replace(/[\\^$+?.()|[\]{}]/g, "\\$&")
}

export async function boundToolOutput(value: string, context: ToolContext): Promise<string> {
  const byteLength = Buffer.byteLength(value, "utf8")
  const lines = value.split("\n")
  if (byteLength <= maxToolOutputBytes && lines.length <= maxToolOutputLines) return value

  const artifact = await storeContextArtifact({ content: value, cwd: context.cwd })
  return compressToolOutput({ artifact, content: value, maxBytes: maxToolOutputBytes, maxLines: maxToolOutputLines }).content
}

export function boundedPreview(value: string, marker: string, maxLines: number, maxBytes: number): string {
  const markerOnly = takePrefix(marker, maxBytes).split("\n").slice(0, maxLines).join("\n")
  const markerBytes = Buffer.byteLength(marker, "utf8")
  if (maxLines <= 4 || maxBytes <= markerBytes + 4) return markerOnly

  const preview = splitPreview(value, maxLines - 4, maxBytes - markerBytes - 4)
  return preview.tail ? `${preview.head}\n\n${marker}\n\n${preview.tail}` : `${preview.head}\n\n${marker}`
}

function splitPreview(value: string, maxLines: number, maxBytes: number): { head: string; tail: string } {
  const lines = value.split("\n")
  const headLines = Math.ceil(maxLines / 2)
  const tailLines = Math.floor(maxLines / 2)
  const head = lines.slice(0, headLines).join("\n")
  const tail = lines.length > maxLines && tailLines > 0 ? lines.slice(lines.length - tailLines).join("\n") : ""
  const sampled = tail ? `${head}\n${tail}` : head
  if (Buffer.byteLength(sampled, "utf8") <= maxBytes) return { head, tail }
  return {
    head: takePrefix(head, Math.ceil(maxBytes / 2)),
    tail: tail ? takeSuffix(tail, Math.floor(maxBytes / 2)) : "",
  }
}

function takePrefix(value: string, maxBytes: number): string {
  let bytes = 0
  let output = ""
  for (const char of value) {
    const size = Buffer.byteLength(char, "utf8")
    if (bytes + size > maxBytes) break
    output += char
    bytes += size
  }
  return output
}

function takeSuffix(value: string, maxBytes: number): string {
  let bytes = 0
  const output: string[] = []
  for (const char of Array.from(value).reverse()) {
    const size = Buffer.byteLength(char, "utf8")
    if (bytes + size > maxBytes) break
    output.unshift(char)
    bytes += size
  }
  return output.join("")
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, max)}\n... truncated ${value.length - max} chars`
}
