import { existsSync, type Dirent } from "node:fs"
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import type { FurnaceConfig } from "./config.js"
import { completeOpenRouterResponse, type OpenRouterModel } from "./openrouter.js"
import { isSecretLikePath } from "./tools/common.js"

export const repoIndexRelativePath = ".furnace/repo-index.md"
export const repoIndexMetaRelativePath = ".furnace/repo-index.meta.json"

const noisyDirs = new Set([
  ".furnace",
  ".git",
  ".hg",
  ".next",
  ".turbo",
  ".venv",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor",
])

const interestingFilePatterns = [
  /^README(\.[a-z0-9]+)?$/i,
  /^AGENTS\.md$/i,
  /^package\.json$/i,
  /^pnpm-workspace\.yaml$/i,
  /^tsconfig\.json$/i,
  /^vite\.config\./i,
  /^next\.config\./i,
  /^pyproject\.toml$/i,
  /^requirements\.txt$/i,
  /^Cargo\.toml$/i,
  /^go\.mod$/i,
  /^Makefile$/i,
]

export type RepoIndexSnapshot = {
  directories: string[]
  files: string[]
  snippets: Array<{ path: string; content: string }>
}

export type RepoIndexMeta = {
  fileCount: number
  generatedAt: string
  gitHead: string | null
  packageName: string | null
}

export type RepoIndexStaleness = {
  reason?: string
  stale: boolean
}

export function repoIndexPath(cwd: string): string {
  return resolve(cwd, repoIndexRelativePath)
}

export function repoIndexMetaPath(cwd: string): string {
  return resolve(cwd, repoIndexMetaRelativePath)
}

export async function shouldOfferRepoIndex(cwd: string): Promise<boolean> {
  return isInsideGitRepo(cwd) && !existsSync(repoIndexPath(cwd))
}

export function isInsideGitRepo(cwd: string): boolean {
  let current = resolve(cwd)
  while (true) {
    if (existsSync(resolve(current, ".git"))) return true
    const parent = dirname(current)
    if (parent === current) return false
    current = parent
  }
}

export function selectRepoIndexModel(config: FurnaceConfig, models: OpenRouterModel[] = []): string {
  const preferredPatterns = preferredModelPatterns(config.provider)
  const match = models.find((model) => preferredPatterns.some((pattern) => pattern.test(`${model.id} ${model.name}`)))
  if (match) return match.id
  if (config.provider === "openrouter" && config.titleModel) return config.titleModel
  return config.providerConfig.defaultModel || config.model
}

export async function generateRepoIndex(input: {
  config: FurnaceConfig
  cwd: string
  models?: OpenRouterModel[]
}): Promise<{ content: string; model: string; path: string }> {
  const snapshot = await collectRepoIndexSnapshot(input.cwd)
  const model = selectRepoIndexModel(input.config, input.models)
  const generatedAt = new Date().toISOString()
  let body: string

  try {
    body = await completeOpenRouterResponse(
      { ...input.config, modelSettings: { fast: true } },
      [
        {
          role: "system",
          content: "Create concise repository orientation notes for a coding agent. Focus on where to look for common work. Do not produce exhaustive file-by-file documentation.",
        },
        {
          role: "user",
          content: renderRepoIndexPrompt(snapshot),
        },
      ],
      { maxTokens: 2200, model },
    )
  } catch (error) {
    body = renderFallbackRepoIndex(snapshot, error)
  }

  const content = renderRepoIndexDocument({ body, generatedAt, snapshot })
  const path = repoIndexPath(input.cwd)
  const metaPath = repoIndexMetaPath(input.cwd)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, "utf8")
  await writeFile(metaPath, `${JSON.stringify(await buildRepoIndexMeta(input.cwd, snapshot, generatedAt), null, 2)}\n`, "utf8")
  return { content, model, path }
}

export async function getRepoIndexStaleness(cwd: string): Promise<RepoIndexStaleness> {
  if (!existsSync(repoIndexPath(cwd))) return { stale: false }
  const meta = await readRepoIndexMeta(cwd)
  if (!meta) return { reason: "metadata missing", stale: true }

  const gitHead = await readGitHead(cwd)
  if (meta.gitHead && gitHead && meta.gitHead !== gitHead) {
    return { reason: "git commit changed", stale: true }
  }

  const packageName = await readPackageName(cwd)
  if (meta.packageName && packageName && meta.packageName !== packageName) {
    return { reason: "package name changed", stale: true }
  }

  return { stale: false }
}

