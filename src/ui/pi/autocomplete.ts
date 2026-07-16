import { SelectList, visibleWidth, type AutocompleteItem } from "@earendil-works/pi-tui"
import type { PromptAutocompleteItem, PromptAutocompleteMatch } from "../terminal-types.js"
import { CustomEditor } from "./components/custom-editor.js"
import { getSelectListTheme, theme } from "./theme.js"

type AutocompleteListFactory = (prefix: string, items: AutocompleteItem[]) => SelectList
type AutocompletePreviewHandler = (match: PromptAutocompleteMatch | PromptAutocompleteItem | undefined) => void
type AutocompleteSelectList = SelectList & { getSelectedItem?: () => AutocompleteItem | null }

function isPromptAutocompleteItem(item: AutocompleteItem): item is AutocompleteItem & PromptAutocompleteItem {
  return "relatedValue" in item
}

export const RESUME_AUTOCOMPLETE_HINT = "Type to search titles, messages, and tools · Tab pin/unpin · Enter open · Esc close"

export class RelatedAutocompleteSelectList extends SelectList {
  constructor(
    private readonly prefix: string,
    private readonly rawItems: AutocompleteItem[],
    private readonly maxVisibleRows: number,
  ) {
    super(rawItems, maxVisibleRows, getSelectListTheme(), {
      minPrimaryColumnWidth: 12,
      maxPrimaryColumnWidth: 32,
    })
  }

  render(width: number): string[] {
    const selected = this.getSelectedItem?.()
    const relatedValue = selected && isPromptAutocompleteItem(selected) ? selected.relatedValue : undefined
    let baseLines: string[]

    if (!relatedValue) {
      baseLines = super.render(width)
    } else {
      const displayItems = this.rawItems.map((item) => item.value === relatedValue
        ? {
            ...item,
            label: `↳ ${item.label}`,
            description: item.description ? `fork parent · ${item.description}` : "fork parent",
          }
        : { ...item })
      const displayList = new SelectList(displayItems, this.maxVisibleRows, getSelectListTheme(), {
        minPrimaryColumnWidth: 12,
        maxPrimaryColumnWidth: 32,
      })
      const selectedIndex = selected ? this.rawItems.indexOf(selected) : -1
      if (selectedIndex >= 0) displayList.setSelectedIndex(selectedIndex)
      baseLines = displayList.render(width).map((line) => (line.includes("↳ ") ? theme.fg("warning", line) : line))
    }

    const lines = baseLines.map((line) => {
      const pad = " ".repeat(Math.max(0, width - visibleWidth(line)))
      return theme.bg("toolPendingBg", line + pad)
    })
    if (this.prefix.startsWith("/resume")) {
      const hint = theme.fg("muted", RESUME_AUTOCOMPLETE_HINT)
      lines.push(theme.bg("toolPendingBg", hint + " ".repeat(Math.max(0, width - visibleWidth(hint)))))
    }
    return lines
  }
}

export function wireSlashAutocompletePreview(editor: CustomEditor, onPreview: AutocompletePreviewHandler | undefined): void {
  const editorWithFactory = editor as unknown as { createAutocompleteList?: AutocompleteListFactory }
  const createAutocompleteList = editorWithFactory.createAutocompleteList?.bind(editor)
  if (!createAutocompleteList) return

  editorWithFactory.createAutocompleteList = (prefix, items) => {
    const list = prefix.startsWith("/")
      ? new RelatedAutocompleteSelectList(prefix, items, editor.getAutocompleteMaxVisible()) as AutocompleteSelectList
      : createAutocompleteList(prefix, items) as AutocompleteSelectList
    if (prefix.startsWith("/") && onPreview) {
      list.onSelectionChange = (item) => {
        onPreview({ ...item, selected: true })
      }
    }
    return list
  }
}
