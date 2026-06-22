import { Box, Text, useInput } from "ink"
import * as React from "react"

import { useTheme } from "./theme-provider.js"

export type PromptInputProps = {
  active?: boolean
  autocompleteItems?: PromptAutocompleteItem[]
  busy?: boolean
  disabled?: boolean
  onChange?: (value: string) => void
  onEmptyUp?: () => void
  onModeCycle?: (direction: 1 | -1) => void
  onSubmit: (value: string) => void
  placeholder?: string
  prefix?: string
  value?: string
}

export type PromptAutocompleteItem = {
  description?: string
  insertText?: string
  label: string
  value: string
}

export type PromptAutocompleteMatch = PromptAutocompleteItem & {
  selected: boolean
}

export function PromptInput({
  active = true,
  autocompleteItems = [],
  busy = false,
  disabled = false,
  onChange,
  onEmptyUp,
  onModeCycle,
  onSubmit,
  placeholder = "Ask Furnace...",
  prefix = ">",
  value: controlledValue,
}: PromptInputProps): React.ReactNode {
  const theme = useTheme()
  const [localValue, setLocalValue] = React.useState("")
  const [cursorOffset, setCursorOffset] = React.useState(0)
  const [selectedAutocompleteIndex, setSelectedAutocompleteIndex] = React.useState(0)
  const previousControlledValue = React.useRef(controlledValue)
  const value = controlledValue ?? localValue
  const enabled = active && !disabled
  const autocompleteMatches = slashAutocompleteMatches(value, cursorOffset, autocompleteItems, selectedAutocompleteIndex)
  const autocompleteActive = enabled && autocompleteMatches.length > 0

  const setValue = React.useCallback(
    (next: string | ((current: string) => string)) => {
      const resolved = typeof next === "function" ? next(value) : next
      if (controlledValue === undefined) setLocalValue(resolved)
      onChange?.(resolved)
    },
    [controlledValue, onChange, value],
  )

  React.useEffect(() => {
    setCursorOffset((current) => Math.min(current, value.length))
  }, [value.length])

  React.useEffect(() => {
    if (controlledValue === undefined || previousControlledValue.current === controlledValue) return
    previousControlledValue.current = controlledValue
    setCursorOffset(controlledValue.length)
  }, [controlledValue])

  React.useEffect(() => {
    setSelectedAutocompleteIndex(0)
  }, [autocompleteItems, value])

  useInput((input, key) => {
    if (!enabled) return
    const reverseTab = input === "\u001b[Z"
    if (reverseTab) {
      onModeCycle?.(-1)
      return
    }
    if (key.tab && !autocompleteActive) {
      const shifted = Boolean((key as { shift?: boolean }).shift)
      onModeCycle?.(shifted ? -1 : 1)
      return
    }
    if (key.ctrl || key.meta) return

    if (autocompleteActive) {
      if (key.escape) {
        setValue("")
        setSelectedAutocompleteIndex(0)
        setCursorOffset(0)
        return
      }
      if (key.upArrow) {
        setSelectedAutocompleteIndex((current) => Math.max(0, current - 1))
        return
      }
      if (key.downArrow) {
        setSelectedAutocompleteIndex((current) => Math.min(autocompleteMatches.length - 1, current + 1))
        return
      }
      if (key.tab || key.return) {
        const next = applySlashAutocomplete(value, cursorOffset, autocompleteMatches[selectedAutocompleteIndex])
        setValue(next)
        setCursorOffset(next.length)
        return
      }
    }

    if (key.upArrow && value.length === 0) {
      onEmptyUp?.()
      return
    }

    if (key.return) {
      const submitted = value.trim()
      if (!submitted) return
      setValue("")
      setCursorOffset(0)
      onSubmit(submitted)
      return
    }

    if (key.leftArrow) {
      setCursorOffset((current) => Math.max(0, current - 1))
      return
    }
    if (key.rightArrow) {
      setCursorOffset((current) => Math.min(value.length, current + 1))
      return
    }
    if (key.home) {
      setCursorOffset(0)
      return
    }
    if (key.end) {
      setCursorOffset(value.length)
      return
    }
    if (key.backspace || key.delete) {
      if (cursorOffset === 0) return
      setValue((current) => current.slice(0, cursorOffset - 1) + current.slice(cursorOffset))
      setCursorOffset((current) => Math.max(0, current - 1))
      return
    }
    if (key.escape) {
      setValue("")
      setCursorOffset(0)
      return
    }
    if (input) {
      setValue((current) => current.slice(0, cursorOffset) + input + current.slice(cursorOffset))
      setCursorOffset((current) => current + input.length)
    }
  }, { isActive: enabled })

  const display = value || placeholder
  const before = value.slice(0, cursorOffset)
  const cursor = value[cursorOffset] ?? " "
  const after = value.slice(cursorOffset + 1)

  return (
    <>
      {autocompleteActive ? <PromptAutocompleteMenu items={autocompleteMatches} /> : null}
      <Box borderStyle="round" borderColor={enabled ? theme.colors.focusRing : theme.colors.border} paddingX={1}>
        <Text color={enabled ? theme.colors.primary : theme.colors.mutedForeground} bold>
          {prefix}{" "}
        </Text>
        {value ? (
          <Text color={theme.colors.foreground}>
            {before}
            <Text color={theme.colors.selectionForeground} backgroundColor={theme.colors.selection}>
              {cursor}
            </Text>
            {after}
          </Text>
        ) : (
          <Text color={theme.colors.mutedForeground}>
            <Text color={theme.colors.selectionForeground} backgroundColor={theme.colors.selection}>
              {display[0] ?? " "}
            </Text>
            {display.slice(1)}
          </Text>
        )}
      </Box>
    </>
  )
}

