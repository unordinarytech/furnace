import {
  Editor,
  Input,
  Markdown,
  matchesKey,
  ProcessTerminal,
  SelectList,
  TUI,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type EditorTheme,
  type Focusable,
  type MarkdownTheme,
  type SelectItem,
  type SelectListTheme,
} from "@earendil-works/pi-tui"
import type { ModelSettings, ReasoningEffort } from "../preferences.js"
import type { TranscriptMessage } from "../session/types.js"

const identity = (text: string) => text

const selectListTheme: SelectListTheme = {
  selectedPrefix: (text) => `> ${text}`,
  selectedText: identity,
  description: identity,
  scrollInfo: identity,
  noMatch: identity,
}

const editorTheme: EditorTheme = {
  borderColor: identity,
  selectList: selectListTheme,
}

const markdownTheme: MarkdownTheme = {
  heading: (text) => `\x1b[38;2;120;255;190m${text}\x1b[39m`,
  link: (text) => `\x1b[4m\x1b[38;2;41;220;255m${text}\x1b[39m\x1b[24m`,
  linkUrl: (text) => `\x1b[2m${text}\x1b[22m`,
  code: (text) => `\x1b[48;2;24;32;28m\x1b[38;2;255;210;92m ${text} \x1b[0m`,
  codeBlock: (text) => `\x1b[38;2;214;236;222m${text}\x1b[39m`,
  codeBlockBorder: (text) => `\x1b[38;2;80;255;120m${text}\x1b[39m`,
  quote: (text) => `\x1b[2m${text}\x1b[22m`,
  quoteBorder: (text) => `\x1b[38;2;80;255;120m${text}\x1b[39m`,
  hr: (text) => `\x1b[38;2;80;255;120m${text}\x1b[39m`,
  listBullet: (text) => `\x1b[38;2;80;255;120m${text}\x1b[39m`,
  bold: (text) => `\x1b[1m${text}\x1b[22m`,
  italic: (text) => `\x1b[3m${text}\x1b[23m`,
  strikethrough: (text) => `\x1b[9m${text}\x1b[29m`,
  underline: (text) => `\x1b[4m${text}\x1b[24m`,
  codeBlockIndent: "  ",
}

export type FurnacePiTerminal = {
  run(): Promise<void>
  stop(): void
  setBusy(busy: boolean): void
  setThinking(thinking: boolean, message?: string): void
  showHistory(choices: HistoryChoice[], currentSessionId: string | null, onSelect: (sessionId: string) => void, onCancel: () => void): void
  showModelPicker(
    choices: ModelChoice[],
    currentModel: string,
    currentSettings: ModelSettings,
    onSelect: (model: string, settings: ModelSettings, done: boolean) => void,
    onCancel: () => void,
  ): void
  setModel(model: string, settings: ModelSettings): void
  setTitle(title: string): void
  setTranscript(transcript: TranscriptMessage[]): void
}

export type HistoryChoice = {
  id: string
  title: string
  updatedAt: number
}

export type ModelChoice = {
  id: string
  name: string
  contextLength: number | null
  supportedParameters: string[]
}

type CreateFurnacePiTerminalOptions = {
  cwd: string
  model: string
  modelSettings: ModelSettings
  title: string
  onSubmit: (text: string) => void
}

export function createFurnacePiTerminal(options: CreateFurnacePiTerminalOptions): FurnacePiTerminal {
  // Interactive mode uses Pi's retained renderer so Furnace does not manage
  // cursor movement and line diffing by hand.
  const terminal = new ProcessTerminal()
  const tui = new TUI(terminal)
  const app = new FurnaceApp(tui, options)
  let resolveRun: (() => void) | undefined

  tui.addChild(app)
  tui.setFocus(app)
  tui.addInputListener((data) => {
    if (matchesKey(data, "ctrl+c")) {
      app.setThinking(false)
      terminal.write("\x1b[?1006l\x1b[?1000l")
      tui.stop()
      resolveRun?.()
      return { consume: true }
    }
    return undefined
  })

  return {
    run() {
      terminal.write("\x1b[?1000h\x1b[?1006h")
      tui.start()
      tui.requestRender(true)
      return new Promise<void>((resolve) => {
        resolveRun = resolve
      })
    },
    stop() {
      app.setThinking(false)
      terminal.write("\x1b[?1006l\x1b[?1000l")
      tui.stop()
      resolveRun?.()
    },
    setBusy(busy) {
      app.busy = busy
      app.editor.disableSubmit = busy
      tui.requestRender()
    },
    setThinking(thinking, message) {
      app.setThinking(thinking, message)
      tui.requestRender()
    },
    showHistory(choices, currentSessionId, onSelect, onCancel) {
      app.showHistory(choices, currentSessionId, onSelect, onCancel)
      tui.requestRender()
    },
    showModelPicker(choices, currentModel, currentSettings, onSelect, onCancel) {
      app.showModelPicker(choices, currentModel, currentSettings, onSelect, onCancel)
      tui.requestRender()
    },
    setModel(model, settings) {
      app.model = model
      app.modelSettings = settings
      tui.requestRender()
    },
    setTitle(title) {
      app.title = title
      tui.requestRender()
    },
    setTranscript(transcript) {
      app.setTranscript(transcript)
      tui.requestRender()
    },
  }
}

