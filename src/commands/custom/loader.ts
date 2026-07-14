import { readdir, readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import type { CustomCommand } from "./types.js"

const maxNameLength = 64
const namePattern = /^[a-z0-9-]+$/

export async function loadCustomCommands(cwd: string): Promise<CustomCommand[]> {
  const byName = new Map<string, CustomCommand>()

  // Project commands override global ones
  for (const [root, provenance] of [
    [join(homedir(), ".furnace", "commands"), "global"] as const,
    [join(cwd, ".furnace", "commands"), "project"] as const,
  ]) {
    const commands = await loadFromRoot(root, provenance)
    for (const cmd of commands) {
      byName.set(cmd.name, cmd)
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function renderCustomCommandTemplate(template: string, argument: string): string {
  if (template.includes("$ARGUMENTS")) return template.replaceAll("$ARGUMENTS", argument)
  return argument ? `${template}\n${argument}` : template
}

async function loadFromRoot(root: string, provenance: "project" | "global"): Promise<CustomCommand[]> {
  const info = await stat(resolve(root)).catch(() => undefined)
  if (!info?.isDirectory()) return []

  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const commands: CustomCommand[] = []

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue
    const name = entry.name.slice(0, -3)
    if (!isValidName(name)) continue

    const filePath = join(root, entry.name)
    const raw = await readFile(filePath, "utf8").catch(() => "")
    const { description, body } = parseFrontmatter(raw)

    commands.push({ description, filePath, name, provenance, template: body.trim() })
  }

  return commands
}

function isValidName(name: string): boolean {
  if (!name || name.length > maxNameLength) return false
  if (!namePattern.test(name)) return false
  if (name.startsWith("-") || name.endsWith("-")) return false
  if (name.includes("--")) return false
  return true
}

function parseFrontmatter(raw: string): { description: string; body: string } {
  const normalized = raw.replace(/\r\n/g, "\n")
  if (!normalized.startsWith("---\n")) return { description: "", body: normalized }
  const end = normalized.indexOf("\n---", 4)
  if (end < 0) return { description: "", body: normalized }

  const fmText = normalized.slice(4, end)
  const body = normalized.slice(end + 4).replace(/^\n/, "")
  let description = ""
  for (const line of fmText.split("\n")) {
    const m = line.match(/^description:\s*(.+)$/)
    if (m) { description = m[1].trim(); break }
  }
  return { description, body }
}
