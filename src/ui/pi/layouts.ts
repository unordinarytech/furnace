import { Container, type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"
import { normalizeTerminalLayout, type TerminalLayout } from "../../preferences.js"
import { theme } from "./theme.js"

export type LayoutOption = {
  description: string
  label: string
  value: TerminalLayout
}

export const LAYOUT_OPTIONS: readonly LayoutOption[] = [
  { value: "classic", label: "Classic", description: "The familiar banner → transcript → composer flow" },
  { value: "notebook", label: "Notebook", description: "An editorial, labelled conversation log" },
  { value: "console", label: "Console", description: "Operator console with top telemetry and a bottom command deck" },
] as const

export type LayoutLiveState = {
  context?: { tokens: number; window: number }
  costUsd?: number
  cwd: string
  layout: TerminalLayout
  mode: "agent" | "plan"
  model: string
  themeName: string
  title: string
  version: string
}

type LayoutStateReader = () => LayoutLiveState

function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`
  if (value >= 1000) return `${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 1)}K`
  return String(value)
}

function horizontalRule(width: number, left = "", fill = "─", right = ""): string {
  return left + fill.repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(right))) + right
}

function rightAligned(left: string, right: string, width: number): string {
  const clippedRight = truncateToWidth(right, width, "…")
  const available = Math.max(0, width - visibleWidth(clippedRight) - (left ? 1 : 0))
  const clippedLeft = truncateToWidth(left, available, "…")
  const gap = Math.max(0, width - visibleWidth(clippedLeft) - visibleWidth(clippedRight))
  return clippedLeft + " ".repeat(gap) + clippedRight
}

function contextLabel(state: LayoutLiveState): string {
  if (!state.context || state.context.window <= 0) return "ctx —"
  const percent = Math.round((state.context.tokens / state.context.window) * 100)
  return `ctx ${percent}%`
}

function centered(content: string, width: number): string {
  const clipped = truncateToWidth(content, width, "…")
  return " ".repeat(Math.max(0, Math.floor((width - visibleWidth(clipped)) / 2))) + clipped
}

const ASCII_WIDE = [
  "███████╗██╗   ██╗██████╗ ███╗   ██╗███████╗ ██████╗███████╗",
  "██╔════╝██║   ██║██╔══██╗████╗  ██║██╔════╝██╔════╝██╔════╝",
  "█████╗  ██║   ██║██████╔╝██╔██╗ ██║███████╗██║     █████╗  ",
  "██╔══╝  ██║   ██║██╔══██╗██║╚██╗██║██╔══██║██║     ██╔══╝  ",
  "██║     ╚██████╔╝██║  ██║██║ ╚████║██║  ██║╚██████╗███████╗",
  "╚═╝      ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝ ╚═════╝╚══════╝",
]

function asciiMark(width: number): string[] {
  if (width >= 65) return ASCII_WIDE.map((row) => theme.bold(theme.fg("accent", row)))
  return [theme.bold(theme.fg("accent", "FURNACE"))]
}

export class LayoutHeaderComponent implements Component {
  private expanded = false

  constructor(private readonly readState: LayoutStateReader) {}

  invalidate(): void {}

  setExpanded(expanded: boolean): void {
    this.expanded = expanded
  }

  render(width: number): string[] {
    const state = this.readState()
    switch (state.layout) {
      case "console":
        return [
          "",
          ...asciiMark(width),
          "",
          theme.fg("accent", horizontalRule(width, "╔═[ OPERATOR CONSOLE ]", "═", "╗")),
          rightAligned(
            theme.fg("muted", `║ ${state.cwd}`),
            theme.fg("accent", `${state.mode.toUpperCase()} ║`),
            width,
          ),
        ]
      case "notebook":
        return [
          "",
          ...asciiMark(width),
          rightAligned(theme.fg("dim", `v${state.version}`), theme.fg("dim", `№ ${state.title}`), width),
          "",
        ]
      case "classic":
      default: {
        const mark = asciiMark(width).map((row) => ` ${row}`)
        const hints = this.expanded
          ? ["ctrl+c interrupt / clear", "ctrl+d exit", "ctrl+o expand tools", "/ commands", "drop files to attach"]
          : ["ctrl+c interrupt · / commands · ctrl+o more"]
        return ["", ...mark, "", ` ${theme.fg("dim", `v${state.version}`)}`, ...hints.map((hint) => ` ${theme.fg("muted", hint)}`), ""]
      }
    }
  }
}

export class LayoutTranscriptSurface extends Container {
  constructor(
    private readonly transcript: Component,
    private readonly readState: LayoutStateReader,
  ) {
    super()
    this.addChild(transcript)
  }

  override render(width: number): string[] {
    const lines = this.transcript.render(width)
    if (lines.length > 0) return lines
    const state = this.readState()
    switch (state.layout) {
      case "console":
        return [
          theme.fg("dim", "[00:00:00] BOOT  runtime initialized"),
          theme.fg("success", "[00:00:01] READY awaiting operator input"),
          theme.fg("dim", `[workspace] ${state.cwd}`),
          "",
        ]
      case "notebook":
        return [
          "",
          theme.fg("dim", "ENTRY 00"),
          theme.fg("border", horizontalRule(width, "", "─")),
          theme.fg("muted", "This field note is empty. Write the first instruction below."),
          "",
        ]
      case "classic":
      default:
        return [
          theme.fg("dim", " Ready when you are — describe a task, ask a question, or type / for commands."),
          "",
        ]
    }
  }
}

export type TranscriptItemKind = "assistant" | "tool" | "user"

export class LayoutTranscriptItem extends Container {
  constructor(
    private readonly content: Component,
    private readonly kind: TranscriptItemKind,
    private readonly readLayout: () => TerminalLayout,
  ) {
    super()
    this.addChild(content)
  }

  setExpanded(expanded: boolean): void {
    const candidate = this.content as Component & { setExpanded?: (value: boolean) => void }
    candidate.setExpanded?.(expanded)
  }

  override render(width: number): string[] {
    const layout = this.readLayout()
    const inset = layout === "console" ? 2 : 0
    const lines = this.content.render(Math.max(1, width - inset))

    if (layout === "classic") return lines

    if (layout === "notebook") {
      const label = this.kind === "user" ? "YOU" : this.kind === "assistant" ? "FURNACE" : "TOOL LOG"
      return [
        theme.fg("dim", horizontalRule(width, "", "·")),
        theme.bold(theme.fg(this.kind === "user" ? "accent" : "muted", label)),
        ...lines,
      ]
    }

    if (layout === "console") {
      const label = this.kind === "user" ? "INPUT" : this.kind === "assistant" ? "OUTPUT" : "PROCESS"
      return [
        theme.fg("border", `├─ ${label}`),
        ...lines.map((line) => `${theme.fg("border", "│")} ${line}`),
      ]
    }

    return lines
  }
}