class FurnaceApp implements Component, Focusable {
  focused = false
  busy = false
  title: string
  model: string
  modelSettings: ModelSettings
  transcript: TranscriptMessage[] = []
  readonly editor: Editor
  private historyList: SelectList | undefined
  private modelPicker: ModelPickerState | undefined
  private thinkingLoader: FurnaceThinkingLoader | undefined
  private transcriptScrollOffset = 0

  constructor(
    private readonly tui: TUI,
    private readonly options: CreateFurnacePiTerminalOptions,
  ) {
    this.title = options.title
    this.model = options.model
    this.modelSettings = options.modelSettings
    this.editor = new Editor(tui, editorTheme, { paddingX: 0 })
    this.editor.onSubmit = (text) => {
      if (this.busy) return
      const trimmed = text.trim()
      if (!trimmed) return
      this.editor.setText("")
      options.onSubmit(trimmed)
    }
  }

  invalidate(): void {
    this.editor.invalidate()
  }

  handleInput(data: string): void {
    if (this.historyList) {
      this.historyList.handleInput(data)
      return
    }

    if (this.modelPicker) {
      this.handleModelPickerInput(data)
      return
    }

    const scrollAmount = getScrollAmount(data)
    if (scrollAmount !== 0) {
      this.scrollTranscript(scrollAmount)
      return
    }

    this.editor.handleInput(data)
  }

  render(width: number): string[] {
    this.editor.focused = this.focused && !this.historyList && !this.modelPicker
    if (this.modelPicker) {
      this.modelPicker.filterInput.focused = this.focused && !this.modelPicker.editing
    }

    const editorLines = this.editor.render(width)
    const modelStatus = formatFooterSettings(this.modelSettings)
    const usagePrefix = `0.0%/${modelStatus}`
    const footer = [
      truncateToWidth(`${this.options.cwd} · ${this.title}`, width),
      truncateToWidth(`${usagePrefix}${rightAlign(this.model, Math.max(1, width - usagePrefix.length))}`, width),
    ]
    const header = renderHeader(width)
    const availableTranscriptRows = Math.max(1, this.tui.terminal.rows - header.length - editorLines.length - footer.length - 1)
    const transcriptLines = this.modelPicker
      ? this.buildModelPickerLines(width)
      : this.historyList
        ? this.buildHistoryLines(width)
        : buildTranscriptLines(this.transcript, width, this.thinkingLoader)
    this.clampTranscriptScroll(transcriptLines.length, availableTranscriptRows)
    const end = Math.max(0, transcriptLines.length - this.transcriptScrollOffset)
    const visibleTranscript = transcriptLines.slice(Math.max(0, end - availableTranscriptRows), end)
    const spacerCount = Math.max(0, availableTranscriptRows - visibleTranscript.length)

    return [
      ...header,
      ...visibleTranscript,
      ...Array.from({ length: spacerCount }, () => ""),
      ...editorLines,
      ...footer,
    ]
  }

  showHistory(choices: HistoryChoice[], currentSessionId: string | null, onSelect: (sessionId: string) => void, onCancel: () => void): void {
    const items: SelectItem[] = choices.map((choice) => ({
      value: choice.id,
      label: `${choice.id === currentSessionId ? "* " : "  "}${choice.title}`,
      description: formatRelativeTime(choice.updatedAt),
    }))
    const list = new SelectList(items, Math.max(1, Math.min(10, choices.length)), selectListTheme)
    const currentIndex = choices.findIndex((choice) => choice.id === currentSessionId)
    if (currentIndex >= 0) list.setSelectedIndex(currentIndex)
    list.onSelect = (item) => {
      this.clearHistory()
      onSelect(item.value)
    }
    list.onCancel = () => {
      this.clearHistory()
      onCancel()
    }
    this.historyList = list
    this.title = "History"
  }