export async function collectRepoIndexSnapshot(cwd: string): Promise<RepoIndexSnapshot> {
  const files: string[] = []
  const dirs = new Set<string>()
  await visitDirectory(resolve(cwd), "", files, dirs)
  files.sort((left, right) => left.localeCompare(right))
  const snippets = await collectSnippets(cwd, files)
  return {
    directories: [...dirs].sort((left, right) => left.localeCompare(right)).slice(0, 120),
    files: files.slice(0, 500),
    snippets,
  }
}

async function visitDirectory(root: string, relativeDir: string, files: string[], dirs: Set<string>): Promise<void> {
  if (files.length >= 700) return
  const current = resolve(root, relativeDir)
  let entries: Dirent[]
  try {
    entries = await readdir(current, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (files.length >= 700) return
    if (entry.name.startsWith(".") && entry.name !== ".github") {
      if (entry.name !== ".cursor") continue
    }
    if (entry.isDirectory()) {
      if (noisyDirs.has(entry.name)) continue
      const childDir = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
      dirs.add(childDir)
      await visitDirectory(root, childDir, files, dirs)
      continue
    }
    if (!entry.isFile()) continue
    const relativeFile = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
    if (isSecretLikePath(relativeFile)) continue
    files.push(relativeFile)
  }
}

async function collectSnippets(cwd: string, files: string[]): Promise<Array<{ path: string; content: string }>> {
  const selected = files.filter(isInterestingFile).slice(0, 12)
  const snippets: Array<{ path: string; content: string }> = []
  for (const file of selected) {
    try {
      const fullPath = resolve(cwd, file)
      const info = await stat(fullPath)
      if (info.size > 80_000) continue
      const content = await readFile(fullPath, "utf8")
      snippets.push({ path: file, content: content.slice(0, 4000) })
    } catch {
      // Ignore files that disappear or are not UTF-8 readable.
    }
  }
  return snippets
}

function isInterestingFile(path: string): boolean {
  const name = path.split("/").at(-1) || path
  return interestingFilePatterns.some((pattern) => pattern.test(name))
}

function renderRepoIndexPrompt(snapshot: RepoIndexSnapshot): string {
  return [
    "Create `.furnace/repo-index.md` content for this repository.",
    "",
    "Write a high-to-mid level dictionary, not an essay.",
    "Use exactly these markdown sections:",
    "## Project Shape",
    "## Key Directories",
    "## File Dictionary",
    "",
    "Rules:",
    "- Keep it path-oriented and practical for a coding agent.",
    "- Keep it under 250 lines if possible; never exceed 400 lines.",
    "- Do not list every file.",
    "- Do not include command tutorials, common tasks, known gaps, changelog notes, or prose-heavy explanations.",
    "- Prefer compact bullets of the form `path` - purpose.",
    "",
    "Directory overview:",
    snapshot.directories.map((dir) => `- ${dir}`).join("\n") || "- No directories found",
    "",
    "Files:",
    snapshot.files.map((file) => `- ${file}`).join("\n") || "- No files found",
    "",
    "Selected file snippets:",
    ...snapshot.snippets.flatMap((snippet) => [
      `--- ${snippet.path} ---`,
      snippet.content,
      "",
    ]),
  ].join("\n")
}

function renderRepoIndexDocument(input: { body: string; generatedAt: string; snapshot: RepoIndexSnapshot }): string {
  const body = input.body.trim() || renderFallbackRepoIndex(input.snapshot)
  return [
    "# Furnace Repo Index",
    "",
    "> Local Furnace-generated codebase guide. Safe to delete; Furnace can regenerate it.",
    `> Generated: ${input.generatedAt}`,
    "> Keep this file as a compact map, not docs. Aim under 250 lines; hard max 400.",
    "",
    body,
    "",
  ].join("\n")
}

function renderFallbackRepoIndex(snapshot: RepoIndexSnapshot, error?: unknown): string {
  const errorLine = error ? [`Generation fallback: ${error instanceof Error ? error.message : String(error)}`, ""] : []
  return [
    ...errorLine,
    "## Project Shape",
    "",
    "- Use this as a starting point before broad exploration.",
    "",
    "## Key Directories",
    "",
    snapshot.directories.slice(0, 40).map((dir) => `- ${dir}`).join("\n") || "- No directories found",
    "",
    "## File Dictionary",
    "",
    snapshot.files.filter(isInterestingFile).slice(0, 40).map((file) => `- ${file}`).join("\n") || "- No obvious project metadata files found",
    "",
  ].join("\n")
}

function preferredModelPatterns(provider: string): RegExp[] {
  if (provider === "anthropic") return [/haiku/i]
  if (provider === "openai") return [/gpt-4o-mini/i, /gpt-4\.1-mini/i, /\bmini\b/i]
  if (provider === "deepseek") return [/deepseek-chat/i, /chat/i]
  if (provider === "glm") return [/flash/i, /air/i, /glm-4/i]
  return [/haiku.*4\.?5/i, /claude.*haiku/i, /gpt-4o-mini/i, /gpt-4\.1-mini/i, /\bmini\b/i]
}

async function buildRepoIndexMeta(cwd: string, snapshot: RepoIndexSnapshot, generatedAt: string): Promise<RepoIndexMeta> {
  return {
    fileCount: snapshot.files.length,
    generatedAt,
    gitHead: await readGitHead(cwd),
    packageName: await readPackageName(cwd),
  }
}

async function readRepoIndexMeta(cwd: string): Promise<RepoIndexMeta | null> {
  try {
    const raw = await readFile(repoIndexMetaPath(cwd), "utf8")
    const parsed = JSON.parse(raw) as Partial<RepoIndexMeta>
    if (typeof parsed.generatedAt !== "string" || typeof parsed.fileCount !== "number") return null
    return {
      fileCount: parsed.fileCount,
      generatedAt: parsed.generatedAt,
      gitHead: typeof parsed.gitHead === "string" ? parsed.gitHead : null,
      packageName: typeof parsed.packageName === "string" ? parsed.packageName : null,
    }
  } catch {
    return null
  }
}

async function readPackageName(cwd: string): Promise<string | null> {
  try {
    const raw = await readFile(resolve(cwd, "package.json"), "utf8")
    const parsed = JSON.parse(raw) as { name?: unknown }
    return typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : null
  } catch {
    return null
  }
}

async function readGitHead(cwd: string): Promise<string | null> {
  const gitDir = await resolveGitDir(cwd)
  if (!gitDir) return null

  try {
    const head = (await readFile(resolve(gitDir, "HEAD"), "utf8")).trim()
    if (!head.startsWith("ref:")) return head || null
    const ref = head.slice("ref:".length).trim()
    return await readGitRef(gitDir, ref)
  } catch {
    return null
  }
}

async function readGitRef(gitDir: string, ref: string): Promise<string | null> {
  try {
    return (await readFile(resolve(gitDir, ref), "utf8")).trim() || null
  } catch {
    const commonGitDir = await resolveCommonGitDir(gitDir)
    if (!commonGitDir || commonGitDir === gitDir) return null
    try {
      return (await readFile(resolve(commonGitDir, ref), "utf8")).trim() || null
    } catch {
      return null
    }
  }
}

async function resolveGitDir(cwd: string): Promise<string | null> {
  let current = resolve(cwd)
  while (true) {
    const dotGit = resolve(current, ".git")
    if (existsSync(dotGit)) {
      try {
        const info = await stat(dotGit)
        if (info.isDirectory()) return dotGit
        const raw = await readFile(dotGit, "utf8")
        const match = raw.match(/^gitdir:\s*(.+)$/m)
        if (match) return resolve(current, match[1].trim())
      } catch {
        return null
      }
    }
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

async function resolveCommonGitDir(gitDir: string): Promise<string | null> {
  try {
    const raw = (await readFile(resolve(gitDir, "commondir"), "utf8")).trim()
    return resolve(gitDir, raw)
  } catch {
    return gitDir
  }
}
