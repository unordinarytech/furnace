import {
  Container,
  Editor,
  Input,
  Markdown,
  type MarkdownTheme,
  ProcessTerminal,
  SelectList,
  SettingsList,
  Spacer,
  Text,
  TUI,
  type Component,
  type SelectListTheme,
  type AutocompleteItem,
  type Terminal,
} from "@earendil-works/pi-tui"
import type {
  FurnaceTerminal,
  ModelChoice,
  PinnedChatSummary,
  QueuedPrompt,
  ToolActivity,
  PlanAction,
  PromptAutocompleteItem,
  PromptAutocompleteMatch,
  ProviderDisplayRow,
  StatusNoticeTone,
} from "./terminal-types.js"
import { resolveTheme } from "./terminal-themes/index.js"
import {
  getPiMarkdownTheme,
  getPiEditorTheme,
  getPiSelectListTheme,
  getPiSettingsListTheme,
  getPiStatusStyle,
  getPiBorderColor,
} from "./pi-themes.js"
import { AssistantMessageComponent, bgColor, fgColor, UserMessageComponent } from "./pi-components/messages.js"
import { FooterComponent, getCurrentGitBranch, type FooterData } from "./pi-components/footer.js"
import { SlashCommandAutocompleteProvider } from "./pi-components/slash-autocomplete.js"
import { ToolActivityComponent } from "./pi-components/tool-activity.js"
import type { Theme } from "./themes/types.js"
import type { AskQuestionRequest, AskQuestionResponse } from "../questions.js"
import type { PermissionDecision, PermissionRequest, PermissionGrantSummary } from "../permissions.js"
import type { FurnacePreferences, ModelSettings, StatusLinePreferences } from "../preferences.js"
import type { TranscriptMessage } from "../session/types.js"
import type { TaskRecord } from "../tasks/types.js"
import type { AgentMode } from "../plan-mode.js"
import type { ImageAttachment, ImageSource } from "../utils/images.js"

const MAX_VISIBLE_SELECT_LIST = 10
const MAX_VISIBLE_SETTINGS_LIST = 10