  clearHistory(): void {
    this.historyList = undefined
  }

  showModelPicker(
    choices: ModelChoice[],
    currentModel: string,
    currentSettings: ModelSettings,
    onSelect: (model: string, settings: ModelSettings, done: boolean) => void,
    onCancel: () => void,
  ): void {
    const filterInput = new Input()
    const picker: ModelPickerState = {
      choices,
      currentModel,
      settingsByModel: { [currentModel]: normalizeModelSettings(currentSettings, findModelChoice(choices, currentModel)) },
      filter: "",
      filterInput,
      list: this.createModelList(choices, currentModel),
      onSelect,
      onCancel,
    }
    filterInput.onSubmit = () => this.selectCurrentModel()
    filterInput.onEscape = () => this.cancelModelPicker()
    this.modelPicker = picker
    this.title = "Model"
  }

  private createModelList(choices: ModelChoice[], currentModel: string): SelectList {
    const items: SelectItem[] = choices.map((choice) => ({
      value: choice.id,
      label: `${choice.id === currentModel ? "* " : "  "}${choice.name}`,
      description: `${formatContext(choice.contextLength)}${supportsReasoning(choice) ? " Reasoning" : ""} ${choice.id}`,
    }))
    const list = new SelectList(items, Math.max(1, Math.min(10, items.length)), selectListTheme, {
      maxPrimaryColumnWidth: 34,
    })
    const currentIndex = choices.findIndex((choice) => choice.id === currentModel)
    if (currentIndex >= 0) list.setSelectedIndex(currentIndex)
    list.onSelect = (item) => {
      const picker = this.modelPicker
      if (!picker) return
      this.modelPicker = undefined
      picker.onSelect(item.value, this.settingsForModel(item.value), true)
    }
    list.onCancel = () => this.cancelModelPicker()
    return list
  }

  private handleModelPickerInput(data: string): void {
    const picker = this.modelPicker
    if (!picker) return

    if (picker.editing) {
      this.handleModelEditorInput(data)
      return
    }

    if (matchesKey(data, "tab")) {
      const selected = picker.list.getSelectedItem()
      const choice = selected ? findModelChoice(picker.choices, selected.value) : undefined
      if (choice) picker.editing = { choice, selectedIndex: 0 }
      this.tui.requestRender()
      return
    }

    if (matchesKey(data, "up") || matchesKey(data, "down") || matchesKey(data, "enter") || matchesKey(data, "escape")) {
      picker.list.handleInput(data)
      return
    }

    const before = picker.filterInput.getValue()
    picker.filterInput.handleInput(data)
    const after = picker.filterInput.getValue()
    if (after !== before) {
      picker.filter = after
      const filteredChoices = filterModels(picker.choices, picker.filter)
      picker.list = this.createModelList(filteredChoices, picker.currentModel)
      this.tui.requestRender()
    }
  }

  private handleModelEditorInput(data: string): void {
    const picker = this.modelPicker
    const editing = picker?.editing
    if (!picker || !editing) return

    const rows = modelEditorRows(editing.choice, this.settingsForModel(editing.choice.id))
    if (matchesKey(data, "escape") || matchesKey(data, "tab")) {
      picker.editing = undefined
      this.tui.requestRender()
      return
    }
    if (matchesKey(data, "up")) {
      editing.selectedIndex = Math.max(0, editing.selectedIndex - 1)
      this.tui.requestRender()
      return
    }
    if (matchesKey(data, "down")) {
      editing.selectedIndex = Math.min(rows.length - 1, editing.selectedIndex + 1)
      this.tui.requestRender()
      return
    }
    if (matchesKey(data, "enter")) {
      this.applyModelEditorRow(editing.choice, rows[editing.selectedIndex])
      this.tui.requestRender()
    }
  }

  private applyModelEditorRow(choice: ModelChoice, row: ModelEditorRow | undefined): void {
    if (!row || row.disabled) return
    const current = this.settingsForModel(choice.id)
    let next: ModelSettings

    if (row.kind === "context") {
      next = normalizeModelSettings({ ...current, contextLength: row.value }, choice)
      this.applyModelSettings(choice, next)
      return
    }
    if (row.kind === "reasoning") {
      next = normalizeModelSettings({ ...current, reasoningEffort: row.value }, choice)
      this.applyModelSettings(choice, next)
      return
    }
    if (row.kind === "fast") {
      next = normalizeModelSettings({ ...current, fast: !current.fast }, choice)
      this.applyModelSettings(choice, next)
    }
  }

