import { Box, Container, Markdown, type MarkdownTheme } from "@earendil-works/pi-tui"
import type { Theme } from "../themes/types.js"

const OSC133_ZONE_START = "\x1b]133;A\x07"
const OSC133_ZONE_END = "\x1b]133;B\x07"
const OSC133_ZONE_FINAL = "\x1b]133;C\x07"

export function hexToRgb(hex: string): { b: number; g: number; r: number } | undefined {
  const clean = hex.replace("#", "")
  if (clean.length === 3) {
    return {
      r: Number.parseInt(clean[0]! + clean[0]!, 16),
      g: Number.parseInt(clean[1]! + clean[1]!, 16),
      b: Number.parseInt(clean[2]! + clean[2]!, 16),
    }
  }
  if (clean.length === 6) {
    return {
      r: Number.parseInt(clean.slice(0, 2), 16),
      g: Number.parseInt(clean.slice(2, 4), 16),
      b: Number.parseInt(clean.slice(4, 6), 16),
    }
  }
  return undefined
}

export function bgColor(color: string): (text: string) => string {
  return (text) => {
    const rgb = hexToRgb(color)
    if (!rgb) return text
    return `\x1b[48;2;${rgb.r};${rgb.g};${rgb.b}m${text}\x1b[0m`
  }
}

export function fgColor(color: string): (text: string) => string {
  return (text) => {
    const rgb = hexToRgb(color)
    if (!rgb) return text
    return `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m${text}\x1b[0m`
  }
}

export class UserMessageComponent extends Container {
  private text: string
  private markdownTheme: MarkdownTheme
  private background: (text: string) => string
  private textColor: (text: string) => string

  constructor(text: string, theme: Theme, markdownTheme: MarkdownTheme) {
    super()
    this.text = text
    this.markdownTheme = markdownTheme
    this.background = bgColor(theme.colors.muted)
    this.textColor = fgColor(theme.colors.foreground)
    this.rebuild()
  }

  private rebuild(): void {
    this.clear()
    const contentBox = new Box(1, 0, this.background)
    contentBox.addChild(
      new Markdown(this.text, 0, 0, this.markdownTheme, {
        color: this.textColor,
      }),
    )
    this.addChild(contentBox)
  }

  override render(width: number): string[] {
    const lines = super.render(width)
    if (lines.length === 0) return lines
    lines[0] = OSC133_ZONE_START + lines[0]
    lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1]
    return lines
  }
}

export class AssistantMessageComponent extends Container {
  private text: string
  private markdownTheme: MarkdownTheme

  constructor(text: string, markdownTheme: MarkdownTheme) {
    super()
    this.text = text
    this.markdownTheme = markdownTheme
    this.rebuild()
  }

  setText(text: string): void {
    this.text = text
    this.rebuild()
  }

  private rebuild(): void {
    this.clear()
    this.addChild(new Markdown(this.text, 0, 0, this.markdownTheme))
  }

  override render(width: number): string[] {
    const lines = super.render(width)
    if (lines.length === 0) return lines
    lines[0] = OSC133_ZONE_START + lines[0]
    lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1]
    return lines
  }
}
