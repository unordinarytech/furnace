import { Box, Text, useWindowSize } from "ink"
import * as React from "react"

import { truncateEnd, truncateMiddle } from "../utils.js"
import { useTheme } from "./theme-provider.js"

export type AppShellProps = {
  children: React.ReactNode
}

export type AppShellHeaderProps = {
  contextUsage?: string
  cwd: string
  model: string
  status?: string
  settings: string
  title: string
}

export type AppShellContentProps = {
  children: React.ReactNode
}

export type AppShellHintsProps = {
  items: string[]
}

export function AppShell({ children }: AppShellProps): React.ReactNode {
  const { columns } = useWindowSize()
  return (
    <Box flexDirection="column" width={columns}>
      {children}
    </Box>
  )
}

function Header({ contextUsage, cwd, model, settings, status, title }: AppShellHeaderProps): React.ReactNode {
  const theme = useTheme()
  const { columns } = useWindowSize()
  const modelText = truncateMiddle(model, Math.max(1, columns - "Furnace".length - 8))
  const statusText = contextUsage ? `${contextUsage} · ${settings}` : truncateEnd(`${status ?? ""} · ${settings}`, 80)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.colors.border} paddingX={1} width={columns}>
      <Box justifyContent="space-between">
        <Text color={theme.colors.primary} bold>
          Furnace
        </Text>
        <Text color={theme.colors.mutedForeground}>{modelText}</Text>
      </Box>
      <Box justifyContent="space-between">
        <Text color={theme.colors.foreground}>{truncateMiddle(`${cwd} · ${title}`, 96)}</Text>
        <Text color={theme.colors.mutedForeground}>{statusText}</Text>
      </Box>
    </Box>
  )
}

function Content({ children }: AppShellContentProps): React.ReactNode {
  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {children}
    </Box>
  )
}

function Hints({ items }: AppShellHintsProps): React.ReactNode {
  const theme = useTheme()
  const { columns } = useWindowSize()
  const text = truncateEnd(items.join("  ·  "), Math.max(1, columns - 4))
  return (
    <Box borderStyle="single" borderColor={theme.colors.mutedForeground} paddingX={1} width={columns}>
      <Text color={theme.colors.mutedForeground}>{text}</Text>
    </Box>
  )
}

AppShell.Header = Header
AppShell.Content = Content
AppShell.Hints = Hints
