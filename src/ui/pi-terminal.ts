/**
 * Furnace interactive terminal, composed exactly like pi's interactive mode
 * (https://github.com/earendil-works/pi — MIT License, Copyright (c) 2025
 * Mario Zechner). Layout, components, streaming, tool rendering, status
 * indicators, and selector chrome mirror pi's interactive-mode.ts; the data
 * flows through furnace's FurnaceTerminal contract and furnace's own themes.
 */
import {
  Container,
  Input,
  Key,
  matchesKey,
  ProcessTerminal,
  SelectList,
  SettingsList,
  setKeybindings,
  Spacer,
  Text,
  TruncatedText,
  TUI,
  type AutocompleteItem,
  type Component,
  type Terminal,
} from "@earendil-works/pi-tui"
import {
  getEditorTheme,
  getMarkdownTheme,
  getSelectListTheme,
  getSettingsListTheme,
  initTheme,
  onThemeChange,
  setTheme as setPiTheme,
  theme,
} from "./pi/theme.js"
import { KeybindingsManager } from "./pi/keybindings.js"
import { FooterDataProvider } from "./pi/footer-data-provider.js"
import {
  FooterComponent,
  type AgentSession as FooterAgentSession,
  type FooterContextUsage,
  type FooterModel,
  type FooterSessionEntry,
} from "./pi/components/footer.js"
import { CustomEditor } from "./pi/components/custom-editor.js"
import { DynamicBorder } from "./pi/components/dynamic-border.js"
import {
  IdleStatus,
  WorkingStatusIndicator,
  type StatusIndicator,
} from "./pi/components/status-indicator.js"
import { ModelSelectorComponent, type Model as PiSelectorModel } from "./pi/components/model-selector.js"
import { UserMessageComponent } from "./pi/components/user-message.js"
import { AssistantMessageComponent, type AssistantMessage } from "./pi/components/assistant-message.js"
import { ToolExecutionComponent } from "./pi/components/tool-execution.js"
import {
  LAYOUT_OPTIONS,
  LayoutHeaderComponent,
  LayoutTranscriptSurface,
  LayoutTranscriptItem,
} from "./pi/layouts.js"
import { SlashCommandAutocompleteProvider } from "./pi/slash-autocomplete.js"
import { resolveTheme } from "./themes/index.js"
import { packageVersion } from "../version.js"
import type {
  FurnaceTerminal,
  ModelBrowserItem,
  ModelChoice,
  SelectListChoice,
  QueuedPrompt,
  ToolActivity,
  PlanAction,
  PromptAutocompleteItem,
  PromptAutocompleteMatch,
  ProviderDisplayRow,
  StatusNoticeTone,
} from "./terminal-types.js"
import type { AskQuestionItem, AskQuestionRequest, AskQuestionResponse } from "../questions.js"
import type { PermissionDecision, PermissionRequest, PermissionGrantSummary } from "../permissions.js"
import { defaultMaxOutputTokens, normalizeTerminalLayout, statusLinePreferencesFrom, type FurnacePreferences, type ModelSettings, type ReasoningEffort, type StatusLinePreferences, type TerminalLayout } from "../preferences.js"
import type { TranscriptMessage } from "../session/types.js"
import type { AgentMode } from "../plan-mode.js"
import type { ImageAttachment, ImageSource } from "../utils/images.js"
import { saveClipboardImage } from "../utils/clipboard.js"
import { wireSlashAutocompletePreview } from "./pi/autocomplete.js"
import { LayoutEditorFrame } from "./pi/editor-frame.js"

const MAX_VISIBLE_SELECT_LIST = 10
const MAX_VISIBLE_SETTINGS_LIST = 10

export function inputCursorStyleSequence(
  style: "block" | "underscore" | "bar",
  blink: boolean,
): string {
  const code = style === "underscore"
    ? (blink ? 3 : 4)
    : style === "bar"
      ? (blink ? 5 : 6)
      : (blink ? 1 : 2)
  return `\x1b[${code} q`
}

function compactTokenLabel(tokens: number): string {
  if (tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens % 1000 === 0) return `${tokens / 1000}k`
  if (tokens > 1000) return `${Math.round(tokens / 1000)}k`
  return String(tokens)
}

function tokenChoiceLabel(tokens: number): string {
  return `${compactTokenLabel(tokens)} (${tokens})`
}

function parseTokenChoice(value: string): number | undefined {
  const match = /\((\d+)\)$/.exec(value)
  return match ? Number(match[1]) : undefined
}

function uniqueTokenChoices(values: number[]): string[] {
  return [...new Set(values.filter((value) => Number.isInteger(value) && value > 0))]
    .sort((a, b) => a - b)
    .map(tokenChoiceLabel)
}

function currentTokenChoice(configured: number | undefined, fallbackLabel: string): string {
  return configured && configured > 0 ? tokenChoiceLabel(configured) : fallbackLabel
}

function supportsReasoningParameter(choice: ModelChoice): boolean {
  return choice.supportedParameters.includes("reasoning") || choice.supportedParameters.includes("reasoning_effort")
}

function supportsFastContext(contextLength: number | undefined): boolean {
  return !contextLength || contextLength <= 300_000
}

function optionAnswers(question: AskQuestionItem, optionIds: Set<string>): AskQuestionResponse["answers"] {
  return question.options
    .filter((option) => optionIds.has(option.id))
    .map((option) => ({
      answer: option.label,
      kind: "option" as const,
      optionId: option.id,
      questionId: question.id,
    }))
}

interface Expandable {
  setExpanded(expanded: boolean): void
}

function isExpandable(value: unknown): value is Expandable {
  return typeof value === "object"
    && value !== null
    && "setExpanded" in value
    && typeof (value as Expandable).setExpanded === "function"
}

export type CreateFurnaceTerminalOptions = {
  cwd: string
  layout?: TerminalLayout
  model: string
  modelSettings: ModelSettings
  onQueueEdit?: (id: string) => void
  onQueuePromote?: (id: string) => void
  onQueueRemove?: (id: string) => void
  onTaskBackground?: () => void
  onModeCycle?: (direction: 1 | -1) => void
  onInputChange?: (value: string) => void
  statusLine?: StatusLinePreferences
  onAutocompleteTab?: (match: PromptAutocompleteMatch) => boolean
  onBareTab?: (value: string) => boolean
  onAutocompleteHover?: (match: PromptAutocompleteMatch | PromptAutocompleteItem | undefined) => void
  onOpenEditor?: (draft: string) => Promise<string>
  onCopy?: () => void
  onInterrupt?: () => void
  themeName: string
  typingIndicatorBlink?: boolean
  typingIndicator?: "block" | "underscore" | "bar"
  title: string
  onSubmit: (text: string, images?: ImageAttachment[]) => void
  terminal?: Terminal
}