function PromptAutocompleteMenu({ items }: { items: PromptAutocompleteMatch[] }): React.ReactNode {
  const theme = useTheme()
  const window = autocompleteWindow(items)
  return (
    <Box borderStyle="round" borderColor={theme.colors.border} flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text color={theme.colors.primary} bold>Commands</Text>
        <Text color={theme.colors.mutedForeground}>tab/enter complete</Text>
      </Box>
      {window.hiddenAbove > 0 ? <Text color={theme.colors.mutedForeground}>{window.hiddenAbove} more above</Text> : null}
      {window.visible.map((item) => (
        <Box key={item.value} justifyContent="space-between">
          <Text color={item.selected ? theme.colors.primary : theme.colors.foreground} bold={item.selected}>
            {item.selected ? "› " : "  "}{item.label}
          </Text>
          {item.description ? <Text color={theme.colors.mutedForeground}> {item.description}</Text> : null}
        </Box>
      ))}
      {window.hiddenBelow > 0 ? <Text color={theme.colors.mutedForeground}>{window.hiddenBelow} more below</Text> : null}
    </Box>
  )
}

export function autocompleteWindow(items: PromptAutocompleteMatch[], maxVisible = 8): { hiddenAbove: number; hiddenBelow: number; visible: PromptAutocompleteMatch[] } {
  const selected = items.findIndex((item) => item.selected)
  const selectedIndex = selected >= 0 ? selected : 0
  const start = Math.min(Math.max(0, items.length - maxVisible), Math.max(0, selectedIndex - Math.floor(maxVisible / 2)))
  const visible = items.slice(start, start + maxVisible)
  return {
    hiddenAbove: start,
    hiddenBelow: Math.max(0, items.length - start - visible.length),
    visible,
  }
}

export function slashAutocompleteMatches(
  value: string,
  cursorOffset: number,
  items: PromptAutocompleteItem[],
  selectedIndex = 0,
): PromptAutocompleteMatch[] {
  const token = slashAutocompleteToken(value, cursorOffset)
  if (!token) return []
  const normalized = token.toLowerCase()
  const exact = items.some((item) => item.value.toLowerCase() === normalized)
  if (exact) return []
  const matches = items
    .filter((item) => item.value.toLowerCase().startsWith(normalized))
    .map((item) => ({ ...item, label: item.label || item.value }))
  return matches.map((item, index) => ({ ...item, selected: index === Math.min(Math.max(0, selectedIndex), matches.length - 1) }))
}

export function applySlashAutocomplete(value: string, cursorOffset: number, item: PromptAutocompleteItem | undefined): string {
  if (!item) return value
  const token = slashAutocompleteToken(value, cursorOffset)
  if (!token) return value
  const insertText = item.insertText || item.value
  return `${insertText}${value.slice(cursorOffset)}`
}

function slashAutocompleteToken(value: string, cursorOffset: number): string | undefined {
  if (cursorOffset < 1) return undefined
  const beforeCursor = value.slice(0, cursorOffset)
  const afterCursor = value.slice(cursorOffset)
  if (afterCursor.trim()) return undefined
  if (!beforeCursor.startsWith("/")) return undefined
  return beforeCursor
}

export function lofiChibiFrame(tick: number): string {
  return tick % 2 === 0 ? "♪ (˶ᵔ ᵕ ᵔ˶)╯╲" : "♪ (˶ᵔ ᵕ ᵔ˶)╮╱"
}