export type CreateFurnaceTerminalOptions = {
  cwd: string
  model: string
  modelSettings: ModelSettings
  onQueueEdit?: (id: string) => void
  onQueuePromote?: (id: string) => void
  onQueueRemove?: (id: string) => void
  onPinnedSelect?: (slot: number) => void
  onPinnedUnpin?: (slot: number) => void
  onTaskBackground?: () => void
  onModeCycle?: (direction: 1 | -1) => void
  onInputChange?: (value: string) => void
  inputMode?: "standard" | "vim"
  sidebarEnabled?: boolean
  statusLine?: StatusLinePreferences
  onSidebarToggle?: (enabled: boolean) => void
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
  const terminal = options.terminal ?? new ProcessTerminal()
  const ui = new TUI(terminal, true)

  const themeChoice = resolveTheme(options.themeName)
  const theme = themeChoice.theme
  const markdownTheme = getPiMarkdownTheme(theme)
  const editorTheme = getPiEditorTheme(theme)
  const selectListTheme = getPiSelectListTheme(theme)
  const settingsListTheme = getPiSettingsListTheme(theme)
  const statusStyle = getPiStatusStyle(theme)
  const borderColor = getPiBorderColor(theme)

  const header = new Container()
  const chatContainer = new Container()
  const statusContainer = new Container()
  const editorContainer = new Container()
  const sidebar = new Container()
  const sidebarContainer = new Container()
  const inputRow = new Container()
  const input = new Editor(ui, editorTheme, { paddingX: 1, autocompleteMaxVisible: 10 })
  const slashProvider = new SlashCommandAutocompleteProvider([], options.onAutocompleteTab)
  input.setAutocompleteProvider(slashProvider)

  let activeTheme = theme
  let activeMarkdownTheme = markdownTheme
  let activeSelectListTheme = selectListTheme

  inputRow.addChild(input)
  editorContainer.addChild(inputRow)

  let sidebarEnabled = options.sidebarEnabled ?? false

  const footerData: FooterData = {
    cwd: options.cwd,
    gitBranch: getCurrentGitBranch(options.cwd),
    sessionName: options.title,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    contextTokens: 0,
    contextWindow: 0,
    contextPercent: null,
    model: options.model,
  }
  const footer = new FooterComponent(footerData, theme)

  // Pi-style vertical stack: header, sidebar (optional), chat, status, editor, footer.
  const renderLayout = () => {
    sidebarContainer.clear()
    if (sidebarEnabled) {
      sidebarContainer.addChild(sidebar)
    }
  }

  ui.addChild(header)
  ui.addChild(sidebarContainer)
  ui.addChild(chatContainer)
  ui.addChild(statusContainer)
  ui.addChild(editorContainer)
  ui.addChild(footer)
  let inputDisabled = false
  let busy = false
  let thinking = false
  let thinkingMessage = "Thinking"
  let lofiEnabled = false
  let currentTitle = options.title
  let currentModel = options.model
  let currentModelDisplayName = options.model
  let currentMode: AgentMode = "agent"
  let currentPlanPath: string | undefined
  let contextUsage: { tokens: number; window: number } | undefined
  let costUsd: number | undefined
  let statusNotice: { content: string; tone: StatusNoticeTone } | undefined
  let slashCommandItems: PromptAutocompleteItem[] = []
  let pinnedChats: PinnedChatSummary[] = []
  let queuedPrompts: QueuedPrompt[] = []
  let toolActivities: ToolActivity[] = []
  let tasks: TaskRecord[] = []
  let sessionMeta: { forkParentTitle?: string; title: string } | undefined
  let statusLinePreferences: StatusLinePreferences = options.statusLine ?? {}

  let imageAttachments: ImageAttachment[] = []
  let streamingComponent: AssistantMessageComponent | undefined
  let streamingContainer = new Container()
  let runResolve: (() => void) | undefined

  // Header shows title, cwd, model, and status.
  const rebuildHeader = () => {
    header.clear()
    const left = currentTitle
    const right = [currentModelDisplayName, currentMode === "plan" ? "plan" : undefined].filter(Boolean).join(" · ")
    const headerText = right ? `${left}  ${right}` : left
    header.addChild(new Text(borderColor(headerText), 0, 0))
  }

  // Footer shows cwd, context, cost, lofi, and mode.
  const rebuildFooter = () => {
    footerData.cwd = options.cwd
    footerData.gitBranch = getCurrentGitBranch(options.cwd)
    footerData.sessionName = currentTitle
    footerData.model = currentModelDisplayName
    footerData.lofi = lofiEnabled
    if (contextUsage) {
      footerData.contextTokens = contextUsage.tokens
      footerData.contextWindow = contextUsage.window
      footerData.contextPercent = (contextUsage.tokens / contextUsage.window) * 100
    } else {
      footerData.contextTokens = 0
      footerData.contextWindow = 0
      footerData.contextPercent = null
    }
    footerData.costUsd = costUsd ?? 0
    footer.setData(footerData)
  }

  rebuildHeader()
  rebuildFooter()
  renderLayout()

  // Wire input submission.
  input.onSubmit = (text) => {
    if (inputDisabled) return
    const trimmed = text.trim()
    if (!trimmed) return
    options.onSubmit(trimmed, imageAttachments)
    imageAttachments = []
    input.setText("")
  }

  input.onChange = (value) => {
    options.onInputChange?.(value)
  }

  // Rebuild transcript from TranscriptMessage array.
  const setTranscript = (transcript: TranscriptMessage[]) => {
    chatContainer.clear()
    streamingComponent = undefined
    streamingContainer.clear()
    for (const message of transcript) {
      if (message.role === "user") {
        const text = typeof message.content === "string" ? message.content : "[image]"
        chatContainer.addChild(new UserMessageComponent(text, activeTheme, activeMarkdownTheme))
      } else if (message.role === "assistant") {
        const text = typeof message.content === "string" ? message.content : "[message]"
        chatContainer.addChild(new AssistantMessageComponent(text, activeMarkdownTheme))
      }
      chatContainer.addChild(new Spacer(1))
    }
    rebuildStatusContainer()
    ui.requestRender()
  }

  const setStreamingContent = (text: string) => {
    let component = streamingComponent
    if (!component) {
      component = new AssistantMessageComponent("", activeMarkdownTheme)
      streamingContainer.clear()
      streamingContainer.addChild(component)
      chatContainer.addChild(streamingContainer)
      chatContainer.addChild(new Spacer(1))
      streamingComponent = component
    }
    component.setText(text)
    ui.requestRender()
  }

  const clearTranscriptDisplay = () => {
    chatContainer.clear()
    streamingComponent = undefined
    ui.requestRender()
  }

  // Status notices, thinking/busy indicators, and tool activities.
  const rebuildStatusContainer = () => {
    statusContainer.clear()
    if (thinking) {
      statusContainer.addChild(new Text(statusStyle.dim(`${thinkingMessage}...`), 0, 0))
    }
    if (busy) {
      statusContainer.addChild(new Text(statusStyle.dim("Working..."), 0, 0))
    }
    if (statusNotice) {
      const style =
        statusNotice.tone === "error"
          ? statusStyle.error
          : statusNotice.tone === "warning"
            ? statusStyle.warning
            : statusStyle.info
      statusContainer.addChild(new Text(style(statusNotice.content), 0, 0))
    }
    for (const activity of toolActivities) {
      statusContainer.addChild(new ToolActivityComponent(activity, activeTheme))
    }
  }

  const setThinking = (value: boolean, message?: string) => {
    thinking = value
    if (message) thinkingMessage = message
    rebuildStatusContainer()
    ui.requestRender()
  }

  const setBusy = (value: boolean) => {
    busy = value
    rebuildStatusContainer()
    ui.requestRender()
  }

  const setStatusNotice = (content?: string, tone?: StatusNoticeTone) => {
    statusNotice = content ? { content, tone: tone ?? "default" } : undefined
    rebuildStatusContainer()
    ui.requestRender()
  }

  const setToolActivities = (activities: ToolActivity[]) => {
    toolActivities = activities
    rebuildStatusContainer()
    ui.requestRender()
  }

  const clearToolActivities = () => {
    toolActivities = []
    rebuildStatusContainer()
    ui.requestRender()
  }

  // Sidebar / pinned chats.
  const rebuildSidebar = () => {
    sidebar.clear()
    if (!sidebarEnabled) return
    for (const chat of pinnedChats) {
      const prefix = chat.active ? "> " : "  "
      const line = `${prefix}${chat.title || chat.lastPrompt || "(empty)"}`
      sidebar.addChild(new Text(chat.active ? fgColor(activeTheme.colors.accent)(line) : fgColor(activeTheme.colors.foreground)(line), 0, 0))
    }
    ui.requestRender()
  }

  const setSidebarEnabled = (enabled: boolean) => {
    sidebarEnabled = enabled
    renderLayout()
  }

  const setPinnedChats = (chats: PinnedChatSummary[]) => {
    pinnedChats = chats
    rebuildSidebar()
  }

  // Model / title / mode / context / cost.
  const setModel = (model: string, _settings: ModelSettings, displayName?: string) => {
    currentModel = model
    currentModelDisplayName = displayName || model
    rebuildHeader()
    ui.requestRender()
  }

  const setTitle = (title: string) => {
    currentTitle = title
    rebuildHeader()
    ui.requestRender()
  }

  const setMode = (mode: AgentMode, planPath?: string) => {
    currentMode = mode
    currentPlanPath = planPath
    rebuildHeader()
    ui.requestRender()
  }

  const setContextUsage = (tokens: number, window: number) => {
    contextUsage = { tokens, window }
    rebuildFooter()
    ui.requestRender()
  }

  const setCostUsage = (cost?: number) => {
    costUsd = cost
    rebuildFooter()
    ui.requestRender()
  }

  const setLofi = (enabled: boolean) => {
    lofiEnabled = enabled
    rebuildFooter()
    ui.requestRender()
  }

  const setSessionMeta = (meta: { forkParentTitle?: string; title: string }) => {
    sessionMeta = meta
    currentTitle = meta.title
    rebuildHeader()
    ui.requestRender()
  }

  const setTheme = (themeName: string) => {
    const choice = resolveTheme(themeName)
    activeTheme = choice.theme
    activeMarkdownTheme = getPiMarkdownTheme(activeTheme)
    activeSelectListTheme = getPiSelectListTheme(activeTheme)
    footer.setTheme(activeTheme)
    rebuildHeader()
    rebuildFooter()
    rebuildSidebar()
    ui.requestRender()
  }

  const setStatusLinePreferences = (prefs: StatusLinePreferences) => {
    statusLinePreferences = prefs
    rebuildFooter()
    ui.requestRender()
  }

  const setInputDraft = (value: string) => {
    input.setText(value)
    ui.requestRender()
  }

  const setInputDisabled = (disabled: boolean) => {
    inputDisabled = disabled
    ui.requestRender()
  }

  const setSlashCommandItems = (items: PromptAutocompleteItem[]) => {
    slashCommandItems = items
    slashProvider.setItems(items)
  }

  const setTasks = (taskList: TaskRecord[]) => {
    tasks = taskList
  }

  const setQueuedPrompts = (prompts: QueuedPrompt[]) => {
    queuedPrompts = prompts
  }

  // Prompts: questions and approvals.
  const showQuestionPrompt = (request: AskQuestionRequest, resolve: (response: AskQuestionResponse) => void) => {
    const items: AutocompleteItem[] = request.questions.flatMap((q) =>
      q.options.map((o) => ({
        value: o.id,
        label: `${q.prompt}: ${o.label}`,
      })),
    )
    const selector = new SelectList(items, MAX_VISIBLE_SELECT_LIST, activeSelectListTheme, {
      minPrimaryColumnWidth: 20,
      maxPrimaryColumnWidth: 40,
    })
    selector.onSelect = (item) => {
      const question = request.questions.find((q) => q.options.some((o) => o.id === item.value))
      resolve({
        answers: [
          {
            answer: item.label,
            kind: "option",
            optionId: item.value,
            questionId: question?.id || "",
          },
        ],
      })
      editorContainer.clear()
      editorContainer.addChild(inputRow)
      ui.setFocus(input)
      ui.requestRender()
    }
    selector.onCancel = () => {
      resolve({ rejected: true, answers: [] })
      editorContainer.clear()
      editorContainer.addChild(inputRow)
      ui.setFocus(input)
      ui.requestRender()
    }
    editorContainer.clear()
    editorContainer.addChild(new Text(statusStyle.info(request.questions[0]?.prompt || "Question"), 0, 0))
    editorContainer.addChild(selector)
    ui.setFocus(selector)
    ui.requestRender()
  }

  const showApprovalPrompt = (request: PermissionRequest, resolve: (decision: PermissionDecision) => void) => {
    const items: AutocompleteItem[] = [
      { value: "allow_once", label: "Allow this time" },
      { value: "allow_tool_session", label: "Allow for this session" },
      { value: "allow_all_session", label: "Allow all for this session" },
      { value: "deny", label: "Deny" },
    ]
    const selector = new SelectList(items, MAX_VISIBLE_SELECT_LIST, activeSelectListTheme, {
      minPrimaryColumnWidth: 24,
    })
    selector.onSelect = (item) => {
      resolve(item.value as PermissionDecision)
      editorContainer.clear()
      editorContainer.addChild(inputRow)
      ui.setFocus(input)
      ui.requestRender()
    }
    selector.onCancel = () => {
      resolve("deny")
      editorContainer.clear()
      editorContainer.addChild(inputRow)
      ui.setFocus(input)
      ui.requestRender()
    }
    editorContainer.clear()
    editorContainer.addChild(new Text(statusStyle.warning(`Approve ${request.toolName}? ${request.args}`), 0, 0))
    editorContainer.addChild(selector)
    ui.setFocus(selector)
    ui.requestRender()
  }

  const requestQuestions = (request: AskQuestionRequest): Promise<AskQuestionResponse> => {
    return new Promise((resolve) => {
      showQuestionPrompt(request, resolve)
    })
  }

  const requestApproval = (request: PermissionRequest): Promise<PermissionDecision> => {
    return new Promise((resolve) => {
      showApprovalPrompt(request, resolve)
    })
  }

  // Selectors and dialogs (minimal implementations; U7 will expand them).
  const showModelEditor = (
    choice: ModelChoice,
    settings: ModelSettings,
    onSelect: (model: string, settings: ModelSettings, done: boolean) => void,
    onCancel: () => void,
  ) => {
    const items: AutocompleteItem[] = [{ value: choice.id, label: choice.name }]
    const selector = new SelectList(items, MAX_VISIBLE_SELECT_LIST, activeSelectListTheme)
    selector.onSelect = (item) => {
      onSelect(item.value, settings, true)
      editorContainer.clear()
      editorContainer.addChild(inputRow)
      ui.setFocus(input)
      ui.requestRender()
    }
    selector.onCancel = () => {
      onCancel()
      editorContainer.clear()
      editorContainer.addChild(inputRow)
      ui.setFocus(input)
      ui.requestRender()
    }
    editorContainer.clear()
    editorContainer.addChild(selector)
    ui.setFocus(selector)
    ui.requestRender()
  }

  const showPermissions = (
    grants: PermissionGrantSummary[],
    onRemove: (grant: PermissionGrantSummary) => void,
    onClearAll: () => void,
    onCancel: () => void,
  ) => {
    const items: AutocompleteItem[] = grants.map((g, index) => ({
      value: String(index),
      label: g.kind === "allow_all" ? "Allow all" : g.rule.permission,
    }))
    const selector = new SelectList(items, MAX_VISIBLE_SELECT_LIST, activeSelectListTheme)
    selector.onSelect = (item) => {
      const grant = grants[Number(item.value)]
      if (grant) onRemove(grant)
      onCancel()
      editorContainer.clear()
      editorContainer.addChild(inputRow)
      ui.setFocus(input)
      ui.requestRender()
    }
    selector.onCancel = () => {
      onCancel()
      editorContainer.clear()
      editorContainer.addChild(inputRow)
      ui.setFocus(input)
      ui.requestRender()
    }
    editorContainer.clear()
    editorContainer.addChild(new Text(statusStyle.info("Permissions"), 0, 0))
    editorContainer.addChild(selector)
    ui.setFocus(selector)
    ui.requestRender()
  }

  const showPlanActions = (planPath: string, onSelect: (action: PlanAction) => void) => {
    const items: AutocompleteItem[] = [
      { value: "execute", label: "Execute plan" },
      { value: "refine", label: "Refine plan" },
      { value: "stay", label: "Stay in plan mode" },
    ]
    const selector = new SelectList(items, MAX_VISIBLE_SELECT_LIST, activeSelectListTheme)
    selector.onSelect = (item) => {
      onSelect(item.value as PlanAction)
      editorContainer.clear()
      editorContainer.addChild(inputRow)
      ui.setFocus(input)
      ui.requestRender()
    }
    editorContainer.clear()
    editorContainer.addChild(new Text(statusStyle.info(`Plan: ${planPath}`), 0, 0))
    editorContainer.addChild(selector)
    ui.setFocus(selector)
    ui.requestRender()
  }

  const showSettings = (prefs: FurnacePreferences, onSave: (prefs: FurnacePreferences) => void) => {
    const items = [
      { id: "sidebar", label: "Sidebar", currentValue: prefs.sidebarEnabled ? "on" : "off", values: ["on", "off"] },
      { id: "inputMode", label: "Input mode", currentValue: prefs.inputMode ?? "standard", values: ["standard", "vim"] },
    ]
    const list = new SettingsList(
      items,
      MAX_VISIBLE_SETTINGS_LIST,
      settingsListTheme,
      (id, value) => {
        const updated = { ...prefs }
        if (id === "sidebar") updated.sidebarEnabled = value === "on"
        if (id === "inputMode") updated.inputMode = value as "standard" | "vim"
        onSave(updated)
      },
      () => {
        editorContainer.clear()
        editorContainer.addChild(inputRow)
        ui.setFocus(input)
        ui.requestRender()
      },
    )
    editorContainer.clear()
    editorContainer.addChild(new Text(statusStyle.info("Settings"), 0, 0))
    editorContainer.addChild(list)
    ui.setFocus(list)
    ui.requestRender()
  }

  const showApiKeySetup = (provider: string, label: string, onSave: (key: string) => void, onCancel: () => void) => {
    const keyInput = new Input()
    keyInput.onSubmit = (value) => {
      onSave(value)
      editorContainer.clear()
      editorContainer.addChild(inputRow)
      ui.setFocus(input)
      ui.requestRender()
    }
    keyInput.onEscape = () => {
      onCancel()
      editorContainer.clear()
      editorContainer.addChild(inputRow)
      ui.setFocus(input)
      ui.requestRender()
    }
    editorContainer.clear()
    editorContainer.addChild(new Text(statusStyle.info(`Enter API key for ${label}`), 0, 0))
    editorContainer.addChild(new Text(statusStyle.dim("Paste or type the key, then press Enter. Esc to cancel."), 0, 0))
    editorContainer.addChild(keyInput)
    ui.setFocus(keyInput)
    ui.requestRender()
  }

  const showProviderSelector = (
    rows: ProviderDisplayRow[],
    onSelect: (providerId: string) => void,
    onCancel: () => void,
    onDelete?: (providerId: string) => void,
  ) => {
    const items: AutocompleteItem[] = rows.map((r) => ({
      value: r.id,
      label: r.displayName,
      description: `${r.status}${r.sourceLabel ? ` · ${r.sourceLabel}` : ""}`,
    }))
    const selector = new SelectList(items, MAX_VISIBLE_SELECT_LIST, activeSelectListTheme, {
      minPrimaryColumnWidth: 16,
    })
    selector.onSelect = (item) => {
      const row = rows.find((r) => r.id === item.value)
      if (row?.canDelete && onDelete) {
        // For providers with a saved key, ask whether to delete or edit.
        const actionItems: AutocompleteItem[] = [
          { value: "edit", label: `Edit ${row.displayName} key` },
          { value: "delete", label: `Delete ${row.displayName} key` },
        ]
        const actionSelector = new SelectList(actionItems, MAX_VISIBLE_SELECT_LIST, activeSelectListTheme)
        actionSelector.onSelect = (actionItem) => {
          if (actionItem.value === "delete") {
            onDelete(row.id)
          } else {
            onSelect(row.id)
          }
          editorContainer.clear()
          editorContainer.addChild(inputRow)
          ui.setFocus(input)
          ui.requestRender()
        }
        actionSelector.onCancel = () => {
          editorContainer.clear()
          editorContainer.addChild(inputRow)
          ui.setFocus(input)
          ui.requestRender()
        }
        editorContainer.clear()
        editorContainer.addChild(new Text(statusStyle.info("Login"), 0, 0))
        editorContainer.addChild(actionSelector)
        ui.setFocus(actionSelector)
        ui.requestRender()
        return
      }
      onSelect(item.value)
      editorContainer.clear()
      editorContainer.addChild(inputRow)
      ui.setFocus(input)
      ui.requestRender()
    }
    selector.onCancel = () => {
      onCancel()
      editorContainer.clear()
      editorContainer.addChild(inputRow)
      ui.setFocus(input)
      ui.requestRender()
    }
    editorContainer.clear()
    editorContainer.addChild(new Text(statusStyle.info("Login — choose a provider"), 0, 0))
    editorContainer.addChild(selector)
    ui.setFocus(selector)
    ui.requestRender()
  }

  const clearInteractionPrompts = () => {
    editorContainer.clear()
    editorContainer.addChild(inputRow)
    ui.setFocus(input)
    ui.requestRender()
  }

  const clearPlanActions = () => {
    editorContainer.clear()
    editorContainer.addChild(inputRow)
    ui.setFocus(input)
    ui.requestRender()
  }

  const insertImageAttachment = (source: ImageSource, options?: { displayName?: string; size?: number }) => {
    imageAttachments.push({ id: crypto.randomUUID(), source, displayName: options?.displayName, size: options?.size })
    setStatusNotice("Image attached", "success")
  }

  const suspendForEditor = (draft: string): Promise<string> => {
    return new Promise((resolve) => {
      const editorInput = new Input()
      editorInput.setValue(draft)
      editorInput.onSubmit = (value) => {
        resolve(value)
        editorContainer.clear()
        editorContainer.addChild(inputRow)
        ui.setFocus(input)
        ui.requestRender()
      }
      editorInput.onEscape = () => {
        resolve(draft)
        editorContainer.clear()
        editorContainer.addChild(inputRow)
        ui.setFocus(input)
        ui.requestRender()
      }
      editorContainer.clear()
      editorContainer.addChild(editorInput)
      ui.setFocus(editorInput)
      ui.requestRender()
    })
  }

  const waitForInputFocus = (): Promise<void> => {
    return Promise.resolve()
  }

  const run = (): Promise<void> => {
    return new Promise((resolve) => {
      runResolve = resolve
      ui.start()
    })
  }

  const stop = () => {
    ui.stop()
    runResolve?.()
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
    setLofi,
    setMode,
    setModel,
    setPinnedChats,
    setQueuedPrompts,
    setSessionMeta,
    setSidebarEnabled,
    setSlashCommandItems,
    setStatusLinePreferences,
    setStatusNotice,
    setStreamingContent,
    setTasks,
    setTheme,
    setThinking,
    setTitle,
    setToolActivities,
    setTranscript,
    showApiKeySetup,
    showApprovalPrompt,
    showModelEditor,
    showPermissions,
    showPlanActions,
    showProviderSelector,
    showQuestionPrompt,
    showSettings,
    stop,
    suspendForEditor,
    waitForInputFocus,
  }
}
