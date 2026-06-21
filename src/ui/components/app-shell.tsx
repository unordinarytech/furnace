import { Box, Text, useWindowSize } from "ink"
import * as React from "react"

import { useTheme } from "./theme-provider.js"

export type AppShellProps = {
  children: React.ReactNode
}

export type AppShellHeaderProps = {
  cwd: string
  model: string
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
  const { columns, rows } = useWindowSize()
  return (
    <Box flexDirection="column" height={rows} width={columns}>
      {children}
    </Box>
  )
}

function Header({ cwd, model, settings, title }: AppShellHeaderProps): React.ReactNode {
  const theme = useTheme()
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.colors.border} paddingX={1}>
      <Box justifyContent="space-between">
        <Text color={theme.colors.primary} bold>
          Furnace
        </Text>
        <Text color={theme.colors.mutedForeground}>{model}</Text>
      </Box>
      <Box justifyContent="space-between">
        <Text color={theme.colors.foreground}>{truncateMiddle(`${cwd} · ${title}`, 96)}</Text>
        <Text color={theme.colors.mutedForeground}>0.0%/{settings}</Text>
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
    <Box borderStyle="single" borderColor={theme.colors.mutedForeground} paddingX={1}>
      <Text color={theme.colors.mutedForeground}>{text}</Text>
    </Box>
  )
}

AppShell.Header = Header
AppShell.Content = Content
AppShell.Hints = Hints

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  if (maxLength <= 1) return value.slice(0, maxLength)
  const keep = maxLength - 1
  const left = Math.ceil(keep / 2)
  const right = Math.floor(keep / 2)
  return `${value.slice(0, left)}…${value.slice(value.length - right)}`
}

function truncateEnd(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  if (maxLength <= 3) return value.slice(0, maxLength)
  return `${value.slice(0, maxLength - 3)}...`
}