  private applyModelSettings(choice: ModelChoice, settings: ModelSettings): void {
    const picker = this.modelPicker
    if (!picker) return
    this.setSettingsForModel(choice.id, settings)
    this.model = choice.id
    this.modelSettings = settings
    picker.currentModel = choice.id
    picker.onSelect(choice.id, settings, false)
  }

  private selectCurrentModel(): void {
    const picker = this.modelPicker
    const selected = picker?.list.getSelectedItem()
    if (!picker || !selected) return
    this.modelPicker = undefined
    picker.onSelect(selected.value, this.settingsForModel(selected.value), true)
  }

  private cancelModelPicker(): void {
    const picker = this.modelPicker
    this.modelPicker = undefined
    picker?.onCancel()
  }

  private settingsForModel(model: string): ModelSettings {
    const picker = this.modelPicker
    const choice = picker ? findModelChoice(picker.choices, model) : undefined
    const settings = picker?.settingsByModel[model] || {}
    const normalized = normalizeModelSettings(settings, choice)
    if (picker) picker.settingsByModel[model] = normalized
    return normalized
  }

  private setSettingsForModel(model: string, settings: ModelSettings): void {
    const picker = this.modelPicker
    if (!picker) return
    picker.settingsByModel[model] = settings
  }

  setThinking(thinking: boolean, message = "thinking"): void {
    if (!thinking) {
      this.thinkingLoader?.stop()
      this.thinkingLoader = undefined
      return
    }

    if (!this.thinkingLoader) this.thinkingLoader = new FurnaceThinkingLoader(this.tui, message)
    else this.thinkingLoader.setMessage(message)
    this.thinkingLoader.start()
  }

  setTranscript(transcript: TranscriptMessage[]): void {
    this.transcript = transcript
    this.transcriptScrollOffset = 0
  }

  private scrollTranscript(amount: number): void {
    this.transcriptScrollOffset = Math.max(0, this.transcriptScrollOffset + amount)
    this.tui.requestRender()
  }

  private clampTranscriptScroll(totalRows: number, viewportRows: number): void {
    this.transcriptScrollOffset = Math.min(this.transcriptScrollOffset, Math.max(0, totalRows - viewportRows))
  }

  private buildHistoryLines(width: number): string[] {
    if (!this.historyList) return []
    return ["Select a conversation:", "", ...this.historyList.render(width)]
  }

  private buildModelPickerLines(width: number): string[] {
    const picker = this.modelPicker
    if (!picker) return []
    if (picker.editing) {
      return renderModelEditor(picker.editing.choice, this.settingsForModel(picker.editing.choice.id), picker.editing.selectedIndex, width)
    }

    return [
      "Available OpenRouter models",
      "",
      "Filter:",
      ...picker.filterInput.render(width),
      "",
      ...picker.list.render(width),
      "",
      dim("Type to filter · Enter to select · Tab to edit parameters · Esc to cancel"),
    ]
  }
}

type ModelPickerState = {
  choices: ModelChoice[]
  currentModel: string
  settingsByModel: Record<string, ModelSettings>
  filter: string
  filterInput: Input
  editing?: {
    choice: ModelChoice
    selectedIndex: number
  }
  list: SelectList
  onSelect: (model: string, settings: ModelSettings, done: boolean) => void
  onCancel: () => void
}

type ModelEditorRow =
  | { kind: "context"; label: string; value: number; selected: boolean; disabled?: boolean }
  | { kind: "reasoning"; label: string; value: ReasoningEffort; selected: boolean; disabled?: boolean }
  | { kind: "fast"; label: string; selected: boolean; disabled?: boolean }

function renderHeader(width: number): string[] {
  const label = " Furnace "
  const ruleWidth = Math.max(0, width - label.length)
  const left = Math.floor(ruleWidth / 2)
  const right = ruleWidth - left
  return [`${"─".repeat(left)}${label}${"─".repeat(right)}`]
}

function buildTranscriptLines(transcript: TranscriptMessage[], width: number, thinkingLoader?: FurnaceThinkingLoader): string[] {
  const lines: string[] = []
  for (const message of transcript) {
    const label = message.role === "user" ? "> user " : "─ assistant "
    lines.push(truncateToWidth(`${label}${"─".repeat(Math.max(0, width - label.length))}`, width))
    lines.push("")
    const contentLines = message.role === "assistant" ? renderMarkdown(message.content, width) : wrap(message.content, width)
    for (const line of contentLines) lines.push(line)
    lines.push("")
  }
  if (thinkingLoader) {
    const label = "─ assistant "
    lines.push(truncateToWidth(`${label}${"─".repeat(Math.max(0, width - label.length))}`, width))
    lines.push(...thinkingLoader.render(width))
    lines.push("")
  }
  return lines
}

