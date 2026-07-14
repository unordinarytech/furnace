import { Container } from "@earendil-works/pi-tui"
import type { TerminalLayout } from "../../preferences.js"
import { CustomEditor } from "./components/custom-editor.js"
import { moonSurface } from "./layouts.js"
import { theme } from "./theme.js"

const STRIP_ANSI_RE = /\x1b(?:\[[^m]*m|_[^\x07]*\x07)/g

export class LayoutEditorFrame extends Container {
  private readonly inner: CustomEditor

  constructor(
    editor: CustomEditor,
    private readonly readLayout: () => TerminalLayout,
  ) {
    super()
    this.addChild(editor)
    this.inner = editor
  }

  override render(width: number): string[] {
    const layout = this.readLayout()
    if (layout === "notebook") {
      const lines = this.inner.render(Math.max(1, width))
      const content = lines.filter((line) => !/^─+$/.test(stripAnsi(line)))
      return [
        theme.fg("border", "─".repeat(Math.max(1, width))),
        ...content,
      ]
    }

    if (layout === "asteroid") {
      const innerWidth = Math.max(1, width - 4)
      const lines = this.inner.render(innerWidth)
      const content = lines.filter((line) => !/^─+$/.test(stripAnsi(line)))
      return [
        moonSurface(width),
        ...content.map((line) => `${theme.fg("dim", "│")} ${line} ${theme.fg("dim", "│")}`),
        moonSurface(width),
      ]
    }

    const innerWidth = Math.max(1, width - 4)
    const lines = this.inner.render(innerWidth)
    const content = lines.filter((line) => !/^─+$/.test(stripAnsi(line)))

    const frames: Record<Exclude<TerminalLayout, "notebook" | "asteroid">, {
      bottom: string
      label: string
      left: string
      right: string
      rightLabel: string
      top: string
    }> = {
      classic: { top: "╭", bottom: "╰", left: "│", right: "│", label: "", rightLabel: "" },
      console: { top: "╠", bottom: "╚", left: "║", right: "║", label: " >_ PROMPT ", rightLabel: " EXECUTE " },
    }
    const frame = frames[layout] ?? frames.classic
    const topRight = frame.top === "╭" ? "╮" : frame.top === "╠" ? "╣" : "┐"
    const leftLabel = width >= frame.label.length + 6 ? frame.label : ""
    const rightLabel = width >= frame.label.length + frame.rightLabel.length + 8 ? frame.rightLabel : ""
    const topDecoration = leftLabel || rightLabel
      ? `─${leftLabel}${"─".repeat(Math.max(0, width - 4 - leftLabel.length - rightLabel.length))}${rightLabel}─`
      : "─".repeat(Math.max(0, width - 2))
    const top = frame.top + topDecoration + topRight
    const bottomRight = frame.bottom === "╰" ? "╯" : frame.bottom === "╚" ? "╝" : "┘"
    const bottom = frame.bottom + "─".repeat(Math.max(0, width - 2)) + bottomRight
    return [
      theme.fg("border", top),
      ...content.map((line) => `${theme.fg("border", frame.left)} ${line} ${theme.fg("border", frame.right)}`),
      theme.fg("border", bottom),
    ]
  }
}

function stripAnsi(value: string): string {
  return value.replace(STRIP_ANSI_RE, "")
}
