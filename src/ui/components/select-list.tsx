import { Box, Text, useInput } from "ink"
import * as React from "react"

import { useTheme } from "./theme-provider.js"

export type SelectListItem<TValue extends string> = {
  description?: string
  disabled?: boolean
  label: string
  value: TValue
}

export type SelectListProps<TValue extends string> = {
  active?: boolean
  emptyLabel?: string
  items: SelectListItem<TValue>[]
  maxRows?: number
  onBoundary?: (direction: "up" | "down") => void
  onCancel?: () => void
  onHighlight?: (item: SelectListItem<TValue>) => void
  onSelect?: (item: SelectListItem<TValue>) => void
  selectedValue?: TValue | null
}

export function SelectList<TValue extends string>({
  active = true,
  emptyLabel = "No matches",
  items,
  maxRows = 10,
  onBoundary,
  onCancel,
  onHighlight,
  onSelect,
  selectedValue,
}: SelectListProps<TValue>): React.ReactNode {
  const theme = useTheme()
  const [activeIndex, setActiveIndex] = React.useState(0)

  React.useEffect(() => {
    const selectedIndex = selectedValue ? items.findIndex((item) => item.value === selectedValue) : -1
    setActiveIndex((current) => clampToEnabled(items, selectedIndex >= 0 ? selectedIndex : current))
  }, [items, selectedValue])

  React.useEffect(() => {
    const item = items[activeIndex]
    if (item && !item.disabled) onHighlight?.(item)
  }, [activeIndex, items, onHighlight])

  useInput((_input, key) => {
    if (!active) return
    if (key.escape) {
      onCancel?.()
      return
    }
    if (key.upArrow) {
      setActiveIndex((current) => {
        const next = previousEnabled(items, current)
        if (next === current) {
          // wrap around to bottom
          const wrapped = lastEnabled(items)
          if (wrapped !== current) return wrapped
          onBoundary?.("up")
        }
        return next
      })
      return
    }
    if (key.downArrow) {
      setActiveIndex((current) => {
        const next = nextEnabled(items, current)
        if (next === current) {
          // wrap around to top
          const wrapped = firstEnabled(items)
          if (wrapped !== current) return wrapped
          onBoundary?.("down")
        }
        return next
      })
      return
    }
    if (key.return) {
      const item = items[activeIndex]
      if (item && !item.disabled) onSelect?.(item)
    }
  }, { isActive: active })

  if (items.length === 0) {
    return <Text color={theme.colors.mutedForeground}>{emptyLabel}</Text>
  }

  const half = Math.floor(maxRows / 2)
  const maxOffset = Math.max(0, items.length - maxRows)
  const offset = Math.min(maxOffset, Math.max(0, activeIndex - half))
  const visibleItems = items.slice(offset, offset + maxRows)

  return (
    <Box flexDirection="column">
      {visibleItems.map((item, visibleIndex) => {
        const index = offset + visibleIndex
        const isActive = index === activeIndex
        const isSelected = selectedValue === item.value
        const textColor = item.disabled
          ? theme.colors.mutedForeground
          : isActive
            ? theme.colors.primary
            : isSelected
              ? theme.colors.success
              : theme.colors.foreground

        return (
          <Box key={item.value} justifyContent="space-between">
            <Box>
              <Text color={isActive ? theme.colors.primary : theme.colors.mutedForeground}>{isActive ? "› " : "  "}</Text>
              <Text color={textColor} bold={isActive || isSelected}>
                {isSelected ? "* " : ""}
                {item.label}
              </Text>
            </Box>
            {item.description ? <Text color={theme.colors.mutedForeground}> {item.description}</Text> : null}
          </Box>
        )
      })}
      {items.length > maxRows ? (
        <Text color={theme.colors.mutedForeground}>
          {offset + 1}-{Math.min(items.length, offset + maxRows)} of {items.length}
        </Text>
      ) : null}
    </Box>
  )
}

function clampToEnabled<TValue extends string>(items: SelectListItem<TValue>[], index: number): number {
  if (items.length === 0) return 0
  const clamped = Math.min(items.length - 1, Math.max(0, index))
  if (!items[clamped]?.disabled) return clamped
  return nextEnabled(items, clamped)
}

function previousEnabled<TValue extends string>(items: SelectListItem<TValue>[], index: number): number {
  for (let next = index - 1; next >= 0; next -= 1) {
    if (!items[next]?.disabled) return next
  }
  return index
}

function nextEnabled<TValue extends string>(items: SelectListItem<TValue>[], index: number): number {
  for (let next = index + 1; next < items.length; next += 1) {
    if (!items[next]?.disabled) return next
  }
  return index
}

function firstEnabled<TValue extends string>(items: SelectListItem<TValue>[]): number {
  for (let i = 0; i < items.length; i += 1) {
    if (!items[i]?.disabled) return i
  }
  return 0
}

function lastEnabled<TValue extends string>(items: SelectListItem<TValue>[]): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (!items[i]?.disabled) return i
  }
  return 0
}
