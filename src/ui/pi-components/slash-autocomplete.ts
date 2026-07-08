import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui"
import type { PromptAutocompleteItem, PromptAutocompleteMatch } from "../terminal-types.js"

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
    const prefix = beforeCursor
    const filtered = this.items.filter((item) => item.value.startsWith(prefix) || item.label.startsWith(prefix))
    return { items: filtered, prefix }
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
