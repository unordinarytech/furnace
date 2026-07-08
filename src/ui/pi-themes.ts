import chalk, { type ChalkInstance } from "chalk"
import type {
  EditorTheme,
  MarkdownTheme,
  SelectListTheme,
  SettingsListTheme,
} from "@earendil-works/pi-tui"
import type { Theme } from "./components/theme-provider.js"

function hexToRgb(hex: string): { b: number; g: number; r: number } | undefined {
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

function fgColor(hex: string): ChalkInstance {
  const rgb = hexToRgb(hex)
  if (!rgb) return chalk
  return chalk.rgb(rgb.r, rgb.g, rgb.b)
}

function bgColor(hex: string): ChalkInstance {
  const rgb = hexToRgb(hex)
  if (!rgb) return chalk
  return chalk.bgRgb(rgb.r, rgb.g, rgb.b)
}

function colorFn(color: string): (text: string) => string {
  return (text) => fgColor(color)(text)
}

function colorFnPreserveReset(color: string): (text: string) => string {
  const c = fgColor(color)
  return (text) => {
    const reset = "\x1b[0m"
    return c(text).replace(new RegExp(`${reset}$`), "") + reset
  }
}

export function getPiMarkdownTheme(theme: Theme): MarkdownTheme {
  const c = theme.colors
  return {
    bold: colorFn(c.accent),
    code: colorFn(c.accent),
    codeBlock: colorFn(c.foreground),
    codeBlockBorder: colorFn(c.border),
    codeBlockIndent: "  ",
    heading: colorFn(c.primary),
    highlightCode: (code, _lang) => [colorFn(c.accent)(code)],
    hr: colorFn(c.border),
    italic: colorFn(c.mutedForeground),
    link: colorFn(c.info),
    linkUrl: colorFn(c.mutedForeground),
    listBullet: colorFn(c.accent),
    quote: colorFn(c.mutedForeground),
    quoteBorder: colorFn(c.border),
    strikethrough: colorFn(c.mutedForeground),
    underline: colorFn(c.info),
  }
}

export function getPiSelectListTheme(theme: Theme): SelectListTheme {
  const c = theme.colors
  return {
    description: colorFn(c.mutedForeground),
    noMatch: colorFn(c.error),
    scrollInfo: colorFn(c.mutedForeground),
    selectedPrefix: (text) => fgColor(c.accent)(text),
    selectedText: (text) => fgColor(c.accent)(text),
  }
}

export function getPiEditorTheme(theme: Theme): EditorTheme {
  return {
    borderColor: colorFn(theme.colors.border),
    selectList: getPiSelectListTheme(theme),
  }
}

export function getPiSettingsListTheme(theme: Theme): SettingsListTheme {
  const c = theme.colors
  return {
    cursor: ">",
    description: colorFn(c.mutedForeground),
    hint: colorFn(c.mutedForeground),
    label: (text, selected) => (selected ? fgColor(c.accent)(text) : fgColor(c.foreground)(text)),
    value: (text, selected) => (selected ? fgColor(c.accent)(text) : fgColor(c.mutedForeground)(text)),
  }
}

export function getPiUserMessageStyle(theme: Theme): {
  bg: (text: string) => string
  text: (text: string) => string
} {
  return {
    bg: (text) => bgColor(theme.colors.muted)(text),
    text: colorFn(theme.colors.foreground),
  }
}

export function getPiAssistantMessageStyle(theme: Theme): {
  text: (text: string) => string
} {
  return {
    text: colorFn(theme.colors.foreground),
  }
}

export function getPiStatusStyle(theme: Theme): {
  dim: (text: string) => string
  error: (text: string) => string
  info: (text: string) => string
  success: (text: string) => string
  warning: (text: string) => string
} {
  const c = theme.colors
  return {
    dim: colorFn(c.mutedForeground),
    error: colorFn(c.error),
    info: colorFn(c.info),
    success: colorFn(c.success),
    warning: colorFn(c.warning),
  }
}

export function getPiBorderColor(theme: Theme): (text: string) => string {
  return colorFn(theme.colors.border)
}

export function getPiToolActivityStyle(theme: Theme): {
  borderDone: (text: string) => string
  borderFailed: (text: string) => string
  borderRunning: (text: string) => string
  title: (text: string) => string
} {
  const c = theme.colors
  return {
    borderDone: colorFn(c.success),
    borderFailed: colorFn(c.error),
    borderRunning: colorFn(c.mutedForeground),
    title: colorFn(c.foreground),
  }
}
