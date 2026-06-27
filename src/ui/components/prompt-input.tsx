import { Box, Text, useInput, usePaste } from "ink"
import * as React from "react"

import { useTheme } from "./theme-provider.js"

export type PromptInputProps = {
  active?: boolean
  autocompleteItems?: PromptAutocompleteItem[]
  busy?: boolean
  disabled?: boolean
  historyItems?: string[]
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
  historyItems = [],
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
  const [historyIndex, setHistoryIndex] = React.useState(-1)
  const historySavedDraft = React.useRef("")
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

  React.useEffect(() => {
    setHistoryIndex(-1)
    historySavedDraft.current = ""
  }, [historyItems])

  usePaste((pastedText) => {
    if (!enabled) return
    const sanitized = pastedText.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
    setValue((current) => current.slice(0, cursorOffset) + sanitized + current.slice(cursorOffset))
    setCursorOffset((current) => current + sanitized.length)
  })

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
    if (key.ctrl) {
      if (input === "a") {
        setCursorOffset(0)
        return
      }
      if (input === "e") {
        setCursorOffset(value.length)
        return
      }
      if (input === "k") {
        setValue((current) => current.slice(0, cursorOffset))
        return
      }
      if (input === "u") {
        setValue((current) => current.slice(cursorOffset))
        setCursorOffset(0)
        return
      }
      if (input === "w") {
        // delete word backwards from cursor
        const before = value.slice(0, cursorOffset)
        const trimmed = before.trimEnd()
        const lastSpace = trimmed.lastIndexOf(" ")
        const newCursor = lastSpace < 0 ? 0 : lastSpace + 1
        setValue((current) => current.slice(0, newCursor) + current.slice(cursorOffset))
        setCursorOffset(newCursor)
        return
      }
      return
    }
    if (key.meta) return

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

    if (historyItems.length > 0 && value.length === 0 && key.upArrow && historyIndex === -1) {
      historySavedDraft.current = ""
      setHistoryIndex(0)
      setValue(historyItems[0])
      setCursorOffset(historyItems[0].length)
      return
    }

    if (historyIndex >= 0) {
      if (key.upArrow) {
        if (historyIndex < historyItems.length - 1) {
          const next = historyIndex + 1
          setHistoryIndex(next)
          setValue(historyItems[next])
          setCursorOffset(historyItems[next].length)
        } else {
          onEmptyUp?.()
        }
        return
      }
      if (key.downArrow) {
        if (historyIndex > 0) {
          const next = historyIndex - 1
          setHistoryIndex(next)
          setValue(historyItems[next])
          setCursorOffset(historyItems[next].length)
        } else {
          setHistoryIndex(-1)
          setValue(historySavedDraft.current)
          setCursorOffset(historySavedDraft.current.length)
        }
        return
      }
      if (key.escape) {
        setHistoryIndex(-1)
        setValue(historySavedDraft.current)
        setCursorOffset(historySavedDraft.current.length)
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
      setHistoryIndex(-1)
      historySavedDraft.current = ""
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
        <Box key={item.value}>
          <Box flexShrink={0} minWidth={28}>
            <Text color={item.selected ? theme.colors.primary : theme.colors.foreground} bold={item.selected} wrap="truncate">
              {item.selected ? "› " : "  "}{item.label}
            </Text>
          </Box>
          {item.description ? (
            <Text color={theme.colors.mutedForeground} wrap="truncate">
              {"  "}{item.description}
            </Text>
          ) : null}
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
  const tokenStart = cursorOffset - token.length
  return `${value.slice(0, tokenStart)}${insertText}${value.slice(cursorOffset)}`
}

function slashAutocompleteToken(value: string, cursorOffset: number): string | undefined {
  if (cursorOffset < 1) return undefined
  const beforeCursor = value.slice(0, cursorOffset)
  const afterCursor = value.slice(cursorOffset)
  if (afterCursor.trim()) return undefined
  // Find the last '/' that is at start of string or preceded by whitespace
  let slashIndex = -1
  for (let i = beforeCursor.length - 1; i >= 0; i--) {
    if (beforeCursor[i] === "/" && (i === 0 || /\s/.test(beforeCursor[i - 1]))) {
      slashIndex = i
      break
    }
  }
  if (slashIndex < 0) return undefined
  return beforeCursor.slice(slashIndex)
}

export function lofiChibiFrame(tick: number): string {
  return tick % 2 === 0 ? "♪ (˶ᵔ ᵕ ᵔ˶)╯╲" : "♪ (˶ᵔ ᵕ ᵔ˶)╮╱"
}