function wrap(text: string, width: number): string[] {
  return wrapTextWithAnsi(text, width).map((line) => truncateToWidth(line, width))
}

function renderMarkdown(text: string, width: number): string[] {
  return new Markdown(text, 0, 0, markdownTheme, undefined, { preserveOrderedListMarkers: true })
    .render(width)
    .map((line) => truncateToWidth(line, width))
}

function rightAlign(value: string, available: number): string {
  return `${" ".repeat(Math.max(1, available - value.length))}${value}`
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diffMs = Math.max(0, now - timestamp)
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour

  if (isYesterday(timestamp, now) && diffMs >= 15 * hour) return "yesterday"
  if (diffMs < minute) return "just now"
  if (diffMs < hour) {
    const minutes = Math.max(1, Math.floor(diffMs / minute))
    return `${minutes} min${minutes === 1 ? "" : "s"} ago`
  }
  if (diffMs < day) {
    const hours = Math.max(1, Math.floor(diffMs / hour))
    return `${hours} hour${hours === 1 ? "" : "s"} ago`
  }

  const days = Math.max(1, Math.floor(diffMs / day))
  return `${days} day${days === 1 ? "" : "s"} ago`
}

function isYesterday(timestamp: number, now: number): boolean {
  const date = new Date(timestamp)
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  return date.getFullYear() === yesterday.getFullYear() && date.getMonth() === yesterday.getMonth() && date.getDate() === yesterday.getDate()
}

function filterModels(choices: ModelChoice[], filter: string): ModelChoice[] {
  const normalized = filter.trim().toLowerCase()
  if (!normalized) return choices
  return choices.filter((choice) => `${choice.id} ${choice.name}`.toLowerCase().includes(normalized))
}

function findModelChoice(choices: ModelChoice[], model: string): ModelChoice | undefined {
  return choices.find((choice) => choice.id === model)
}

function formatContext(contextLength: number | null): string {
  if (!contextLength) return "unknown"
  if (contextLength >= 1_000_000) return `${Math.round(contextLength / 1_000_000)}M`
  if (contextLength >= 1_000) return `${Math.round(contextLength / 1_000)}K`
  return String(contextLength)
}

function formatFooterSettings(settings: ModelSettings): string {
  const context = settings.contextLength ? formatContext(settings.contextLength) : "auto"
  const reasoning = settings.reasoningEffort && settings.reasoningEffort !== "none" ? settings.reasoningEffort : "auto"
  const fast = settings.fast ? ", fast" : ""
  return `${context} (${reasoning}${fast})`
}

function supportsReasoning(choice: ModelChoice | undefined): boolean {
  if (!choice) return false
  return choice.supportedParameters.includes("reasoning") || choice.supportedParameters.includes("reasoning_effort")
}

function contextOptions(choice: ModelChoice): number[] {
  const max = choice.contextLength || 0
  if (!max) return []
  if (max <= 300_000) return [max]
  return [...new Set([272_000, max])].filter((value) => value <= max).sort((left, right) => left - right)
}

function defaultContext(choice: ModelChoice | undefined): number | undefined {
  if (!choice) return undefined
  const options = contextOptions(choice)
  return options[0] || choice.contextLength || undefined
}

function normalizeModelSettings(settings: ModelSettings, choice: ModelChoice | undefined): ModelSettings {
  const next: ModelSettings = { ...settings }
  if (choice) {
    const options = contextOptions(choice)
    if (options.length > 0) {
      const requested = next.contextLength || defaultContext(choice)
      next.contextLength = options.includes(requested || 0) ? requested : options[0]
    }
    if (!supportsReasoning(choice)) next.reasoningEffort = "none"
  }
  if (!next.reasoningEffort) next.reasoningEffort = "none"
  if (next.contextLength && !supportsFastContext(next.contextLength)) next.fast = false
  next.fast = Boolean(next.fast)
  return next
}

function supportsFastContext(contextLength: number | undefined): boolean {
  return !contextLength || contextLength <= 300_000
}

