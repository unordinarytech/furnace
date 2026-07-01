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
  { name: "/model", description: "Select model", usage: "/model" },
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
  { name: "/permissions", description: "Clear conversation approvals" },
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

export type PickerCommand = "history" | "model" | "theme"

export function pickerCommandFor(value: string): PickerCommand | undefined {
  if (!value.startsWith("/")) return undefined
  const command = parseSlashCommand(value)
  if (command.argument) return undefined
  if (isHistoryCommand(command.name)) return "history"
  if (command.name === "/model") return "model"
  if (command.name === "/theme") return "theme"
  return undefined
}
