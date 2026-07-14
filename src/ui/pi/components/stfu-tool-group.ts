import { Box, Container, Text } from "@earendil-works/pi-tui"
import { theme } from "../theme.js"

type ToolStatus = "done" | "failed" | "running"

type ToolRow = {
  ids: string[]
  statusById: Map<string, ToolStatus>
  summary: string
}

export class StfuToolGroup extends Container {
  private readonly box = new Box(1, 0, (text: string) => theme.bg("toolPendingBg", text))
  private readonly text = new Text("", 0, 0)
  private readonly rows: ToolRow[] = []

  constructor() {
    super()
    this.box.addChild(this.text)
    this.addChild(this.box)
  }

  add(id: string, name: string, args: unknown): void {
    const summary = compactToolSummary(name, args)
    const previous = this.rows.at(-1)
    if (previous?.summary === summary) {
      previous.ids.push(id)
      previous.statusById.set(id, "running")
    } else {
      this.rows.push({
        ids: [id],
        statusById: new Map([[id, "running"]]),
        summary,
      })
    }
    this.updateDisplay()
  }

  update(id: string, status: ToolStatus): void {
    const row = this.rows.find((candidate) => candidate.statusById.has(id))
    if (!row) return
    row.statusById.set(id, status)
    this.updateDisplay()
  }

  private updateDisplay(): void {
    const statuses = this.rows.flatMap((row) => [...row.statusById.values()])
    const background = statuses.includes("failed")
      ? (text: string) => theme.bg("toolErrorBg", text)
      : statuses.every((status) => status === "done")
        ? (text: string) => theme.bg("toolSuccessBg", text)
        : (text: string) => theme.bg("toolPendingBg", text)
    this.box.setBgFn(background)
    this.text.setText(this.rows.map(renderRow).join("\n"))
  }
}

export function compactToolSummary(name: string, args: unknown): string {
  const values = args && typeof args === "object" ? args as Record<string, unknown> : {}
  const string = (key: string): string | undefined => typeof values[key] === "string" ? values[key] : undefined
  const count = (key: string): number | undefined => typeof values[key] === "number" ? values[key] : undefined

  switch (name) {
    case "bash":
      return `$ ${string("command") || "…"}`
    case "edit":
      return `edit ${patchTargetCount(string("patch"))}`
    case "find":
      return `find ${string("query") || "…"} in ${string("path") || "."}${suffixCount(count("maxResults"))}`
    case "glob":
      return `glob ${string("pattern") || "…"}`
    case "grep":
      return `grep ${string("pattern") || "…"} in ${string("path") || "."}${suffixCount(count("maxResults"))}`
    case "ls":
      return `ls ${string("path") || "."}`
    case "read":
      return `read ${string("path") || "…"}`
    case "write":
      return `write ${string("path") || "…"}`
    case "webfetch":
      return `fetch ${string("url") || "…"}`
    case "websearch":
      return `search ${string("query") || "…"}`
    default:
      return name
  }
}

function patchTargetCount(patch: string | undefined): string {
  if (!patch) return "patch"
  const targets = patch.match(/^\*\*\* (?:Add|Update|Delete) File:/gm)?.length || 0
  return targets > 0 ? `${targets} file${targets === 1 ? "" : "s"}` : "patch"
}

function suffixCount(value: number | undefined): string {
  return value === undefined ? "" : ` (${value})`
}

function renderRow(row: ToolRow): string {
  const statuses = [...row.statusById.values()]
  const status = statuses.includes("failed")
    ? theme.fg("error", "×")
    : statuses.every((value) => value === "done")
      ? theme.fg("success", "✓")
      : theme.fg("warning", "·")
  const multiplier = row.ids.length > 1 ? theme.fg("muted", ` x${row.ids.length}`) : ""
  return `${status} ${theme.fg("toolOutput", row.summary)}${multiplier}`
}