function modelEditorRows(choice: ModelChoice, settings: ModelSettings): ModelEditorRow[] {
  const rows: ModelEditorRow[] = []
  for (const option of contextOptions(choice)) {
    rows.push({ kind: "context", label: formatContext(option), value: option, selected: settings.contextLength === option })
  }

  const reasoningOptions: Array<{ label: string; value: ReasoningEffort }> = [
    { label: "None", value: "none" },
    { label: "Low", value: "low" },
    { label: "Medium", value: "medium" },
    { label: "High", value: "high" },
    { label: "Extra High", value: "xhigh" },
  ]
  for (const option of supportsReasoning(choice) ? reasoningOptions : reasoningOptions.slice(0, 1)) {
    rows.push({
      kind: "reasoning",
      label: option.label,
      value: option.value,
      selected: settings.reasoningEffort === option.value,
      disabled: option.value !== "none" && !supportsReasoning(choice),
    })
  }

  rows.push({
    kind: "fast",
    label: "Fast",
    selected: Boolean(settings.fast),
    disabled: !supportsFastContext(settings.contextLength),
  })
  return rows
}

function renderModelEditor(choice: ModelChoice, settings: ModelSettings, selectedIndex: number, width: number): string[] {
  const rows = modelEditorRows(choice, settings)
  const lines = [`${choice.name} - Edit Parameters`, "", "Context"]

  for (const [index, row] of rows.entries()) {
    if (row.kind === "reasoning" && rows[index - 1]?.kind !== "reasoning") lines.push("", "Reasoning")
    if (row.kind === "fast" && rows[index - 1]?.kind !== "fast") lines.push("")

    const cursor = index === selectedIndex ? "→ " : "  "
    const check = row.selected ? "✓" : row.kind === "fast" ? (row.selected ? "[x]" : "[ ]") : ""
    const label = row.kind === "fast" ? `${row.selected ? "[x]" : "[ ]"} ${row.label}` : `${row.label}${check ? ` ${check}` : ""}`
    const text = row.disabled ? dim(label) : label
    lines.push(`${cursor}${text}`)
  }

  const fastDisabled = settings.contextLength && !supportsFastContext(settings.contextLength)
  lines.push("", dim(fastDisabled ? "Fast is disabled for this context window · ↑/↓ navigate · Enter select · Esc back" : "↑/↓ navigate · Enter select · Esc back"))
  return lines.map((line) => truncateToWidth(line, width))
}

class FurnaceThinkingLoader implements Component {
  private frame = 0
  private interval: NodeJS.Timeout | undefined
  private readonly reducedMotion = process.env.FURNACE_REDUCED_MOTION === "1" || process.env.CI === "true" || process.env.TERM === "dumb"

  constructor(
    private readonly tui: TUI,
    private message: string,
  ) {}

  setMessage(message: string): void {
    this.message = message
    this.tui.requestRender()
  }

  start(): void {
    if (this.reducedMotion || this.interval) return
    this.interval = setInterval(() => {
      this.frame = (this.frame + 1) % minimalFrames.length
      this.tui.requestRender()
    }, 90)
  }

  stop(): void {
    if (!this.interval) return
    clearInterval(this.interval)
    this.interval = undefined
  }

  invalidate(): void {}

  render(width: number): string[] {
    const frame = this.reducedMotion ? 0 : this.frame
    const color = pulseColors[frame % pulseColors.length]
    return [`${color}${minimalFrames[frame % minimalFrames.length]}\x1b[39m ${dim(this.message)}${dim(dots(frame))}`].map((line) =>
      truncateToWidth(line, width),
    )
  }
}

const minimalFrames = ["◇", "◈", "◆", "◈"]

const pulseColors = ["\x1b[38;2;80;255;120m", "\x1b[38;2;120;255;190m", "\x1b[38;2;41;220;255m", "\x1b[38;2;120;255;190m"]

function dots(frame: number): string {
  return ".".repeat((frame % 3) + 1)
}

function dim(text: string): string {
  return `\x1b[2m${text}\x1b[22m`
}

function getScrollAmount(data: string): number {
  if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u")) return 10
  if (matchesKey(data, "pageDown") || matchesKey(data, "ctrl+d")) return -10
  if (matchesKey(data, "ctrl+home")) return 100000
  if (matchesKey(data, "ctrl+end")) return -100000

  const mouse = /^\x1b\[<(\d+);\d+;\d+[mM]$/.exec(data)
  if (!mouse) return 0

  const button = Number.parseInt(mouse[1] ?? "", 10)
  if (button === 64) return 3
  if (button === 65) return -3
  return 0
}
