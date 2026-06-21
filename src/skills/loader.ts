import { readdir, readFile, stat } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import type { Skill, SkillCatalog, SkillDiagnostic } from "./types.js"

const skillFileName = "SKILL.md"
const skippedDirectoryNames = new Set([".git", ".furnace", "node_modules"])
const maxNameLength = 64
const maxDescriptionLength = 1024

type SkillFrontmatter = {
  description?: string
  "disable-model-invocation"?: boolean
  name?: string
}

type SkillRoot = {
  path: string
  provenance: string
}

export type LoadSkillsOptions = {
  extraPaths?: string[]
}

export async function loadSkills(cwd: string, options: LoadSkillsOptions = {}): Promise<SkillCatalog> {
  const diagnostics: SkillDiagnostic[] = []
  const skillsByName = new Map<string, Skill>()

  for (const root of skillRoots(cwd, options.extraPaths || [])) {
    const result = await loadSkillsFromRoot(root)
    diagnostics.push(...result.diagnostics)
    for (const skill of result.skills) {
      if (skillsByName.has(skill.name)) {
        diagnostics.push({ message: `Duplicate skill name ignored: ${skill.name}`, path: skill.filePath })
        continue
      }
      skillsByName.set(skill.name, skill)
    }
  }

  return {
    diagnostics,
    skills: [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name)),
  }
}

export async function loadSkillByName(cwd: string, name: string, options: LoadSkillsOptions = {}): Promise<Skill | undefined> {
  const catalog = await loadSkills(cwd, options)
  return catalog.skills.find((skill) => skill.name === name)
}

export function skillRoots(cwd: string, extraPaths: string[] = []): SkillRoot[] {
  const home = process.env.HOME
  return [
    { path: join(cwd, ".furnace", "skills"), provenance: "project .furnace" },
    { path: join(cwd, ".agents", "skills"), provenance: "project .agents" },
    ...(home
      ? [
          { path: join(home, ".furnace", "skills"), provenance: "user .furnace" },
          { path: join(home, ".agents", "skills"), provenance: "user .agents" },
          { path: join(home, ".cursor", "skills"), provenance: "Cursor user" },
          { path: join(home, ".cursor", "skills-cursor"), provenance: "Cursor managed" },
          { path: join(home, ".cursor", "plugins", "cache"), provenance: "Cursor plugin cache" },
          { path: join(home, ".claude", "skills"), provenance: "Claude Code user" },
          { path: join(home, ".claude", "plugins", "cache"), provenance: "Claude Code plugin cache" },
        ]
      : []),
    ...extraPaths.map((path) => ({ path: resolveSkillRootPath(cwd, path), provenance: "configured" })),
  ]
}

async function loadSkillsFromRoot(root: SkillRoot): Promise<SkillCatalog> {
  const diagnostics: SkillDiagnostic[] = []
  const skills: Skill[] = []

  if (!(await isDirectory(root.path))) return { diagnostics, skills }
  await scan(root.path, root, diagnostics, skills)
  return { diagnostics, skills }
}

async function scan(dir: string, root: SkillRoot, diagnostics: SkillDiagnostic[], skills: Skill[]): Promise<void> {
  const skillFile = join(dir, skillFileName)
  if (await isFile(skillFile)) {
    const loaded = await loadSkillFile(skillFile, root)
    diagnostics.push(...loaded.diagnostics)
    if (loaded.skill) skills.push(loaded.skill)
    return
  }

  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith(".") && entry.name !== ".agents") continue
    if (skippedDirectoryNames.has(entry.name)) continue
    await scan(join(dir, entry.name), root, diagnostics, skills)
  }
}

async function loadSkillFile(filePath: string, root: SkillRoot): Promise<{ diagnostics: SkillDiagnostic[]; skill?: Skill }> {
  const diagnostics: SkillDiagnostic[] = []
  const raw = await readFile(filePath, "utf8").catch((error: unknown) => {
    diagnostics.push({ message: error instanceof Error ? error.message : String(error), path: filePath })
    return undefined
  })
  if (raw === undefined) return { diagnostics }

  const parsed = parseSkillMarkdown(raw)
  const name = parsed.frontmatter.name?.trim() || dirname(filePath).split(/[\\/]/).pop() || ""
  const description = parsed.frontmatter.description?.trim() || ""

  for (const message of validateSkill(name, description)) diagnostics.push({ message, path: filePath })
  if (!description) return { diagnostics }
  if (validateSkillName(name).length > 0) return { diagnostics }

  return {
    diagnostics,
    skill: {
      baseDir: dirname(filePath),
      content: parsed.body.trim(),
      description,
      disableModelInvocation: parsed.frontmatter["disable-model-invocation"] === true,
      filePath,
      name,
      provenance: root.provenance,
      root: root.path,
    },
  }
}

function resolveSkillRootPath(cwd: string, path: string): string {
  if (path === "~") return resolve(homeDirectory())
  if (path.startsWith("~/") || path.startsWith("~\\")) return resolve(homeDirectory(), path.slice(2))
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path)
}

function homeDirectory(): string {
  return process.env.HOME || process.env.USERPROFILE || process.cwd()
}

function parseSkillMarkdown(raw: string): { body: string; frontmatter: SkillFrontmatter } {
  const normalized = raw.replace(/\r\n/g, "\n")
  if (!normalized.startsWith("---\n")) return { body: normalized, frontmatter: {} }
  const end = normalized.indexOf("\n---", 4)
  if (end < 0) return { body: normalized, frontmatter: {} }
  const frontmatterText = normalized.slice(4, end).trim()
  const body = normalized.slice(end + "\n---".length).replace(/^\n/, "")
  return { body, frontmatter: parseFrontmatter(frontmatterText) }
}

function parseFrontmatter(value: string): SkillFrontmatter {
  const frontmatter: SkillFrontmatter = {}
  for (const line of value.split("\n")) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!match) continue
    const key = match[1]
    const rawValue = unquote(match[2].trim())
    if (key === "name") frontmatter.name = rawValue
    if (key === "description") frontmatter.description = rawValue
    if (key === "disable-model-invocation") frontmatter["disable-model-invocation"] = rawValue === "true"
  }
  return frontmatter
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

function validateSkill(name: string, description: string): string[] {
  return [...validateSkillName(name), ...validateDescription(description)]
}

function validateSkillName(name: string): string[] {
  const errors: string[] = []
  if (!name) errors.push("name is required")
  if (name.length > maxNameLength) errors.push(`name exceeds ${maxNameLength} characters`)
  if (!/^[a-z0-9-]+$/.test(name)) errors.push("name must use lowercase letters, numbers, and hyphens only")
  if (name.startsWith("-") || name.endsWith("-")) errors.push("name must not start or end with a hyphen")
  if (name.includes("--")) errors.push("name must not contain consecutive hyphens")
  return errors
}

function validateDescription(description: string): string[] {
  if (!description) return ["description is required"]
  if (description.length > maxDescriptionLength) return [`description exceeds ${maxDescriptionLength} characters`]
  return []
}

async function isDirectory(path: string): Promise<boolean> {
  const info = await stat(resolve(path)).catch(() => undefined)
  return Boolean(info?.isDirectory())
}

async function isFile(path: string): Promise<boolean> {
  const info = await stat(resolve(path)).catch(() => undefined)
  return Boolean(info?.isFile())
}
