import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"
import { execSync } from "node:child_process"
import { relative, resolve, sep } from "node:path"
import { fgColor } from "./messages.js"
import type { Theme } from "../themes/types.js"

export type FooterData = {
  cwd: string
  gitBranch?: string
  sessionName?: string
  inputTokens: number
  outputTokens: number
  costUsd: number
  contextTokens: number
  contextWindow: number
  contextPercent: number | null
  model: string
  lofi?: boolean
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString()
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`
  if (count < 1000000) return `${Math.round(count / 1000)}k`
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`
  return `${Math.round(count / 1000000)}M`
}

export function getCurrentGitBranch(cwd: string): string | undefined {
  try {
    const branch = execSync("git branch --show-current", {
      cwd,
      encoding: "utf-8",
      timeout: 500,
      stdio: ["pipe", "pipe", "ignore"],
    }).trim()
    return branch || undefined
  } catch {
    return undefined
  }
}

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
  if (!home) return cwd
  const resolvedCwd = resolve(cwd)
  const resolvedHome = resolve(home)
  const relativeToHome = relative(resolvedHome, resolvedCwd)
  if (relativeToHome === "") return "~"
  if (!relativeToHome.startsWith("..") && !relativeToHome.startsWith("/")) return `~${sep}${relativeToHome}`
  return cwd
}

export class FooterComponent implements Component {
  private data: FooterData
  private theme: Theme

  constructor(data: FooterData, theme: Theme) {
    this.data = data
    this.theme = theme
  }

  setData(data: FooterData): void {
    this.data = data
  }

  setTheme(theme: Theme): void {
    this.theme = theme
  }

  invalidate(): void {
    // No-op: footer re-renders from latest data on each render call.
  }

  render(width: number): string[] {
    const c = this.theme.colors
    const dim = (text: string) => fgColor(c.mutedForeground)(text)

    let pwd = formatCwdForFooter(this.data.cwd, process.env.HOME || process.env.USERPROFILE)
    if (this.data.gitBranch) {
      pwd = `${pwd} (${this.data.gitBranch})`
    }
    if (this.data.sessionName) {
      pwd = `${pwd} • ${this.data.sessionName}`
    }

    const statsParts: string[] = []
    if (this.data.inputTokens > 0) statsParts.push(`↑${formatTokens(this.data.inputTokens)}`)
    if (this.data.outputTokens > 0) statsParts.push(`↓${formatTokens(this.data.outputTokens)}`)
    if (this.data.costUsd > 0) statsParts.push(`$${this.data.costUsd.toFixed(4)}`)
    if (this.data.lofi) statsParts.push("lofi")

    const contextPercent = this.data.contextPercent ?? null
    const contextWindow = this.data.contextWindow || 0
    const contextText = contextPercent === null ? `?/${formatTokens(contextWindow)}` : `${contextPercent.toFixed(1)}%/${formatTokens(contextWindow)}`
    if (contextPercent !== null && contextPercent > 90) {
      statsParts.push(fgColor(c.error)(contextText))
    } else if (contextPercent !== null && contextPercent > 70) {
      statsParts.push(fgColor(c.warning)(contextText))
    } else {
      statsParts.push(dim(contextText))
    }

    let statsLeft = statsParts.join(" ")
    let statsLeftWidth = visibleWidth(statsLeft)
    if (statsLeftWidth > width) {
      statsLeft = truncateToWidth(statsLeft, width, "...")
      statsLeftWidth = visibleWidth(statsLeft)
    }

    const rightSide = this.data.model
    const rightSideWidth = visibleWidth(rightSide)
    const minPadding = 2
    const totalNeeded = statsLeftWidth + minPadding + rightSideWidth

    let statsLine: string
    if (totalNeeded <= width) {
      const padding = " ".repeat(width - statsLeftWidth - rightSideWidth)
      statsLine = statsLeft + padding + rightSide
    } else {
      const availableForRight = width - statsLeftWidth - minPadding
      if (availableForRight > 0) {
        const truncatedRight = truncateToWidth(rightSide, availableForRight, "")
        const truncatedRightWidth = visibleWidth(truncatedRight)
        const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth))
        statsLine = statsLeft + padding + truncatedRight
      } else {
        statsLine = statsLeft
      }
    }

    const pwdLine = truncateToWidth(dim(pwd), width, dim("..."))
    return [pwdLine, dim(statsLine)]
  }
}
