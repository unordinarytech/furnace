export type SlashCommandDefinition = {
  aliases?: string[]
  description: string
  insertText?: string
  name: string
  usage?: string
}

export type ParsedPrompt = {
  argument: string
  name: string
}

export const slashCommandDefinitions: SlashCommandDefinition[] = [
  { name: "/clear", description: "Clear the conversation display" },
  { name: "/new", description: "Start a fresh conversation" },
  { name: "/resume", aliases: ["/history"], description: "Open saved conversations" },
  { name: "/image", description: "Attach image to next message", insertText: "/image ", usage: "/image <path|url>" },
  { name: "/fork", description: "Fork from current point or a prior user prompt", insertText: "/fork ", usage: "/fork [current|prompt-preview]" },
  { name: "/clone", description: "Fork from the current conversation tip" },
  { name: "/model", description: "Select model", usage: "/model" },
  { name: "/models", description: "Browse providers and their models", usage: "/models" },
  { name: "/plan", description: "Switch to plan mode", insertText: "/plan ", usage: "/plan [prompt]" },
  { name: "/agent", description: "Switch to normal agent mode" },
  { name: "/mode", description: "Show or switch mode", insertText: "/mode ", usage: "/mode [agent|plan]" },
  { name: "/mode agent", description: "Switch to normal agent mode" },
  { name: "/mode plan", description: "Switch to plan mode" },
  { name: "/theme", description: "Select or set theme", insertText: "/theme ", usage: "/theme [name]" },
  { name: "/tasks", description: "Show active subagents" },
  { name: "/compact", description: "Summarize old context and keep recent turns", insertText: "/compact ", usage: "/compact [focus]" },
  { name: "/skills", description: "List, view, or reload skills", insertText: "/skills ", usage: "/skills [list|view <name>|reload]" },
  { name: "/skills list", description: "List discovered skills" },
  { name: "/skills view", description: "View a skill", insertText: "/skills view ", usage: "/skills view <name>" },
  { name: "/skills reload", description: "Reload discovered skills" },
  { name: "/lofi", description: "Toggle lofi mode" },
  { name: "/evolve", description: "Modify the furnace harness itself", insertText: "/evolve ", usage: "/evolve <what to change>" },
  { name: "/reset", description: "Reset the furnace harness to its default state (undo all evolve changes)" },
  { name: "/settings", aliases: ["/prefs"], description: "View and change app preferences" },
  { name: "/login", description: "Set or update your API key" },
  { name: "/init", description: "Learn this repo and write .furnace/repo-index.md" },
  { name: "/permissions", description: "Clear conversation approvals" },
  { name: "/status", description: "Show session status (model, mode, context, cwd)" },
  { name: "/export", description: "Export conversation to file", insertText: "/export ", usage: "/export [json] [path]" },
  { name: "/diff", description: "Show diff of files changed this session" },
  { name: "/undo", description: "Revert the most recent file-changing tool call" },
  { name: "/copy", description: "Copy last assistant response to clipboard" },
  { name: "/cost", description: "Show token and cost usage for this session" },
  { name: "/editor", description: "Open $EDITOR to compose a message" },
  { name: "/bug", description: "File a bug report", insertText: "/bug ", usage: "/bug [message]" },
  { name: "/exit", aliases: ["/quit"], description: "Exit Furnace" },
]

const slashCommandNames = new Set(slashCommandDefinitions.flatMap((command) => [command.name, ...(command.aliases || [])]))

export function parseSlashCommand(prompt: string): ParsedPrompt {
  if (!prompt.startsWith("/")) return { argument: "", name: prompt }
  const [name = "", ...rest] = prompt.slice(1).trim().split(/\s+/)
  return { argument: rest.join(" ").trim(), name: `/${name.toLowerCase()}` }
}

const historyCommandNames = new Set(["/resume", "/history"])

export function isHistoryCommand(command: string): boolean {
  return historyCommandNames.has(command)
}

export function isKnownSlashCommand(command: string): boolean {
  return slashCommandNames.has(command)
}

export type AutocompleteScope = "fork" | "history" | "model" | "theme"

export function argumentScopeFor(value: string): AutocompleteScope | undefined {
  if (!value.startsWith("/")) return undefined
  const spaceIndex = value.indexOf(" ")
  const head = (spaceIndex < 0 ? value : value.slice(0, spaceIndex)).toLowerCase()
  if (isHistoryCommand(head)) return "history"
  if (head === "/fork") return "fork"
  if (head === "/model") return "model"
  if (head === "/theme") return "theme"
  return undefined
}
