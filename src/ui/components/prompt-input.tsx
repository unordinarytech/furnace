import { Box, Text, useInput, usePaste, useWindowSize } from "ink"
import * as React from "react"

import { useTheme } from "./theme-provider.js"

function truncateSidebar(str: string, max: number): string {
  return str.length > max ? str.slice(0, max - 1) + "…" : str
}

export type PromptInputProps = {
  active?: boolean
  autocompleteItems?: PromptAutocompleteItem[]
  busy?: boolean
  disabled?: boolean
  historyItems?: string[]
  inputMode?: "standard" | "vim"
  onAutocompleteTab?: (match: PromptAutocompleteMatch) => boolean
  onChange?: (value: string) => void
  onCopy?: () => void
  onEmptyDown?: () => void
  onInterrupt?: () => void
  onEmptyUp?: () => void
  onImageAttach?: () => { label: string } | undefined
  onModeCycle?: (direction: 1 | -1) => void
  onOpenEditor?: (draft: string) => Promise<string>
  onSubmit: (value: string) => void
  placeholder?: string
  planMode?: boolean
  prefix?: string
  inputOverride?: React.ReactNode
  sidebarOverride?: React.ReactNode
  splitMode?: boolean
  status?: string
  value?: string
}

export type PromptAutocompleteItem = {
  browsable?: boolean
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
  inputMode = "standard",
  onAutocompleteTab,
  onChange,
  onCopy,
  onEmptyDown,
  onInterrupt,
  onEmptyUp,
  onImageAttach,
  onModeCycle,
  onOpenEditor,
  onSubmit,
  placeholder = "Ask Furnace...",
  planMode = false,
  prefix = ">",
  inputOverride,
  sidebarOverride,
  splitMode = false,
  status,
  value: controlledValue,
}: PromptInputProps): React.ReactNode {
  const theme = useTheme()
  const [localValue, setLocalValue] = React.useState("")
  const [cursorOffset, setCursorOffset] = React.useState(0)
  const [selectedAutocompleteIndex, setSelectedAutocompleteIndex] = React.useState(0)
  const [historyIndex, setHistoryIndex] = React.useState(-1)
  const [browsableAnchor, setBrowsableAnchor] = React.useState<{ cursorOffset: number; value: string } | undefined>(undefined)
  const [historySearchActive, setHistorySearchActive] = React.useState(false)
  const [historySearchQuery, setHistorySearchQuery] = React.useState("")
  const [historySearchIndex, setHistorySearchIndex] = React.useState(0)
  const [vimMode, setVimMode] = React.useState<"normal" | "insert">("insert")
  const lastKeyRef = React.useRef<string>("")
  const historySavedDraft = React.useRef("")
  const historySearchSavedDraft = React.useRef("")

  const isVim = inputMode === "vim"
  const previousControlledValue = React.useRef(controlledValue)
  const arrowRewriteInFlight = React.useRef(false)
  const value = controlledValue ?? localValue
  const enabled = active && !disabled
  const anchorValue = browsableAnchor?.value ?? value
  const anchorCursorOffset = browsableAnchor?.cursorOffset ?? cursorOffset
  const autocompleteMatches = slashAutocompleteMatches(anchorValue, anchorCursorOffset, autocompleteItems, selectedAutocompleteIndex)
  const autocompleteActive = enabled && autocompleteMatches.length > 0
  const browsableActive = autocompleteActive && autocompleteMatches.some((item) => item.browsable)
  // In split mode, sidebar shows all items when empty, filtered matches when typing
  const sidebarItems: PromptAutocompleteItem[] = splitMode
    ? (autocompleteActive ? autocompleteMatches : [...autocompleteItems].sort((a, b) => a.label.localeCompare(b.label)))
    : []

  const setValue = React.useCallback(
    (next: string | ((current: string) => string)) => {
      const resolved = typeof next === "function" ? next(value) : next
      if (controlledValue === undefined) setLocalValue(resolved)
      onChange?.(resolved)
    },
    [controlledValue, onChange, value],
  )

  const cursorOffsetRef = React.useRef(cursorOffset)
  cursorOffsetRef.current = cursorOffset

  const triggerImageAttach = React.useCallback(() => {
    if (!onImageAttach) return
    const resolved = onImageAttach()
    if (!resolved) return
    const token = `[Image #${resolved.label}] `
    const insertAt = cursorOffsetRef.current
    setValue((current) => current.slice(0, insertAt) + token + current.slice(insertAt))
    setCursorOffset(insertAt + token.length)
  }, [onImageAttach, setValue])

  React.useEffect(() => {
    setCursorOffset((current) => Math.min(current, value.length))
  }, [value.length])

  React.useEffect(() => {
    if (controlledValue === undefined || previousControlledValue.current === controlledValue) return
    previousControlledValue.current = controlledValue
    setCursorOffset(controlledValue.length)
  }, [controlledValue])

  React.useEffect(() => {
    if (arrowRewriteInFlight.current) {
      arrowRewriteInFlight.current = false
      return
    }
    setBrowsableAnchor({ cursorOffset, value })
    setSelectedAutocompleteIndex(0)
  }, [autocompleteItems, value])

  React.useEffect(() => {
    setHistoryIndex(-1)
    historySavedDraft.current = ""
  }, [historyItems])

  usePaste((pastedText) => {
    if (!enabled) return
    // Auto-attach clipboard images on empty paste (image-only gesture)
    const isProbablyImage = !pastedText.trim() || /^[\x00-\x08\x0e-\x1f\x7f-\x9f]+$/.test(pastedText)
    if (isProbablyImage && onImageAttach) {
      triggerImageAttach()
      return
    }
    const sanitized = pastedText.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
    setValue((current) => current.slice(0, cursorOffset) + sanitized + current.slice(cursorOffset))
    setCursorOffset((current) => current + sanitized.length)
  })

  useInput((input, key) => {
    if (!enabled) return
    // Ctrl+V / Alt+V (Escape+V): explicit image paste fallback for terminals
    // that don't emit a bracketed paste event when the clipboard holds only
    // an image (e.g. Terminal.app). Plain "v" must remain normal text input.
    if (((key.ctrl || key.meta) && input === "v") && onImageAttach) {
      triggerImageAttach()
      return
    }
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
      if (input === "j") {
        // Ctrl+J: insert a literal newline without submitting
        setValue((current) => current.slice(0, cursorOffset) + "\n" + current.slice(cursorOffset))
        setCursorOffset((current) => current + 1)
        return
      }
      if (input === "r") {
        // Ctrl+R: activate history fuzzy search
        if (historyItems.length > 0 && !historySearchActive) {
          historySearchSavedDraft.current = value
          setHistorySearchActive(true)
          setHistorySearchQuery("")
          setHistorySearchIndex(0)
        }
        return
      }
      if (input === "g") {
        // Ctrl+G: open $EDITOR to compose the prompt
        if (onOpenEditor && !busy) {
          void onOpenEditor(value).then((result) => {
            setValue(result)
            setCursorOffset(result.length)
          })
        }
        return
      }
      if (input === "o") {
        // Ctrl+O: copy last assistant response to clipboard
        onCopy?.()
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

    if (historySearchActive) {
      const filteredHistory = historyItems.filter((item) => item.toLowerCase().includes(historySearchQuery.toLowerCase()))
      if (key.escape) {
        setHistorySearchActive(false)
        setHistorySearchQuery("")
        setValue(historySearchSavedDraft.current)
        setCursorOffset(historySearchSavedDraft.current.length)
        return
      }
      if (key.return) {
        const selected = filteredHistory[historySearchIndex]
        setHistorySearchActive(false)
        setHistorySearchQuery("")
        if (selected !== undefined) {
          setValue(selected)
          setCursorOffset(selected.length)
        }
        return
      }
      if (key.upArrow || key.downArrow) {
        const direction = key.upArrow ? -1 : 1
        setHistorySearchIndex((i) => Math.min(Math.max(0, i + direction), Math.max(0, filteredHistory.length - 1)))
        return
      }
      if (key.backspace || key.delete) {
        setHistorySearchQuery((q) => q.slice(0, -1))
        setHistorySearchIndex(0)
        return
      }
      if (input && !key.ctrl && !key.meta) {
        setHistorySearchQuery((q) => q + input)
        setHistorySearchIndex(0)
        return
      }
      return
    }

    // Split mode: up/down always navigates the sidebar; Tab inserts selected sidebar item
    if (splitMode && (key.upArrow || key.downArrow)) {
      const direction = key.upArrow ? -1 : 1
      setSelectedAutocompleteIndex((prev) => Math.max(0, Math.min(sidebarItems.length - 1, prev + direction)))
      return
    }
    if (splitMode && key.tab && sidebarItems.length > 0) {
      const item = sidebarItems[selectedAutocompleteIndex] ?? sidebarItems[0]
      if (item) {
        const insertText = item.insertText ?? item.value
        const next = value === "" ? insertText + " " : applySlashAutocomplete(value, cursorOffset, { ...item, selected: false } as PromptAutocompleteMatch)
        setValue(next)
        setCursorOffset(next.length)
      }
      return
    }

    if (autocompleteActive) {
      if (key.escape) {
        setValue("")
        setSelectedAutocompleteIndex(0)
        setCursorOffset(0)
        setBrowsableAnchor(undefined)
        return
      }
      if (key.upArrow || key.downArrow) {
        const direction = key.upArrow ? -1 : 1
        const nextIndex = Math.min(autocompleteMatches.length - 1, Math.max(0, selectedAutocompleteIndex + direction))
        if (browsableActive) {
          const match = autocompleteMatches[nextIndex]
          if (match) {
            const next = applySlashAutocomplete(anchorValue, anchorCursorOffset, match)
            arrowRewriteInFlight.current = true
            setValue(next)
            setCursorOffset(next.length)
          }
        }
        setSelectedAutocompleteIndex(nextIndex)
        return
      }
      if (key.tab || key.return) {
        const match = autocompleteMatches[selectedAutocompleteIndex]
        if (key.tab && browsableActive && onAutocompleteTab?.(match)) return
        const next = applySlashAutocomplete(value, cursorOffset, match)
        if (key.return && browsableActive) {
          setValue("")
          setCursorOffset(0)
          setBrowsableAnchor(undefined)
          onSubmit(next.trim())
          return
        }
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

    if (key.downArrow && value.length === 0 && !autocompleteActive) {
      onEmptyDown?.()
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
      if (isVim && vimMode === "insert") {
        setVimMode("normal")
        return
      }
      if (busy) {
        onInterrupt?.()
        return
      }
      setValue("")
      setCursorOffset(0)
      return
    }
    if (isVim && vimMode === "normal") {
      const last = lastKeyRef.current
      lastKeyRef.current = input
      if (input === "h") { setCursorOffset((c) => Math.max(0, c - 1)); return }
      if (input === "l") { setCursorOffset((c) => Math.min(value.length, c + 1)); return }
      if (input === "i") { setVimMode("insert"); return }
      if (input === "a") { setCursorOffset((c) => Math.min(value.length, c + 1)); setVimMode("insert"); return }
      if (input === "x") {
        if (cursorOffset < value.length) {
          setValue((v) => v.slice(0, cursorOffset) + v.slice(cursorOffset + 1))
        }
        return
      }
      if (input === "d" && last === "d") {
        setValue("")
        setCursorOffset(0)
        lastKeyRef.current = ""
        return
      }
      if (input === "0") { setCursorOffset(0); return }
      if (input === "$") { setCursorOffset(value.length); return }
      if (input === "w") {
        const after = value.slice(cursorOffset)
        const match = after.match(/^[^ ]*[ ]+/)
        setCursorOffset((c) => c + (match ? match[0].length : after.length))
        return
      }
      if (input === "b") {
        const before = value.slice(0, cursorOffset)
        const trimmed = before.trimEnd()
        const lastSpace = trimmed.lastIndexOf(" ")
        setCursorOffset(lastSpace < 0 ? 0 : lastSpace + 1)
        return
      }
      return
    }
    if (input) {
      if (isVim) lastKeyRef.current = ""
      setValue((current) => current.slice(0, cursorOffset) + input + current.slice(cursorOffset))
      setCursorOffset((current) => current + input.length)
    }
  }, { isActive: enabled })

  const display = value || placeholder

  // Compute per-line cursor position for multiline rendering
  const valueLines = value ? value.split("\n") : null
  let cursorLineIdx = 0
  let cursorColIdx = cursorOffset
  if (value) {
    const lines = value.split("\n")
    let remaining = cursorOffset
    for (let i = 0; i < lines.length; i++) {
      if (remaining <= lines[i].length) {
        cursorLineIdx = i
        cursorColIdx = remaining
        break
      }
      remaining -= lines[i].length + 1
    }
  }

  const { columns } = useWindowSize()

  const historySearchMatches: PromptAutocompleteMatch[] = historySearchActive
    ? historyItems
        .filter((item) => item.toLowerCase().includes(historySearchQuery.toLowerCase()))
        .map((item, index) => ({ label: item, value: item, selected: index === historySearchIndex }))
    : []

  const borderColor = enabled ? (planMode ? theme.colors.warning : theme.colors.focusRing) : theme.colors.border
  const prefixColor = enabled ? (planMode ? theme.colors.warning : theme.colors.primary) : theme.colors.mutedForeground

  if (splitMode) {
    const SIDEBAR_WIDTH = 44
    const INPUT_HEIGHT = 9                      // total left panel height (borders included)
    const CONTENT_ROWS = INPUT_HEIGHT - 2       // 7 usable text rows
    const leftWidth = Math.max(20, columns - SIDEBAR_WIDTH)
    const prefixCols = (isVim ? 4 : 0) + prefix.length + 1   // "[N] > " or "> "
    const textWidth = Math.max(10, leftWidth - prefixCols - 4) // subtract borders+padding+prefix

    // ── wrap value into visual lines, tracking char offsets ──────────────────
    type VLine = { text: string; charStart: number }
    const allVisualLines: VLine[] = []
    if (value) {
      let offset = 0
      for (const seg of value.split("\n")) {
        if (seg.length === 0) {
          allVisualLines.push({ text: "", charStart: offset })
        } else {
          for (let i = 0; i < seg.length; i += textWidth) {
            allVisualLines.push({ text: seg.slice(i, i + textWidth), charStart: offset + i })
          }
        }
        offset += seg.length + 1 // +1 for the \n
      }
    }
    if (allVisualLines.length === 0) allVisualLines.push({ text: "", charStart: 0 })

    // ── find cursor visual line + col ─────────────────────────────────────────
    let cursorVisLine = allVisualLines.length - 1
    let cursorVisCol = (value ?? "").length - (allVisualLines.at(-1)?.charStart ?? 0)
    for (let i = 0; i < allVisualLines.length; i++) {
      const lineEnd = i + 1 < allVisualLines.length
        ? allVisualLines[i + 1]!.charStart - 1  // -1 to exclude the \n char
        : (value ?? "").length
      if (cursorOffset <= lineEnd) {
        cursorVisLine = i
        cursorVisCol = cursorOffset - allVisualLines[i]!.charStart
        break
      }
    }
    cursorVisCol = Math.max(0, cursorVisCol)

    // ── viewport: always show the cursor, overflow from the top ───────────────
    const total = allVisualLines.length
    const hasOverflow = total > CONTENT_ROWS
    const textRows = hasOverflow ? CONTENT_ROWS - 1 : CONTENT_ROWS  // reserve row for indicator
    // Scroll so cursor is always in the last visible text row
    const vpStart = hasOverflow
      ? Math.max(0, Math.min(cursorVisLine - textRows + 1, total - textRows))
      : 0
    const visLines = allVisualLines.slice(vpStart, vpStart + textRows)
    const hiddenChars = vpStart > 0 ? (allVisualLines[vpStart]?.charStart ?? 0) : 0

    // ── sidebar window ────────────────────────────────────────────────────────
    const SIDEBAR_VISIBLE_ITEMS = CONTENT_ROWS - 1  // header + 6 items = 7 rows
    const safeIndex = Math.max(0, Math.min(selectedAutocompleteIndex, sidebarItems.length - 1))
    const windowBegin = Math.max(0, Math.min(safeIndex - Math.floor(SIDEBAR_VISIBLE_ITEMS / 2), sidebarItems.length - SIDEBAR_VISIBLE_ITEMS))
    const visibleSidebarItems = sidebarItems.slice(windowBegin, windowBegin + SIDEBAR_VISIBLE_ITEMS)
    const indent = " ".repeat(prefixCols)

    // ── ghost-text suggestion ─────────────────────────────────────────────────
    // Show the portion of the top autocomplete match that extends beyond what
    // the user has already typed, rendered in muted color after the cursor.
    // Only shown on the cursor's visual line and only when there's exactly one
    // "/" prefix (slash-command mode).
    const topMatch = sidebarItems[safeIndex]
    const ghostSuffix = (() => {
      if (!topMatch || !value || !value.startsWith("/")) return ""
      const typed = value.toLowerCase()
      // Labels may or may not start with "/". Normalize so the comparison always
      // works regardless of whether it's a built-in command or a skill/custom cmd.
      const labelOrig = topMatch.label.startsWith("/") ? topMatch.label : "/" + topMatch.label
      const label = labelOrig.toLowerCase()
      if (label.startsWith(typed) && typed.length < label.length) {
        return labelOrig.slice(typed.length)
      }
      return ""
    })()

    return (
      <>
        {historySearchActive ? <HistorySearchMenu items={historySearchMatches} query={historySearchQuery} /> : null}
        <Box flexDirection="row" width={columns}>
          {/* When an override is active it takes the full row width (no sidebar). */}
          {inputOverride ? (
            <Box width={columns} flexDirection="column">{inputOverride}</Box>
          ) : (
          <Box
            flexGrow={1}
            height={INPUT_HEIGHT}
            borderStyle="round"
            borderColor={borderColor}
            paddingX={1}
            flexDirection="column"
          >
            <>
            {/* Top indicator row — only rendered when text overflows */}
            {hasOverflow ? (
              <Text color={theme.colors.mutedForeground}>{`[${hiddenChars} chars]`}</Text>
            ) : null}

            {/* Visible text rows */}
            {value ? visLines.map((line, i) => {
              const absIdx = vpStart + i
              const hasCursor = absIdx === cursorVisLine
              const isFirstAbsolute = absIdx === 0
              return (
                <Box key={absIdx}>
                  {isFirstAbsolute ? (
                    <>
                      {isVim && (
                        <Text color={vimMode === "normal" ? theme.colors.warning : theme.colors.mutedForeground} bold>
                          [{vimMode === "normal" ? "N" : "I"}]{" "}
                        </Text>
                      )}
                      <Text color={prefixColor} bold>{prefix}{" "}</Text>
                    </>
                  ) : (
                    <Text>{indent}</Text>
                  )}
                  <Box flexGrow={1} overflow="hidden">
                    {hasCursor ? (() => {
                      const isLastLine = absIdx === allVisualLines.length - 1
                      const atEnd = line.text[cursorVisCol] === undefined
                      const showGhost = isLastLine && ghostSuffix.length > 0
                      // When cursor is at end-of-text and ghost text is available,
                      // use the first ghost character as the cursor block so the
                      // suggestion appears to start at the cursor position.
                      const cursorChar = (atEnd && showGhost) ? ghostSuffix[0] : (line.text[cursorVisCol] ?? " ")
                      const ghostRest = (atEnd && showGhost) ? ghostSuffix.slice(1) : ""
                      return (
                        <Text color={theme.colors.foreground}>
                          {line.text.slice(0, cursorVisCol)}
                          <Text color={theme.colors.selectionForeground} backgroundColor={theme.colors.selection}>
                            {cursorChar}
                          </Text>
                          {line.text.slice(cursorVisCol + 1)}
                          {ghostRest ? <Text color={theme.colors.mutedForeground}>{ghostRest}</Text> : null}
                        </Text>
                      )
                    })() : (
                      <Text color={theme.colors.foreground}>{line.text}</Text>
                    )}
                  </Box>
                </Box>
              )
            }) : (
              /* Placeholder */
              <Box>
                {isVim && (
                  <Text color={theme.colors.mutedForeground} bold>
                    [{vimMode === "normal" ? "N" : "I"}]{" "}
                  </Text>
                )}
                <Text color={prefixColor} bold>{prefix}{" "}</Text>
                <Box flexGrow={1} overflow="hidden">
                  <Text color={theme.colors.mutedForeground}>
                    <Text color={theme.colors.selectionForeground} backgroundColor={theme.colors.selection}>
                      {display[0] ?? " "}
                    </Text>
                    {display.slice(1)}
                  </Text>
                </Box>
              </Box>
            )}
          </>
          </Box>
          )}

          {/* Right panel: command sidebar — hidden when override occupies full width */}
          {!inputOverride && <Box
            width={SIDEBAR_WIDTH}
            borderStyle="round"
            borderColor={theme.colors.border}
            paddingX={1}
            flexDirection="column"
            overflow="hidden"
          >
            {sidebarOverride ?? (
              <>
                <Box justifyContent="space-between">
                  <Text color={theme.colors.primary} bold>Commands</Text>
                  <Text color={theme.colors.mutedForeground}>↑↓ · tab</Text>
                </Box>
                {visibleSidebarItems.map((item, i) => {
                  const absIdx = windowBegin + i
                  const isSelected = absIdx === safeIndex
                  // Inner content width: total - 2 borders - 2 paddingX
                  const innerWidth = SIDEBAR_WIDTH - 4
                  // 2 prefix + 1 separator = 3 overhead; split remainder 50/50
                  const available = innerWidth - 3
                  const labelWidth = Math.floor(available * 0.5)
                  const descWidth = available - labelWidth
                  return (
                    // Single Text with wrap=truncate ensures the row never exceeds one line
                    <Text key={item.value} wrap="truncate">
                      <Text
                        color={isSelected ? theme.colors.primary : theme.colors.foreground}
                        bold={isSelected}
                      >
                        {isSelected ? "› " : "  "}
                        {truncateSidebar(item.label, labelWidth)}
                      </Text>
                      {item.description ? (
                        <Text color={theme.colors.mutedForeground}>
                          {" "}{truncateSidebar(item.description, descWidth)}
                        </Text>
                      ) : null}
                    </Text>
                  )
                })}
                {sidebarItems.length === 0 && (
                  <Text color={theme.colors.mutedForeground}>  No matches</Text>
                )}
              </>
            )}
          </Box>}
        </Box>
      </>
    )
  }

  return (
    <>
      {historySearchActive
        ? <HistorySearchMenu items={historySearchMatches} query={historySearchQuery} />
        : autocompleteActive
          ? <PromptAutocompleteMenu items={autocompleteMatches} />
          : null}
      <Box
        borderStyle="round"
        borderColor={borderColor}
        paddingX={1}
        flexDirection="column"
        width={columns}
      >
        {valueLines ? (
          valueLines.map((line, lineIdx) => {
            const hasCursor = cursorLineIdx === lineIdx
            const isFirst = lineIdx === 0
            const indentWidth = prefix.length + 1 + (isVim ? 4 : 0)
            return (
              <Box key={lineIdx}>
                {isFirst && isVim ? (
                  <Text color={vimMode === "normal" ? theme.colors.warning : theme.colors.mutedForeground} bold>
                    [{vimMode === "normal" ? "N" : "I"}]{" "}
                  </Text>
                ) : null}
                {isFirst ? (
                  <Text color={enabled ? (planMode ? theme.colors.warning : theme.colors.primary) : theme.colors.mutedForeground} bold>
                    {prefix}{" "}
                  </Text>
                ) : (
                  <Text>{" ".repeat(indentWidth)}</Text>
                )}
                <Box flexGrow={1}>
                  {hasCursor ? (
                    <Text color={theme.colors.foreground}>
                      {line.slice(0, cursorColIdx)}
                      <Text color={theme.colors.selectionForeground} backgroundColor={theme.colors.selection}>
                        {line[cursorColIdx] ?? " "}
                      </Text>
                      {line.slice(cursorColIdx + 1)}
                    </Text>
                  ) : (
                    <Text color={theme.colors.foreground}>{line}</Text>
                  )}
                </Box>
              </Box>
            )
          })
        ) : (
          <Box>
            {isVim ? (
              <Text color={vimMode === "normal" ? theme.colors.warning : theme.colors.mutedForeground} bold>
                [{vimMode === "normal" ? "N" : "I"}]{" "}
              </Text>
            ) : null}
            <Text color={prefixColor} bold>
              {prefix}{" "}
            </Text>
            <Box flexGrow={1}>
              <Text color={theme.colors.mutedForeground}>
                <Text color={theme.colors.selectionForeground} backgroundColor={theme.colors.selection}>
                  {display[0] ?? " "}
                </Text>
                {display.slice(1)}
              </Text>
            </Box>
          </Box>
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

function HistorySearchMenu({ items, query }: { items: PromptAutocompleteMatch[]; query: string }): React.ReactNode {
  const theme = useTheme()
  const window = autocompleteWindow(items)
  return (
    <Box borderStyle="round" borderColor={theme.colors.border} flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text color={theme.colors.primary} bold>History search: {query || "…"}</Text>
        <Text color={theme.colors.mutedForeground}>enter to load</Text>
      </Box>
      {items.length === 0
        ? <Text color={theme.colors.mutedForeground}>  No matches</Text>
        : null}
      {window.visible.map((item, i) => (
        <Text key={i} color={item.selected ? theme.colors.primary : theme.colors.foreground} bold={item.selected} wrap="truncate">
          {item.selected ? "› " : "  "}{item.label}
        </Text>
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
  const exact = items.some((item) => item.value.toLowerCase() === normalized && !item.browsable)
  if (exact) return []

  const spaceIndex = normalized.indexOf(" ")
  const commandPart = spaceIndex < 0 ? normalized : normalized.slice(0, spaceIndex)
  const argPart = spaceIndex < 0 ? "" : normalized.slice(spaceIndex + 1).trim()

  const matches = items
    .filter((item) => {
      const itemValue = item.value.toLowerCase()
      if (!argPart) return itemValue.startsWith(normalized)
      if (!itemValue.startsWith(commandPart)) return false
      const rest = itemValue.slice(commandPart.length).trim()
      if (rest.startsWith(argPart)) return true
      const haystack = `${rest} ${(item.label || "").toLowerCase()} ${(item.description || "").toLowerCase()}`
      return haystack.includes(argPart)
    })
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