export function createFurnaceTerminal(options: CreateFurnaceTerminalOptions): FurnaceTerminal {
  // Theme must be initialized before any component reads the global theme proxy.
  const initialTheme = resolveTheme(options.themeName)
  let currentThemeName = initialTheme.displayLabel
  initTheme(initialTheme.name)

  const keybindings = KeybindingsManager.create()
  setKeybindings(keybindings)

  const terminal = options.terminal ?? new ProcessTerminal()
  const ui = new TUI(terminal, true)

  // ---------------------------------------------------------------------------
  // Session state mirrored into the pi footer
  // ---------------------------------------------------------------------------

  let currentTitle = options.title
  let currentForkParentTitle: string | undefined
  let currentModel = options.model
  let currentModelDisplayName: string | undefined
  let currentModelSettings: ModelSettings = { ...options.modelSettings }
  let currentMode: AgentMode = "agent"
  let currentLayout = normalizeTerminalLayout(options.layout)
  let currentStatusLine: StatusLinePreferences = { ...options.statusLine }
  let lofiEnabled = false
  let contextUsage: { tokens: number; window: number } | undefined
  let costUsd: number | undefined

  const setInputCursorStyle = (
    style = options.typingIndicator ?? "block",
    blink = options.typingIndicatorBlink === true,
  ): void => {
    terminal.write(inputCursorStyleSequence(style, blink))
  }

  const parseModelRef = (ref: string): { provider: string; id: string } => {
    const slash = ref.indexOf("/")
    if (slash === -1) return { provider: "", id: ref }
    return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) }
  }

  const footerModel = (): FooterModel => {
    const { provider, id } = parseModelRef(currentModel)
    return {
      id,
      provider,
      contextWindow: contextUsage?.window ?? 0,
      name: currentModelDisplayName,
      reasoning: currentModelSettings.reasoningEffort !== undefined,
    }
  }

  const footerSession: FooterAgentSession = {
    get state() {
      return {
        model: footerModel(),
        thinkingLevel: thinkingLevelFromSettings(currentModelSettings),
        fast: currentModelSettings.fast === true && supportsFastContext(currentModelSettings.contextLength),
        mode: currentMode,
        configuredContextWindow: currentModelSettings.contextLength,
        themeName: currentThemeName,
        forkParentTitle: currentForkParentTitle,
      }
    },
    sessionManager: {
      getEntries(): FooterSessionEntry[] {
        if (costUsd === undefined) return []
        return [
          {
            type: "message",
            message: {
              role: "assistant",
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: costUsd } },
            },
          },
        ]
      },
      getCwd: () => options.cwd,
      getSessionName: () => currentTitle,
    },
    modelRegistry: {
      isUsingOAuth: () => false,
    },
    getContextUsage(): FooterContextUsage | undefined {
      if (!contextUsage || contextUsage.window <= 0) return undefined
      return {
        tokens: contextUsage.tokens,
        contextWindow: contextUsage.window,
        percent: (contextUsage.tokens / contextUsage.window) * 100,
      }
    },
  }

  // ---------------------------------------------------------------------------
  // Layout primitives are stable containers. Profiles below recompose those
  // primitives so switching layout never loses transcript or editor state.
  // ---------------------------------------------------------------------------

  const headerContainer = new Container()
  const chatContainer = new Container()
  const pendingMessagesContainer = new Container()
  const statusContainer = new Container()
  const widgetContainerAbove = new Container()
  const editorContainer = new Container()
  const widgetContainerBelow = new Container()

  const editor = new CustomEditor(ui, getEditorTheme(), keybindings, {
    paddingX: 0,
    autocompleteMaxVisible: 10,
  })
  wireSlashAutocompletePreview(editor, options.onAutocompleteHover)
  const slashProvider = new SlashCommandAutocompleteProvider([], options.onAutocompleteTab)
  editor.setAutocompleteProvider(slashProvider)
  const editorFrame = new LayoutEditorFrame(editor, () => currentLayout)
  editorContainer.addChild(editorFrame)

  const footerDataProvider = new FooterDataProvider(options.cwd)
  const footer = new FooterComponent(footerSession, footerDataProvider, options.statusLine)
  const readLayoutState = () => ({
    context: contextUsage,
    costUsd,
    cwd: options.cwd,
    layout: currentLayout,
    mode: currentMode,
    model: currentModelDisplayName || currentModel,
    fast: currentModelSettings.fast === true,
    forkParentTitle: currentForkParentTitle,
    reasoning: currentModelSettings.reasoningEffort ?? "none",
    statusLine: currentStatusLine,
    themeName: currentThemeName,
    title: currentTitle,
    version: packageVersion,
  })
  const layoutHeader = new LayoutHeaderComponent(readLayoutState)
  const transcriptSurface = new LayoutTranscriptSurface(chatContainer, readLayoutState)
  const notebookBottomSpacing = new Spacer(1)
  const notebookStatusBorder = new DynamicBorder()
  headerContainer.addChild(layoutHeader)
  widgetContainerAbove.addChild(new Spacer(2))

  const rebuildRootLayout = () => {
    ui.clear()
    const add = (...components: Component[]) => components.forEach((component) => ui.addChild(component))
    switch (currentLayout) {
      case "console":
        add(headerContainer, statusContainer, pendingMessagesContainer, transcriptSurface, widgetContainerAbove, editorContainer, footer)
        break
      case "notebook":
        add(
          headerContainer,
          transcriptSurface,
          pendingMessagesContainer,
          statusContainer,
          widgetContainerAbove,
          editorContainer,
          notebookBottomSpacing,
          notebookStatusBorder,
          footer,
        )
        break
      case "classic":
      default:
        add(headerContainer, transcriptSurface, pendingMessagesContainer, statusContainer, widgetContainerAbove, editorContainer, widgetContainerBelow, footer)
        break
      case "asteroid":
        add(headerContainer, transcriptSurface, pendingMessagesContainer, statusContainer, widgetContainerAbove, editorContainer, footer)
        break
    }
  }
  rebuildRootLayout()
  ui.setFocus(editor)

  terminal.setTitle(`${currentTitle} — furnace`)

  // ---------------------------------------------------------------------------
  // Status indicators (pi's showStatusIndicator/clearStatusIndicator)
  // ---------------------------------------------------------------------------

  const idleStatus = new IdleStatus()
  let activeStatusIndicator: StatusIndicator | undefined
  let statusNoticeText: Text | undefined
  let statusNotice: { content: string; tone: StatusNoticeTone } | undefined
  let repoIndexStatus: { content: string; tone: StatusNoticeTone } | undefined

  const rebuildStatusContainer = () => {
    statusContainer.clear()
    if (activeStatusIndicator) {
      statusContainer.addChild(activeStatusIndicator)
    } else if (ui.getClearOnShrink()) {
      statusContainer.addChild(idleStatus)
    }
    if (statusNotice) {
      const tone = statusNotice.tone
      const color = tone === "error" ? "error" : tone === "warning" ? "warning" : tone === "success" ? "success" : "dim"
      statusNoticeText = new Text(theme.fg(color, statusNotice.content), 1, 0)
      statusContainer.addChild(statusNoticeText)
    }
    if (repoIndexStatus) {
      const color = repoIndexStatus.tone === "error"
        ? "error"
        : repoIndexStatus.tone === "warning"
          ? "warning"
          : repoIndexStatus.tone === "success"
            ? "success"
            : "dim"
      statusContainer.addChild(new Text(theme.fg(color, repoIndexStatus.content), 1, 0))
    }
  }

  const showStatusIndicator = (indicator: StatusIndicator) => {
    activeStatusIndicator?.dispose()
    activeStatusIndicator = indicator
    rebuildStatusContainer()
  }

  const clearStatusIndicator = () => {
    activeStatusIndicator?.dispose()
    activeStatusIndicator = undefined
    rebuildStatusContainer()
  }

  // ---------------------------------------------------------------------------
  // Chat rendering — mirrors pi's addMessageToChat/renderSessionItems
  // ---------------------------------------------------------------------------

  let toolOutputExpanded = false
  let streamingComponent: AssistantMessageComponent | undefined
  const pendingTools = new Map<string, ToolExecutionComponent>()
  let imageAttachments: ImageAttachment[] = []
  let inputDisabled = false
  let thinking = false

  const toolOptions = () => ({ showImages: true, imageWidthCells: 60 })

  const parseToolArgs = (args: string): unknown => {
    try {
      return JSON.parse(args)
    } catch {
      return args
    }
  }

  const assistantMessageFromText = (text: string): AssistantMessage => ({
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    stopReason: "stop",
  })

  const addUserMessage = (text: string) => {
    if (chatContainer.children.length > 0) {
      chatContainer.addChild(new Spacer(1))
    }
    chatContainer.addChild(new LayoutTranscriptItem(
      new UserMessageComponent(text, getMarkdownTheme(), 1),
      "user",
      () => currentLayout,
    ))
  }

  const addToolComponent = (id: string, name: string, args: string): ToolExecutionComponent => {
    const component = new ToolExecutionComponent(name, id, parseToolArgs(args), toolOptions(), undefined, ui, options.cwd)
    component.setExpanded(toolOutputExpanded)
    chatContainer.addChild(new LayoutTranscriptItem(component, "tool", () => currentLayout))
    return component
  }

  const resultFromText = (text: string, isError: boolean) => ({
    content: [{ type: "text", text }],
    isError,
  })

  const setTranscript = (transcript: TranscriptMessage[]) => {
    chatContainer.clear()
    streamingComponent = undefined
    pendingTools.clear()
    for (const message of transcript) {
      if (message.toolCall) {
        const call = message.toolCall
        const component = addToolComponent(call.toolCallId, call.name, call.args)
        component.setArgsComplete()
        component.markExecutionStarted()
        if (call.result !== undefined) {
          component.updateResult(resultFromText(call.result, call.isError ?? false))
        }
        continue
      }
      if (message.role === "user") {
        const suffix = ""
        addUserMessage(message.content + suffix)
      } else if (message.role === "assistant" && message.content) {
        chatContainer.addChild(new LayoutTranscriptItem(
          new AssistantMessageComponent(assistantMessageFromText(message.content), false, getMarkdownTheme(), "Thinking...", 1),
          "assistant",
          () => currentLayout,
        ))
      }
    }
    ui.requestRender()
  }

  const setStreamingContent = (text: string) => {
    if (!text) {
      // Pi finalizes the current streaming block when a tool call begins; the
      // next text delta starts a fresh assistant block below the tools.
      streamingComponent = undefined
      return
    }
    if (!streamingComponent) {
      streamingComponent = new AssistantMessageComponent(undefined, false, getMarkdownTheme(), "Thinking...", 1)
      chatContainer.addChild(new LayoutTranscriptItem(streamingComponent, "assistant", () => currentLayout))
    }
    streamingComponent.updateContent(assistantMessageFromText(text))
    ui.requestRender()
  }

  const setToolActivities = (activities: ToolActivity[]) => {
    for (const activity of activities) {
      let component = pendingTools.get(activity.id)
      if (!component) {
        component = addToolComponent(activity.id, activity.name, activity.args)
        component.setArgsComplete()
        pendingTools.set(activity.id, component)
      }
      if (activity.status === "running") {
        component.markExecutionStarted()
      } else if (activity.result !== undefined || activity.status === "failed") {
        component.updateResult(resultFromText(activity.result ?? "", activity.status === "failed"))
      }
    }
    ui.requestRender()
  }

  const clearToolActivities = () => {
    pendingTools.clear()
  }

  const clearTranscriptDisplay = () => {
    chatContainer.clear()
    streamingComponent = undefined
    pendingTools.clear()
    ui.requestRender()
  }

  const setToolsExpanded = (expanded: boolean) => {
    toolOutputExpanded = expanded
    layoutHeader.setExpanded(expanded)
    for (const child of chatContainer.children) {
      if (isExpandable(child)) {
        child.setExpanded(expanded)
      }
    }
    ui.requestRender()
  }

  // ---------------------------------------------------------------------------
  // Working indicator / status notices
  // ---------------------------------------------------------------------------

  const setThinking = (value: boolean, message?: string) => {
    thinking = value
    if (value) {
      showStatusIndicator(new WorkingStatusIndicator(ui, interruptHint(message ?? "Thinking")))
    } else {
      clearStatusIndicator()
    }
    ui.requestRender()
  }

  const setBusy = (value: boolean) => {
    if (value && !thinking) {
      showStatusIndicator(new WorkingStatusIndicator(ui, interruptHint("Working")))
    } else if (!value && !thinking) {
      clearStatusIndicator()
    }
    ui.requestRender()
  }

  const interruptHint = (message: string): string => `${message} [Esc to interrupt]`

  const setStatusNotice = (content?: string, tone?: StatusNoticeTone) => {
    statusNotice = content ? { content, tone: tone ?? "default" } : undefined
    rebuildStatusContainer()
    ui.requestRender()
  }

  const setRepoIndexStatus = (content?: string, tone?: StatusNoticeTone) => {
    repoIndexStatus = content ? { content, tone: tone ?? "default" } : undefined
    rebuildStatusContainer()
    ui.requestRender()
  }

  // ---------------------------------------------------------------------------
  // Pending (queued) prompts — pi's updatePendingMessagesDisplay
  // ---------------------------------------------------------------------------

  let queuedPrompts: QueuedPrompt[] = []

  const updatePendingMessagesDisplay = () => {
    pendingMessagesContainer.clear()
    const visible = queuedPrompts.filter((prompt) => !prompt.hidden)
    if (visible.length === 0) return
    pendingMessagesContainer.addChild(new Spacer(1))
    for (const prompt of visible) {
      pendingMessagesContainer.addChild(new TruncatedText(theme.fg("dim", `Follow-up: ${prompt.text}`), 1, 0))
    }
    const dequeueKeys = keybindings.getKeys("app.message.dequeue")
    if (dequeueKeys.length > 0) {
      pendingMessagesContainer.addChild(new TruncatedText(theme.fg("dim", `↳ ${dequeueKeys[0]} to edit all queued messages`), 1, 0))
    }
  }

  const setQueuedPrompts = (prompts: QueuedPrompt[]) => {
    queuedPrompts = prompts
    updatePendingMessagesDisplay()
    ui.requestRender()
  }

  // ---------------------------------------------------------------------------
  // Footer state feeds
  // ---------------------------------------------------------------------------

  const updateFooterStatuses = () => {
    footerDataProvider.setExtensionStatus("mode", undefined)
    footerDataProvider.setExtensionStatus("lofi", lofiEnabled ? "lofi" : undefined)
    footer.invalidate()
    ui.requestRender()
  }

  const setModel = (model: string, settings: ModelSettings, displayName?: string) => {
    currentModel = model
    currentModelDisplayName = displayName
    currentModelSettings = { ...settings }
    updateEditorBorderColor()
    footer.invalidate()
    ui.requestRender()
  }

  const setTitle = (title: string) => {
    currentTitle = title
    terminal.setTitle(`${title} — furnace`)
    footer.invalidate()
    ui.requestRender()
  }

  const setMode = (mode: AgentMode, _planPath?: string) => {
    currentMode = mode
    updateFooterStatuses()
  }

  const setContextUsage = (tokens: number, window: number) => {
    contextUsage = { tokens, window }
    footer.invalidate()
    ui.requestRender()
  }

  const setCostUsage = (cost?: number) => {
    costUsd = cost
    footer.invalidate()
    ui.requestRender()
  }

  const setLofi = (enabled: boolean) => {
    lofiEnabled = enabled
    updateFooterStatuses()
  }

  const setSessionMeta = (meta: { forkParentTitle?: string; title: string }) => {
    currentForkParentTitle = meta.forkParentTitle
    setTitle(meta.title)
  }

  const setStatusLinePreferences = (prefs: StatusLinePreferences) => {
    currentStatusLine = { ...prefs }
    footer.setStatusLinePreferences(currentStatusLine)
    footer.invalidate()
    ui.requestRender()
  }

  const setTheme = (themeName: string) => {
    const choice = resolveTheme(themeName)
    currentThemeName = choice.displayLabel
    setPiTheme(choice.name)
  }

  const setLayout = (layout: TerminalLayout) => {
    currentLayout = normalizeTerminalLayout(layout)
    rebuildRootLayout()
    ui.invalidate()
    ui.requestRender(true)
  }

  onThemeChange(() => {
    ui.invalidate()
    updateEditorBorderColor()
    footer.invalidate()
    ui.requestRender()
  })

  footerDataProvider.onBranchChange(() => {
    ui.requestRender()
  })

  // ---------------------------------------------------------------------------
  // Editor wiring — pi's setupKeyHandlers/setupEditorSubmitHandler
  // ---------------------------------------------------------------------------

  function thinkingLevelFromSettings(settings: ModelSettings): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" {
    const effort: ReasoningEffort | "none" = settings.reasoningEffort ?? "none"
    return effort === "none" ? "off" : effort
  }

  function updateEditorBorderColor(): void {
    editor.borderColor = theme.getThinkingBorderColor(thinkingLevelFromSettings(currentModelSettings))
    ui.requestRender()
  }
  updateEditorBorderColor()

  const CTRL_C_EXIT_WINDOW_MS = 2000

  let awaitingExitConfirmation = false
  let exitWarningTimer: ReturnType<typeof setTimeout> | undefined
  let runResolve: (() => void) | undefined

  const stop = () => {
    if (exitWarningTimer) clearTimeout(exitWarningTimer)
    footerDataProvider.dispose()
    footer.dispose()
    terminal.write("\x1b[0 q")
    ui.stop()
    runResolve?.()
  }

  const clearExitWarning = () => {
    if (exitWarningTimer) {
      clearTimeout(exitWarningTimer)
      exitWarningTimer = undefined
    }
    if (awaitingExitConfirmation) {
      awaitingExitConfirmation = false
      setStatusNotice(undefined)
    }
  }

  const handleCtrlC = () => {
    if (awaitingExitConfirmation) {
      clearExitWarning()
      stop()
      return
    }
    awaitingExitConfirmation = true
    options.onInterrupt?.()
    editor.setText("")
    setStatusNotice("Ctrl+C again to exit", "warning")
    ui.requestRender()
    exitWarningTimer = setTimeout(clearExitWarning, CTRL_C_EXIT_WINDOW_MS)
  }

  editor.onAction("app.clear", handleCtrlC)
  editor.onCtrlD = () => {
    if (!editor.getText().trim()) stop()
  }
  editor.onEscape = () => {
    options.onInterrupt?.()
  }
  editor.onAction("app.tools.expand", () => setToolsExpanded(!toolOutputExpanded))
  editor.onAction("app.editor.external", () => {
    if (!options.onOpenEditor) return
    void options.onOpenEditor(editor.getText()).then((updated) => {
      editor.setText(updated)
      ui.requestRender()
    })
  })
  editor.onAction("app.message.dequeue", () => {
    const first = queuedPrompts.find((prompt) => !prompt.hidden)
    if (first) options.onQueueEdit?.(first.id)
  })

  editor.onSubmit = (text: string) => {
    if (inputDisabled) return
    const trimmed = text.trim()
    if (!trimmed) return
    editor.addToHistory(trimmed)
    editor.setText("")
    options.onSubmit(trimmed, imageAttachments)
    imageAttachments = []
  }

  editor.onChange = (value: string) => {
    options.onInputChange?.(value)
  }

  // Wire up clipboard image paste (Ctrl+V / Cmd+V / Alt+V).
  // Saves the clipboard image to .furnace/images/, assigns a sequential label,
  // and inserts [Image #N] at the cursor so the token references the attachment.
  editor.onPasteImage = () => {
    void (async () => {
      const label = String(imageAttachments.length + 1)
      const timestamp = Date.now()
      const imgDir = `${options.cwd}/.furnace/images`
      const imgPath = `${imgDir}/clip_${timestamp}.png`

      const saved = await saveClipboardImage(imgPath)
      if (!saved) {
        setStatusNotice("No image in clipboard", "warning")
        return
      }

      try {
        const { readFile } = await import("node:fs/promises")
        const buffer = await readFile(imgPath)
        const base64 = buffer.toString("base64")
        const size = buffer.length

        imageAttachments.push({
          id: crypto.randomUUID(),
          source: { type: "base64", media_type: "image/png", data: base64 },
          displayName: `clip_${timestamp}.png`,
          size,
          label,
        })

        editor.insertTextAtCursor(`[Image #${label}]`)
        ui.requestRender()
      } catch {
        setStatusNotice("Failed to read clipboard image", "error")
      }
    })()
  }

  // Global fallback so Ctrl+C works while a selector has focus, like pi's
  // SIGINT handling.
  ui.addInputListener((data) => {
    if (matchesKey(data, Key.ctrl("c"))) {
      handleCtrlC()
      return { consume: true }
    }
    return undefined
  })

  // ---------------------------------------------------------------------------
  // Selectors and dialogs — pi's showSelector pattern: the editor is swapped
  // out for a panel framed by DynamicBorders, focus moves to the panel, and
  // Esc/selection restores the editor.
  // ---------------------------------------------------------------------------

  const restoreEditor = () => {
    editorContainer.clear()
    editorContainer.addChild(editorFrame)
    ui.setFocus(editor)
    ui.requestRender()
  }

  const showSelectorPanel = (title: string, build: (done: () => void) => { component: Component; focus: Component }) => {
    const done = () => restoreEditor()
    const { component, focus } = build(done)
    const panel = new Container()
    panel.addChild(new DynamicBorder())
    panel.addChild(new Spacer(1))
    if (title) {
      panel.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0))
      panel.addChild(new Spacer(1))
    }
    panel.addChild(component)
    panel.addChild(new DynamicBorder())
    editorContainer.clear()
    editorContainer.addChild(panel)
    ui.setFocus(focus)
    ui.requestRender()
  }

  const selectListPanel = (
    title: string,
    items: AutocompleteItem[],
    onSelect: (item: AutocompleteItem) => void,
    onCancel: (() => void) | null,
    extras?: Component[],
    initialValue?: string,
  ) => {
    showSelectorPanel(title, (done) => {
      const list = new SelectList(items, MAX_VISIBLE_SELECT_LIST, getSelectListTheme())
      const initialIndex = initialValue ? items.findIndex((item) => item.value === initialValue) : -1
      if (initialIndex >= 0) list.setSelectedIndex(initialIndex)
      list.onSelect = (item) => {
        done()
        onSelect(item)
      }
      if (onCancel !== null) {
        list.onCancel = () => {
          done()
          onCancel()
        }
      }
      const wrapper = new Container()
      for (const extra of extras ?? []) {
        wrapper.addChild(extra)
        wrapper.addChild(new Spacer(1))
      }
      wrapper.addChild(list)
      return { component: wrapper, focus: list }
    })
  }

  editor.onPasteMarkerBackspace = ({ deletePaste, editPaste }) => {
    const items: AutocompleteItem[] = [
      { value: "edit", label: "Edit pasted text", description: "Expand the full paste in the input area" },
      { value: "delete", label: "Delete entire paste", description: "Remove the collapsed paste in one step" },
      { value: "cancel", label: "Cancel" },
    ]
    selectListPanel("Pasted text", items, (item) => {
      if (item.value === "edit") editPaste()
      if (item.value === "delete") deletePaste()
      ui.requestRender()
    }, () => {})
  }

  const showQuestionPrompt = (request: AskQuestionRequest, resolve: (response: AskQuestionResponse) => void) => {
    const answers: AskQuestionResponse["answers"] = []

    const finishQuestion = (index: number, questionAnswers: AskQuestionResponse["answers"]): void => {
      answers.push(...questionAnswers)
      const nextIndex = index + 1
      if (nextIndex >= request.questions.length) {
        resolve({ answers })
        return
      }
      showQuestion(nextIndex)
    }

    const showCustomInput = (index: number, selectedOptionIds: Set<string>): void => {
      const question = request.questions[index]
      showSelectorPanel(`${question.prompt} — custom answer`, (done) => {
        const customInput = new Input()
        customInput.onSubmit = (value) => {
          const custom = value.trim()
          if (!custom) return
          done()
          finishQuestion(index, [
            ...optionAnswers(question, selectedOptionIds),
            { answer: custom, kind: "custom", questionId: question.id },
          ])
        }
        customInput.onEscape = () => {
          done()
          showQuestion(index, selectedOptionIds, "__custom")
        }
        return { component: customInput, focus: customInput }
      })
    }

    const showQuestion = (index: number, selectedOptionIds = new Set<string>(), selectedValue?: string): void => {
      const question = request.questions[index]
      const items: AutocompleteItem[] = question.options.map((option) => ({
        value: option.id,
        label: question.allowMultiple
          ? `${selectedOptionIds.has(option.id) ? "[x]" : "[ ]"} ${option.label}`
          : option.label,
        description: option.description,
      }))
      if (question.allowMultiple) {
        items.push({ value: "__done", label: "Done", description: "Submit selected answers" })
      }
      if (question.allowCustom) items.push({ value: "__custom", label: "Write a custom answer" })
      if (question.allowRefuse !== false) items.push({ value: "__refuse", label: "Refuse to answer" })

      selectListPanel(
        request.questions.length > 1 ? `${index + 1}/${request.questions.length} · ${question.prompt}` : question.prompt,
        items,
        (item) => {
          if (item.value === "__custom") {
            showCustomInput(index, selectedOptionIds)
            return
          }
          if (item.value === "__refuse") {
            finishQuestion(index, [{ answer: "refused", kind: "refuse", questionId: question.id }])
            return
          }
          if (item.value === "__done") {
            if (selectedOptionIds.size === 0) {
              showQuestion(index, selectedOptionIds, item.value)
              return
            }
            finishQuestion(index, optionAnswers(question, selectedOptionIds))
            return
          }
          if (question.allowMultiple) {
            if (selectedOptionIds.has(item.value)) selectedOptionIds.delete(item.value)
            else selectedOptionIds.add(item.value)
            showQuestion(index, selectedOptionIds, item.value)
            return
          }
          finishQuestion(index, optionAnswers(question, new Set([item.value])))
        },
        question.allowRefuse === false ? null : () => resolve({ rejected: true, answers: [] }),
        undefined,
        selectedValue,
      )
    }

    showQuestion(0)
  }

  const showApprovalPrompt = (request: PermissionRequest, resolve: (decision: PermissionDecision) => void) => {
    const items: AutocompleteItem[] = [
      { value: "allow_once", label: "Allow this time" },
      { value: "allow_tool_session", label: "Allow for this session" },
      { value: "allow_all_session", label: "Allow all for this session" },
      { value: "deny", label: "Deny" },
    ]
    const argsText = new Text(theme.bg("toolPendingBg", theme.fg("toolTitle", ` ${request.toolName} `) + theme.fg("toolOutput", request.args)), 1, 0)
    selectListPanel(
      "Permission required",
      items,
      (item) => resolve(item.value as PermissionDecision),
      () => resolve("deny"),
      [argsText],
    )
  }

  const requestQuestions = (request: AskQuestionRequest): Promise<AskQuestionResponse> =>
    new Promise((resolve) => showQuestionPrompt(request, resolve))

  const requestApproval = (request: PermissionRequest): Promise<PermissionDecision> =>
    new Promise((resolve) => showApprovalPrompt(request, resolve))

  const showModelEditor = (
    choice: ModelChoice,
    settings: ModelSettings,
    onSelect: (model: string, settings: ModelSettings, done: boolean) => void,
    onCancel: () => void,
  ) => {
    const supportsReasoning = supportsReasoningParameter(choice)
    const updatedSettings: ModelSettings = { ...settings }
    const autoContextLabel = choice.contextLength ? `auto (${compactTokenLabel(choice.contextLength)})` : "auto"
    const contextValues = [
      autoContextLabel,
      ...uniqueTokenChoices([
        32_000,
        64_000,
        128_000,
        200_000,
        ...(choice.contextLength ? [choice.contextLength] : []),
        ...(settings.contextLength ? [settings.contextLength] : []),
      ]),
    ]
    const defaultMaxOutputLabel = `default (${defaultMaxOutputTokens})`
    const maxOutputValues = [
      defaultMaxOutputLabel,
      ...uniqueTokenChoices([
        1024,
        2048,
        4096,
        defaultMaxOutputTokens,
        12_000,
        16_000,
        32_000,
        ...(settings.maxOutputTokens ? [settings.maxOutputTokens] : []),
      ]),
    ]

    const settingItems = [
      {
        id: "contextLength",
        label: "Context window",
        description: "Auto uses the selected model's advertised context window",
        currentValue: currentTokenChoice(settings.contextLength, autoContextLabel),
        values: contextValues,
      },
      {
        id: "maxOutputTokens",
        label: "Max output tokens",
        description: "Caps one assistant turn; lower values avoid huge provider reservations",
        currentValue: currentTokenChoice(settings.maxOutputTokens, defaultMaxOutputLabel),
        values: maxOutputValues,
      },
      ...(supportsReasoning
        ? [{
            id: "reasoning",
            label: "Reasoning effort",
            description: "Controls provider reasoning/thinking budget when the model supports it",
            currentValue: settings.reasoningEffort ?? "none",
            values: ["none", "low", "medium", "high", "xhigh"],
          }]
        : []),
      {
        id: "fast",
        label: "Fast provider routing",
        description: "Prefer throughput routing when context is 300K or less",
        currentValue: settings.fast && supportsFastContext(settings.contextLength) ? "on" : "off",
        values: ["on", "off"],
      },
      // SettingsList only fires onChange for items with a non-empty values
      // list (Enter cycles values); a single empty value makes Enter on
      // "Save" fire onChange.
      { id: "done", label: "Save and use model", currentValue: "Enter", values: ["Enter"] },
    ]

    showSelectorPanel(`Model: ${choice.name}`, (done) => {
      const list = new SettingsList(
        settingItems,
        MAX_VISIBLE_SETTINGS_LIST,
        getSettingsListTheme(),
        (id, value) => {
          if (id === "done") {
            done()
            onSelect(choice.id, updatedSettings, true)
            return
          }
          if (id === "contextLength") {
            const parsed = parseTokenChoice(value)
            if (parsed) updatedSettings.contextLength = parsed
            else delete updatedSettings.contextLength
            if (!supportsFastContext(updatedSettings.contextLength)) {
              updatedSettings.fast = false
              list.updateValue("fast", "off")
            }
          }
          if (id === "maxOutputTokens") {
            const parsed = parseTokenChoice(value)
            if (parsed) updatedSettings.maxOutputTokens = parsed
            else delete updatedSettings.maxOutputTokens
          }
          if (id === "reasoning") updatedSettings.reasoningEffort = value as ReasoningEffort
          if (id === "fast") updatedSettings.fast = value === "on" && supportsFastContext(updatedSettings.contextLength)
          onSelect(choice.id, updatedSettings, false)
        },
        () => {
          done()
          onCancel()
        },
      )
      return { component: list, focus: list }
    })
  }

  const showModelSelector = (
    models: ModelBrowserItem[],
    currentModelId: string | undefined,
    onSelect: (model: ModelBrowserItem) => void,
    onCancel: () => void,
  ) => {
    const piModels: PiSelectorModel[] = models.map((model) => ({
      id: model.id,
      provider: model.providerId,
      name: model.name,
      reasoning: model.supportedParameters.includes("reasoning"),
      contextWindow: model.contextLength ?? undefined,
    }))
    const registry = {
      refresh: () => {},
      getError: () => undefined,
      getAvailable: async () => piModels,
      find: (provider: string, id: string) => piModels.find((model) => model.provider === provider && model.id === id),
    }
    const currentModel = piModels.find((model) => model.id === currentModelId)

    // The pi model selector brings its own border/search chrome, so it mounts
    // raw in the editor slot exactly like pi's showSelector does.
    const done = () => restoreEditor()
    const selector = new ModelSelectorComponent(
      ui,
      currentModel,
      { setDefaultModelAndProvider: () => {} },
      registry,
      [],
      (model) => {
        done()
        const match = models.find((candidate) => candidate.id === model.id && candidate.providerId === model.provider)
        if (match) onSelect(match)
      },
      () => {
        done()
        onCancel()
      },
    )
    editorContainer.clear()
    editorContainer.addChild(selector)
    ui.setFocus(selector)
    ui.requestRender()
  }

  const showSelectList = (title: string, items: SelectListChoice[], onSelect: (value: string) => void, onCancel: () => void) => {
    selectListPanel(
      title,
      items.map((item) => ({ value: item.value, label: item.label, description: item.description })),
      (item) => onSelect(item.value),
      onCancel,
    )
  }

  const showPermissions = (
    grants: PermissionGrantSummary[],
    onRemove: (grant: PermissionGrantSummary) => void,
    onClearAll: () => void,
    onCancel: () => void,
  ) => {
    const items: AutocompleteItem[] = [
      ...grants.map((grant, index) => ({
        value: String(index),
        label: grant.kind === "allow_all" ? "Allow all" : grant.rule.permission,
        description: grant.kind === "allow_all" ? "All tools" : grant.rule.pattern,
      })),
      { value: "__clear_all__", label: "Clear all session grants" },
    ]
    selectListPanel(
      "Permissions — select a grant to remove",
      items,
      (item) => {
        if (item.value === "__clear_all__") {
          onClearAll()
        } else {
          const grant = grants[Number(item.value)]
          if (grant) onRemove(grant)
        }
        onCancel()
      },
      onCancel,
    )
  }

  const showPlanActions = (planPath: string, onSelect: (action: PlanAction) => void) => {
    const items: AutocompleteItem[] = [
      { value: "execute", label: "Execute plan" },
      { value: "refine", label: "Refine plan" },
      { value: "stay", label: "Stay in plan mode" },
    ]
    selectListPanel(`Plan ready: ${planPath}`, items, (item) => onSelect(item.value as PlanAction), () => onSelect("stay"))
  }

  const showSettings = (prefs: FurnacePreferences, onSave: (prefs: FurnacePreferences) => void) => {
    let currentPrefs = { ...prefs }
    const contextValue = (): string => {
      if (currentPrefs.statusContextMode === "off" || currentPrefs.statusShowContext === false) return "off"
      if (currentPrefs.statusContextMode === "percent") return "percent only"
      if (currentPrefs.statusContextMode === "tokens-percent" || currentPrefs.statusShowContextPercent === true) return "percent"
      return "on"
    }

    const currentLayoutOption = LAYOUT_OPTIONS.find((option) => option.value === normalizeTerminalLayout(currentPrefs.layout))
    const settingItems = [
      {
        id: "layout",
        label: "Interface layout",
        description: currentLayoutOption?.description,
        currentValue: currentLayoutOption?.label ?? "Classic",
        values: LAYOUT_OPTIONS.map((option) => option.label),
      },
      { id: "typingIndicator", label: "Input cursor", currentValue: currentPrefs.typingIndicator ?? "block", values: ["block", "underscore", "bar"] },
      { id: "typingIndicatorBlink", label: "Input cursor blink", currentValue: currentPrefs.typingIndicatorBlink === true ? "on" : "off", values: ["off", "on"] },
      { id: "notifications", label: "Notifications", currentValue: currentPrefs.notifications === true ? "on" : "off", values: ["off", "on"] },
      {
        id: "repoIndexPolicy",
        label: "Repo reindexing",
        description: "Let the agent maintain the index, or refresh it after upstream changes",
        currentValue: currentPrefs.repoIndexPolicy === "every-git-push" ? "every git push" : "agent decides",
        values: ["agent decides", "every git push"],
      },
      { id: "statusShowAppName", label: "App name", currentValue: currentPrefs.statusShowAppName === false ? "off" : "on", values: ["on", "off"] },
      { id: "statusShowCwd", label: "Cwd", currentValue: currentPrefs.statusShowCwd === false ? "off" : "on", values: ["on", "off"] },
      { id: "statusShowTitle", label: "Title", currentValue: currentPrefs.statusShowTitle === false ? "off" : "on", values: ["on", "off"] },
      { id: "statusShowContext", label: "Context", currentValue: contextValue(), values: ["on", "percent", "percent only", "off"] },
      { id: "statusShowCost", label: "Cost", currentValue: currentPrefs.statusShowCost === false ? "off" : "on", values: ["on", "off"] },
      { id: "statusShowMode", label: "Mode", currentValue: currentPrefs.statusShowMode === false ? "off" : "on", values: ["on", "off"] },
      { id: "statusShowWindow", label: "Window", currentValue: currentPrefs.statusShowWindow === false ? "off" : "on", values: ["on", "off"] },
      { id: "statusShowTheme", label: "Theme", currentValue: currentPrefs.statusShowTheme === false ? "off" : "on", values: ["on", "off"] },
      { id: "statusShowModel", label: "Model", currentValue: currentPrefs.statusShowModel === false ? "off" : "on", values: ["on", "off"] },
      { id: "statusShowReasoning", label: "Reasoning", currentValue: currentPrefs.statusShowReasoning === false ? "off" : "on", values: ["on", "off"] },
      { id: "statusShowFast", label: "Fast routing", currentValue: currentPrefs.statusShowFast === false ? "off" : "on", values: ["on", "off"] },
      { id: "statusShowForkParent", label: "Fork parent", currentValue: currentPrefs.statusShowForkParent === false ? "off" : "on", values: ["on", "off"] },
    ]

    showSelectorPanel("Settings", (done) => {
      const list = new SettingsList(
        settingItems,
        MAX_VISIBLE_SETTINGS_LIST,
        getSettingsListTheme(),
        (id, value) => {
          const updated = { ...currentPrefs }
          switch (id) {
            case "layout":
              updated.layout = LAYOUT_OPTIONS.find((option) => option.label === value)?.value ?? "classic"
              break
            case "typingIndicator":
              updated.typingIndicator = value as "block" | "underscore" | "bar"
              break
            case "typingIndicatorBlink":
              updated.typingIndicatorBlink = value === "on"
              break
            case "notifications":
              updated.notifications = value === "on"
              break
            case "repoIndexPolicy":
              updated.repoIndexPolicy = value === "every git push" ? "every-git-push" : "agent-decides"
              break
            case "statusShowContext":
              updated.statusContextMode = value === "off" ? "off" : value === "percent only" ? "percent" : value === "percent" ? "tokens-percent" : "tokens"
              updated.statusShowContext = value !== "off"
              updated.statusShowContextPercent = value === "percent"
              break
            default:
              if (id.startsWith("statusShow")) {
                ;(updated as Record<string, boolean | undefined>)[id] = value === "on"
              }
              break
          }
          currentPrefs = updated
          currentStatusLine = statusLinePreferencesFrom(updated)
          setInputCursorStyle(updated.typingIndicator, updated.typingIndicatorBlink === true)
          onSave(updated)
        },
        () => done(),
      )
      return { component: list, focus: list }
    })
  }

  const showApiKeySetup = (_provider: string, label: string, onSave: (key: string) => void, onCancel: () => void) => {
    showSelectorPanel(`Enter API key for ${label}`, (done) => {
      const wrapper = new Container()
      wrapper.addChild(new Text(theme.fg("dim", "Paste or type the key, then press Enter. Esc to cancel."), 1, 0))
      wrapper.addChild(new Spacer(1))
      const keyInput = new Input()
      keyInput.onSubmit = (value) => {
        done()
        onSave(value)
      }
      keyInput.onEscape = () => {
        done()
        onCancel()
      }
      wrapper.addChild(keyInput)
      return { component: wrapper, focus: keyInput }
    })
  }

  const showProviderSelector = (
    rows: ProviderDisplayRow[],
    onSelect: (providerId: string) => void,
    onCancel: () => void,
    onDelete?: (providerId: string) => void,
  ) => {
    const items: AutocompleteItem[] = rows.map((row) => ({
      value: row.id,
      label: row.displayName,
      description: `${row.status}${row.sourceLabel ? ` · ${row.sourceLabel}` : ""}`,
    }))
    selectListPanel(
      "Login — choose a provider",
      items,
      (item) => {
        const row = rows.find((candidate) => candidate.id === item.value)
        if (row?.canDelete && onDelete) {
          const actionItems: AutocompleteItem[] = [
            { value: "edit", label: `Edit ${row.displayName} key` },
            { value: "delete", label: `Delete ${row.displayName} key` },
          ]
          selectListPanel(
            row.displayName,
            actionItems,
            (actionItem) => {
              if (actionItem.value === "delete") {
                onDelete(row.id)
              } else {
                onSelect(row.id)
              }
            },
            () => {},
          )
          return
        }
        onSelect(item.value)
      },
      onCancel,
    )
  }

  const clearInteractionPrompts = () => {
    restoreEditor()
  }

  const clearPlanActions = () => {
    restoreEditor()
  }

  const suspendForEditor = (draft: string): Promise<string> => {
    return new Promise((resolve) => {
      showSelectorPanel("Edit prompt", (done) => {
        const editorInput = new Input()
        editorInput.setValue(draft)
        editorInput.onSubmit = (value) => {
          done()
          resolve(value)
        }
        editorInput.onEscape = () => {
          done()
          resolve(draft)
        }
        return { component: editorInput, focus: editorInput }
      })
    })
  }

  // ---------------------------------------------------------------------------
  // Misc contract methods
  // ---------------------------------------------------------------------------

  const insertImageAttachment = (source: ImageSource, opts?: { displayName?: string; size?: number }) => {
    imageAttachments.push({ id: crypto.randomUUID(), source, displayName: opts?.displayName, size: opts?.size })
    setStatusNotice(`Image attached${opts?.displayName ? `: ${opts.displayName}` : ""}`, "success")
  }

  const setInputDraft = (value: string) => {
    editor.setText(value)
    ui.requestRender()
  }

  const setInputDisabled = (disabled: boolean) => {
    inputDisabled = disabled
    editor.setInputDisabled(disabled)
    ui.requestRender()
  }

  const setSlashCommandItems = (items: PromptAutocompleteItem[]) => {
    slashProvider.setItems(items)
  }

  const run = (): Promise<void> => {
    return new Promise((resolve) => {
      runResolve = resolve
      ui.start()
      setInputCursorStyle()
      ui.requestRender()
    })
  }

  return {
    clearInteractionPrompts,
    clearPlanActions,
    clearToolActivities,
    clearTranscriptDisplay,
    insertImageAttachment,
    requestApproval,
    requestQuestions,
    run,
    setBusy,
    setContextUsage,
    setCostUsage,
    setInputDisabled,
    setInputDraft,
    setLayout,
    setLofi,
    setMode,
    setModel,
    setQueuedPrompts,
    setRepoIndexStatus,
    setSessionMeta,
    setSlashCommandItems,
    setStatusLinePreferences,
    setStatusNotice,
    setStreamingContent,
    setTheme,
    setThinking,
    setTitle,
    setToolActivities,
    setTranscript,
    showApiKeySetup,
    showApprovalPrompt,
    showModelEditor,
    showModelSelector,
    showPermissions,
    showPlanActions,
    showProviderSelector,
    showQuestionPrompt,
    showSelectList,
    showSettings,
    stop,
    suspendForEditor,
  }
}
