import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

export type SkillManageTarget = "project" | "user" | "cursor-user" | "claude-user"

export type SkillManageInput = {
  body: string
  description: string
  disableModelInvocation?: boolean
  name: string
  overwrite?: boolean
  target?: SkillManageTarget
}

export type SkillManageResult = {
  created: boolean
  filePath: string
  previousContent?: string
  skillContent: string
  target: SkillManageTarget
}

const maxSkillBodyLines = 500
const maxNameLength = 64
const maxDescriptionLength = 1024

export async function writeManagedSkill(cwd: string, input: SkillManageInput): Promise<SkillManageResult> {
  validateSkillManageInput(input)
  const target = input.target || "project"
  const root = writableSkillRoot(cwd, target)
  const filePath = resolve(root, input.name, "SKILL.md")
  assertInside(root, filePath)

  const previousContent = await readFile(filePath, "utf8").catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined
    throw error
  })
  if (previousContent !== undefined && !input.overwrite) {
    throw new Error(`Skill already exists: ${input.name}. Set overwrite true to update it.`)
  }

  const skillContent = renderManagedSkill(input)
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, skillContent, "utf8")

  return {
    created: previousContent === undefined,
    filePath,
    previousContent,
    skillContent,
    target,
  }
}

export function renderManagedSkill(input: SkillManageInput): string {
  validateSkillManageInput(input)
  const frontmatter = [
    "---",
    `name: ${input.name}`,
    `description: ${yamlQuote(input.description.trim())}`,
    input.disableModelInvocation === false ? undefined : "disable-model-invocation: true",
    "---",
  ].filter(Boolean)
  return `${frontmatter.join("\n")}\n\n${input.body.trim()}\n`
}

export function writableSkillRoot(cwd: string, target: SkillManageTarget): string {
  const home = process.env.HOME || process.env.USERPROFILE || cwd
  if (target === "project") return resolve(cwd, ".furnace", "skills")
  if (target === "cursor-user") return resolve(home, ".cursor", "skills")
  if (target === "claude-user") return resolve(home, ".claude", "skills")
  return resolve(home, ".furnace", "skills")
}

export function validateSkillManageInput(input: SkillManageInput): void {
  const nameErrors = validateSkillName(input.name)
  if (nameErrors.length > 0) throw new Error(nameErrors.join("; "))
  const description = input.description.trim()
  if (!description) throw new Error("description is required")
  if (description.length > maxDescriptionLength) throw new Error(`description exceeds ${maxDescriptionLength} characters`)
  if (!input.body.trim()) throw new Error("body is required")
  if (input.body.split(/\r?\n/).length > maxSkillBodyLines) throw new Error(`body exceeds ${maxSkillBodyLines} lines`)
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

function yamlQuote(value: string): string {
  return JSON.stringify(value)
}

function assertInside(root: string, filePath: string): void {
  const normalizedRoot = resolve(root)
  const normalizedFile = resolve(filePath)
  if (normalizedFile === normalizedRoot || normalizedFile.startsWith(`${normalizedRoot}/`)) return
  throw new Error(`Refusing to write outside skill root: ${normalizedFile}`)
}
