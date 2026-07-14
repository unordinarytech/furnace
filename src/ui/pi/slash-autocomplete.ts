import { fuzzyFilter, type AutocompleteItem, type AutocompleteProvider, type AutocompleteSuggestions } from "@earendil-works/pi-tui"
import type { PromptAutocompleteItem, PromptAutocompleteMatch } from "../terminal-types.js"

/**
 * Slash-command autocomplete matching pi's behavior: command names complete
 * by prefix, command arguments fuzzy-filter (like pi's
 * SlashCommand.getArgumentCompletions with fuzzyFilter).
 */
export class SlashCommandAutocompleteProvider implements AutocompleteProvider {
  private items: PromptAutocompleteItem[] = []
  private onTab?: (match: PromptAutocompleteMatch) => boolean

  constructor(items: PromptAutocompleteItem[] = [], onTab?: (match: PromptAutocompleteMatch) => boolean) {
    this.items = items
    this.onTab = onTab
  }

  setItems(items: PromptAutocompleteItem[]): void {
    this.items = items
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
  ): Promise<AutocompleteSuggestions | null> {
    const line = lines[cursorLine] || ""
    const beforeCursor = line.slice(0, cursorCol)
    if (!beforeCursor.startsWith("/")) return null

    const spaceIndex = beforeCursor.indexOf(" ")
    if (spaceIndex === -1) {
      // Completing the command name itself: prefix match, like pi.
      const filtered = this.items.filter((item) => item.value.startsWith(beforeCursor) || item.label.startsWith(beforeCursor))
      if (filtered.length === 0) return null
      return { items: filtered, prefix: beforeCursor }
    }

    // Completing a command argument: fuzzy-filter the items that belong to
    // this command (their values look like "/model anthropic/claude-...").
    const command = beforeCursor.slice(0, spaceIndex)
    const argumentPrefix = beforeCursor.slice(spaceIndex + 1)
    const candidates = this.items.filter((item) => item.value.startsWith(`${command} `))
    if (candidates.length === 0) return null

    const filtered = argumentPrefix
      ? fuzzyFilter(candidates, argumentPrefix, (item) => `${item.label} ${item.description ?? ""} ${item.value}`)
      : candidates
    if (filtered.length === 0) return null
    return { items: filtered, prefix: beforeCursor }
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    const handled = this.onTab?.({ ...item, selected: true })
    if (handled) {
      return { lines, cursorLine, cursorCol }
    }
    const newLines = [...lines]
    const line = newLines[cursorLine] || ""
    newLines[cursorLine] = line.slice(0, cursorCol - prefix.length) + item.value + line.slice(cursorCol)
    return {
      lines: newLines,
      cursorLine,
      cursorCol: cursorCol - prefix.length + item.value.length,
    }
  }
}
