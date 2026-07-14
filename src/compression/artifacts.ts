import { createHash } from "node:crypto"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"

export type StoredArtifact = {
  bytes: number
  id: string
  path: string
  relativePath: string
}

export type RetrievedArtifact = StoredArtifact & {
  content: string
  endLine: number
  lineCount: number
  startLine: number
  totalLines: number
}

const artifactDirectory = ".furnace/context-store"
const artifactExtension = ".txt"

export async function storeContextArtifact(input: { content: string; cwd: string }): Promise<StoredArtifact> {
  const hash = createHash("sha256").update(input.content).digest("hex").slice(0, 24)
  const id = `ctx_${hash}`
  const dir = resolve(input.cwd, artifactDirectory)
  await mkdir(dir, { recursive: true })
  const file = resolve(dir, `${id}${artifactExtension}`)
  await writeFile(file, input.content, "utf8")
  return {
    bytes: Buffer.byteLength(input.content, "utf8"),
    id,
    path: file,
    relativePath: displayPath(input.cwd, file),
  }
}

export async function retrieveContextArtifact(input: { cwd: string; id: string; limit?: number; offset?: number }): Promise<RetrievedArtifact> {
  if (!/^ctx_[a-f0-9]{24}$/.test(input.id)) throw new Error("Artifact id must look like ctx_<24 hex chars>.")
  const file = resolve(input.cwd, artifactDirectory, `${input.id}${artifactExtension}`)
  const fileInfo = await stat(file)
  if (!fileInfo.isFile()) throw new Error(`Artifact not found: ${input.id}`)
  const fullContent = await readFile(file, "utf8")
  const lines = fullContent.split(/\r?\n/)
  const start = Math.max(0, (input.offset || 1) - 1)
  const selected = typeof input.limit === "number" ? lines.slice(start, start + Math.max(0, input.limit)) : lines.slice(start)
  const startLine = lines.length === 0 ? 0 : start + 1
  const endLine = selected.length === 0 ? start : start + selected.length
  return {
    bytes: fileInfo.size,
    content: selected.join("\n"),
    endLine,
    id: input.id,
    lineCount: selected.length,
    path: file,
    relativePath: displayPath(input.cwd, file),
    startLine,
    totalLines: lines.length,
  }
}

export function displayPath(cwd: string, file: string): string {
  const normalizedCwd = resolve(cwd)
  const normalizedFile = resolve(file)
  const relativeFile = relative(normalizedCwd, normalizedFile)
  if (relativeFile === "") return "."
  if (!relativeFile.startsWith("..") && !isAbsolute(relativeFile) && !relativeFile.includes(`..${sep}`)) return relativeFile
  return normalizedFile
}
