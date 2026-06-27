import { Box, Text, render, useAnimation, useApp, useInput, useWindowSize, type Instance } from "ink"
import * as React from "react"
import wrapAnsi from "wrap-ansi"

import { slashCommandDefinitions } from "../commands.js"
import type { PermissionDecision, PermissionRequest } from "../permissions.js"
import type { AgentMode } from "../plan-mode.js"
import type { ModelSettings, ReasoningEffort } from "../preferences.js"
import type { AskQuestionAnswer, AskQuestionItem, AskQuestionRequest, AskQuestionResponse } from "../questions.js"
import type { TranscriptMessage } from "../session/types.js"
import type { TaskRecord } from "../tasks/types.js"
import { truncateEnd } from "./utils.js"
import { AppShell } from "./components/app-shell.js"
import { lofiChibiFrame, PromptInput, slashAutocompleteMatches, type PromptAutocompleteItem } from "./components/prompt-input.js"
import { SelectList, type SelectListItem } from "./components/select-list.js"
import { Spinner } from "./components/spinner.js"
import { ThemeProvider, type Theme, useTheme } from "./components/theme-provider.js"
import { resolveTheme, themeChoices, type ThemeChoice } from "./terminal-themes/index.js"

export type FurnaceTerminal = {
  clearToolActivities(): void
  clearPlanActions(): void
  requestQuestions(request: AskQuestionRequest): Promise<AskQuestionResponse>
  requestApproval(request: PermissionRequest): Promise<PermissionDecision>
  run(): Promise<void>
  stop(): void
  waitForInputFocus(): Promise<void>
  setBusy(busy: boolean): void
  setInputDraft(value: string): void
  setLofi(enabled: boolean): void
  setMode(mode: AgentMode, planPath?: string): void
  setThinking(thinking: boolean, message?: string): void
  setQueuedPrompts(prompts: QueuedPrompt[]): void
  setSlashCommandItems(items: PromptAutocompleteItem[]): void
  setTasks(tasks: TaskRecord[]): void
  showHistory(choices: HistoryChoice[], currentSessionId: string | null, onSelect: (sessionId: string) => void, onCancel: () => void): void
  showModelPicker(
    choices: ModelChoice[],
    currentModel: string,
    currentSettings: ModelSettings,
    onSelect: (model: string, settings: ModelSettings, done: boolean) => void,
    onCancel: () => void,
  ): void
  showThemePicker(choices: ThemeChoice[], currentTheme: string, onSelect: (theme: string, done: boolean) => void, onCancel: () => void): void
  showPlanActions(planPath: string, onSelect: (action: PlanAction) => void): void
  setModel(model: string, settings: ModelSettings): void
  setTheme(theme: string): void
  setTitle(title: string): void
  setToolActivities(activities: ToolActivity[]): void
  clearTranscriptDisplay(): void
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

export type ToolActivity = {
  args: string
  id: string
  name: string
  result?: string
  status: "running" | "done" | "failed"
}

export type QueuedPrompt = {
  createdAt: number
  hidden?: boolean
  id: string
  source?: string
  text: string
}

export type PlanAction = "execute" | "refine" | "stay"

type CreateFurnaceTerminalOptions = {
  cwd: string
  model: string
  modelSettings: ModelSettings
  onQueueEdit?: (id: string) => void
  onQueuePromote?: (id: string) => void
  onQueueRemove?: (id: string) => void
  onTaskBackground?: () => void
  onModeCycle?: (direction: 1 | -1) => void
  themeName: string
  title: string
  onSubmit: (text: string) => void
}

type UiScreen =
  | { kind: "chat" }
  | { kind: "history"; choices: HistoryChoice[]; currentSessionId: string | null; onCancel: () => void; onSelect: (sessionId: string) => void }
  | {
      kind: "model"
      choices: ModelChoice[]
      currentModel: string
      onCancel: () => void
      onSelect: (model: string, settings: ModelSettings, done: boolean) => void
      settingsByModel: Record<string, ModelSettings>
    }
  | { kind: "theme"; choices: ThemeChoice[]; currentTheme: string; onCancel: () => void; onSelect: (theme: string, done: boolean) => void }

type PlanActionState = {
  onSelect: (action: PlanAction) => void
  planPath: string
}

type ApprovalPromptState = PermissionRequest & {
  resolve: (decision: PermissionDecision) => void
}

type QuestionPromptState = AskQuestionRequest & {
  resolve: (response: AskQuestionResponse) => void
}

type UiFocus = "input" | "plan_actions" | "question" | "queue" | "tasks"

type UiState = {
  approval?: ApprovalPromptState
  busy: boolean
  chatCanScrollUp: boolean
  cwd: string
  focus: UiFocus
  inputDraft: string
  lofiEnabled: boolean
  mode: AgentMode
  model: string
  modelSettings: ModelSettings
  planAction?: PlanActionState
  planPath?: string
  question?: QuestionPromptState
  queuedPrompts: QueuedPrompt[]
  screen: UiScreen
  slashCommandItems: PromptAutocompleteItem[]
  theme: Theme
  themeName: string
  thinking: boolean
  thinkingMessage: string
  title: string
  tasks: TaskRecord[]
  toolActivities: ToolActivity[]
  transcript: TranscriptMessage[]
  transcriptOffset: number
}

class UiStore {
  private inputFocusWaiters = new Set<() => void>()
  private listeners = new Set<() => void>()
  private state: UiState
  readonly queueHandlers: {
    onEdit?: (id: string) => void
    onPromote?: (id: string) => void
    onRemove?: (id: string) => void
  }
  readonly taskHandlers: {
    onBackground?: () => void
  }
  readonly modeHandlers: {
    onCycle?: (direction: 1 | -1) => void
  }

  constructor(options: CreateFurnaceTerminalOptions) {
    const themeChoice = resolveTheme(options.themeName)
    this.queueHandlers = {
      onEdit: options.onQueueEdit,
      onPromote: options.onQueuePromote,
      onRemove: options.onQueueRemove,
    }
    this.taskHandlers = {
      onBackground: options.onTaskBackground,
    }
    this.modeHandlers = {
      onCycle: options.onModeCycle,
    }
    this.state = {
      approval: undefined,
      busy: false,
      chatCanScrollUp: false,
      cwd: options.cwd,
      focus: "input",
      inputDraft: "",
      lofiEnabled: false,
      mode: "agent",
      model: options.model,
      modelSettings: options.modelSettings,
      planAction: undefined,
      planPath: undefined,
      question: undefined,
      queuedPrompts: [],
      screen: { kind: "chat" },
      slashCommandItems: slashCommandDefinitions.map(slashCommandToAutocompleteItem),
      theme: themeChoice.theme,
      themeName: themeChoice.name,
      thinking: false,
      thinkingMessage: "thinking",
      title: options.title,
      tasks: [],
      toolActivities: [],
      transcript: [],
      transcriptOffset: 0,
    }
  }

  getSnapshot = (): UiState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  update(updater: Partial<UiState> | ((state: UiState) => UiState)): void {
    this.state = normalizeUiState(typeof updater === "function" ? updater(this.state) : { ...this.state, ...updater })
    for (const listener of this.listeners) listener()
    this.resolveInputFocusWaiters()
  }

  waitForInputFocus(): Promise<void> {
    if (canDrainQueuedPrompt(this.state)) return Promise.resolve()
    return new Promise((resolve) => {
      this.inputFocusWaiters.add(resolve)
    })
  }

  private resolveInputFocusWaiters(): void {
    if (!canDrainQueuedPrompt(this.state)) return
    const waiters = [...this.inputFocusWaiters]
    this.inputFocusWaiters.clear()
    for (const resolve of waiters) resolve()
  }
}

function canDrainQueuedPrompt(state: UiState): boolean {
  return state.screen.kind === "chat" && state.focus === "input" && state.inputDraft.trim() === "" && !state.approval && !state.question
}

function normalizeUiState(state: UiState): UiState {
  if (state.focus === "queue" && state.queuedPrompts.length === 0) return { ...state, focus: "input" }
  if (state.focus === "tasks" && state.tasks.length === 0) return { ...state, focus: "input" }
  if (state.focus === "question" && !state.question) return { ...state, focus: "input" }
  if (state.focus === "plan_actions" && !state.planAction) return { ...state, focus: "input" }
  return state
}

function visibleTaskRecords(tasks: TaskRecord[]): TaskRecord[] {
  return tasks.filter((task) => task.status !== "completed")
}

export function createFurnaceTerminal(options: CreateFurnaceTerminalOptions): FurnaceTerminal {
  const store = new UiStore(options)
  let instance: Instance | undefined

  const stop = () => {
    instance?.unmount()
  }

  return {
    clearToolActivities() {
      store.update({ toolActivities: [] })
    },
    clearPlanActions() {
      store.update((state) => ({ ...state, focus: state.focus === "plan_actions" ? "input" : state.focus, planAction: undefined }))
    },
    requestQuestions(request) {
      return new Promise<AskQuestionResponse>((resolve) => {
        store.update((state) => ({ ...state, focus: "input", question: { ...request, resolve } }))
      })
    },
    requestApproval(request) {
      return new Promise<PermissionDecision>((resolve) => {
        store.update({ approval: { ...request, resolve } })
      })
    },
    run() {
      instance = render(<FurnaceRoot onExit={stop} onSubmit={options.onSubmit} store={store} />, {
        alternateScreen: true,
        exitOnCtrlC: false,
        incrementalRendering: true,
        maxFps: 30,
      })
      return instance.waitUntilExit().then(() => undefined)
    },
    stop,
    waitForInputFocus() {
      return store.waitForInputFocus()
    },
    setBusy(busy) {
      store.update({ busy })
    },
    setInputDraft(value) {
      store.update({ focus: "input", inputDraft: value })
    },
    setLofi(enabled) {
      store.update({ lofiEnabled: enabled })
    },
    setMode(mode, planPath) {
      store.update({ mode, planPath })
    },
    setThinking(thinking, message = "thinking") {
      store.update({ thinking, thinkingMessage: message })
    },
    setQueuedPrompts(prompts) {
      store.update({ queuedPrompts: prompts })
    },
    setSlashCommandItems(items) {
      store.update({ slashCommandItems: items })
    },
    setTasks(tasks) {
      store.update({ tasks: visibleTaskRecords(tasks) })
    },
    showHistory(choices, currentSessionId, onSelect, onCancel) {
      store.update({ screen: { kind: "history", choices, currentSessionId, onCancel, onSelect }, title: "History" })
    },
    showModelPicker(choices, currentModel, currentSettings, onSelect, onCancel) {
      store.update({
        screen: {
          kind: "model",
          choices,
          currentModel,
          onCancel,
          onSelect,
          settingsByModel: { [currentModel]: normalizeModelSettings(currentSettings, findModelChoice(choices, currentModel)) },
        },
        title: "Model",
      })
    },
    showThemePicker(choices, currentTheme, onSelect, onCancel) {
      store.update({ screen: { kind: "theme", choices, currentTheme, onCancel, onSelect }, title: "Theme" })
    },
    showPlanActions(planPath, onSelect) {
      store.update((state) => ({ ...state, focus: "plan_actions", planAction: { onSelect, planPath } }))
    },
    setModel(model, settings) {
      store.update((state) => ({ ...state, model, modelSettings: settings }))
    },
    setTheme(themeName) {
      const choice = resolveTheme(themeName)
      store.update({ theme: choice.theme, themeName: choice.name })
    },
    setTitle(title) {
      store.update({ title })
    },
    setToolActivities(activities) {
      store.update({ toolActivities: activities })
    },
    clearTranscriptDisplay() {
      store.update((state) => ({ ...state, transcriptOffset: state.transcript.length }))
    },
    setTranscript(transcript) {
      store.update({ screen: { kind: "chat" }, transcript, transcriptOffset: 0 })
    },
  }
}

function FurnaceRoot({ onExit, onSubmit, store }: { onExit: () => void; onSubmit: (text: string) => void; store: UiStore }): React.ReactNode {
  const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  return (
    <ThemeProvider theme={state.theme}>
      <FurnaceApp onExit={onExit} onSubmit={onSubmit} state={state} store={store} />
    </ThemeProvider>
  )
}

function FurnaceApp({
  onExit,
  onSubmit,
  state,
  store,
}: {
  onExit: () => void
  onSubmit: (text: string) => void
  state: UiState
  store: UiStore
}): React.ReactNode {
  const app = useApp()
  useInput((_input, key) => {
    if (key.ctrl && _input === "c") {
      onExit()
      app.exit()
    }
  })

  const sentMessages = React.useMemo(
    () =>
      state.transcript
        .filter((m) => m.role === "user" && m.content.trim())
        .map((m) => m.content)
        .reverse(),
    [state.transcript],
  )

  return (
    <AppShell>
      <AppShell.Header cwd={shortenHome(state.cwd)} model={state.model} settings={`${modeLabel(state)} · ${formatFooterSettings(state.modelSettings)} · ${state.themeName}`} title={state.title} />
      <AppShell.Content>
        {state.screen.kind === "history" ? (
          <HistoryScreen screen={state.screen} store={store} />
        ) : state.screen.kind === "model" ? (
          <ModelScreen model={state.model} screen={state.screen} store={store} />
        ) : state.screen.kind === "theme" ? (
          <ThemeScreen screen={state.screen} store={store} />
        ) : (
          <>
            <ChatScreen
              interactionActive={Boolean(state.approval) || state.focus === "plan_actions" || state.focus === "question" || state.focus === "queue" || state.focus === "tasks"}
              onScrollStateChange={(canScrollUp) => {
                if (store.getSnapshot().chatCanScrollUp !== canScrollUp) store.update({ chatCanScrollUp: canScrollUp })
              }}
              thinking={state.thinking}
              thinkingMessage={state.thinkingMessage}
              reservedRows={reservedInteractionRows(state)}
              toolActivities={state.toolActivities}
              transcript={state.transcript.slice(state.transcriptOffset)}
            />
            {state.approval ? <ApprovalPrompt request={state.approval} store={store} /> : null}
            {!state.approval && state.planAction ? <PlanActionPanel action={state.planAction} store={store} /> : null}
            {!state.approval && state.question ? <QuestionPrompt request={state.question} store={store} /> : null}
            {!state.approval && state.tasks.length > 0 ? <TaskPanel tasks={state.tasks} store={store} /> : null}
            {!state.approval && state.queuedPrompts.length > 0 ? <QueuedPromptPanel prompts={state.queuedPrompts} store={store} /> : null}
          </>
        )}
      </AppShell.Content>
      {state.lofiEnabled ? <LofiCorner /> : null}
      <PromptInput
        active={state.focus === "input"}
        busy={state.busy}
        disabled={state.screen.kind !== "chat" || Boolean(state.approval)}
        autocompleteItems={state.slashCommandItems}
        historyItems={sentMessages}
        onChange={(value) => store.update({ inputDraft: value })}
        onEmptyUp={() => {
          if (!state.chatCanScrollUp) focusPanelAboveInput(store, state)
        }}
        onModeCycle={(direction) => store.modeHandlers.onCycle?.(direction)}
        onSubmit={onSubmit}
        placeholder={promptPlaceholder(state)}
        prefix={state.mode === "plan" ? "plan>" : ">"}
        value={state.inputDraft}
      />
      <AppShell.Hints items={hintItemsForState(state)} />
    </AppShell>
  )

}

function LofiCorner(): React.ReactNode {
  const theme = useTheme()
  const { frame } = useAnimation({ interval: 500 })

  return (
    <Box justifyContent="flex-end" paddingRight={2}>
      <Text color={theme.colors.primary}>{lofiChibiFrame(frame)}</Text>
    </Box>
  )
}

function approvalHintItems(): string[] {
  return ["up/down navigate", "enter select", "esc deny"]
}

function questionHintItems(): string[] {
  return ["left/right question", "up/down option", "enter select", "esc input"]
}

function queueHintItems(): string[] {
  return ["up/down select", "e edit", "d remove", "enter run next", "esc input"]
}

function taskHintItems(state: UiState): string[] {
  const hasForeground = state.tasks.some((task) => task.status === "running")
  const hasBackground = state.tasks.some((task) => task.status === "backgrounded")
  return ["up/down select", hasForeground ? "ctrl+b background" : hasBackground ? "working in background" : "task status", "esc input"]
}

function hintItemsForState(state: UiState): string[] {
  if (state.approval) return approvalHintItems()
  if (state.focus === "plan_actions" && state.planAction) return ["up/down select", "enter select", "esc stay"]
  if (state.focus === "question" && state.question) return questionHintItems()
  if (state.focus === "queue" && state.queuedPrompts.length > 0) return queueHintItems()
  if (state.focus === "tasks" && state.tasks.length > 0) return taskHintItems(state)
  const extras: string[] = []
  if (state.planAction) extras.push("up plan actions")
  if (state.question) extras.push("up answer question")
  if (state.tasks.some((task) => task.status === "running")) extras.push("up task status")
  if (state.queuedPrompts.length > 0) extras.push("up manage queue")
  return [...extras, "tab mode", ...hintItems(state.screen.kind)]
}

function promptPlaceholder(state: UiState): string {
  if (state.approval) return "Resolve the permission prompt..."
  if (state.planAction) return "Choose a plan action, or press esc to keep planning..."
  if (state.question) return state.busy ? "Type a follow-up to queue, or press up to answer..." : "Type a reply, or press up to answer..."
  if (state.busy) return "Furnace is working; submit to queue..."
  return state.mode === "plan" ? "Describe what to plan, or type /agent" : "Ask Furnace or type /plan"
}

function reservedInteractionRows(state: UiState): number {
  if (state.approval) return 8
  let rows = 0
  if (state.planAction) rows += 6
  if (state.question) rows += 9
  if (state.tasks.length > 0) rows += taskPanelRows(state.tasks)
  if (state.queuedPrompts.length > 0) rows += queuedPromptPanelRows(state.queuedPrompts)
  if (slashCommandAutocompleteVisible(state)) rows += slashCommandAutocompleteRows(state)
  return rows
}

function slashCommandAutocompleteVisible(state: UiState): boolean {
  return state.screen.kind === "chat" && state.focus === "input" && !state.approval && slashCommandAutocompleteRows(state) > 0
}

function slashCommandAutocompleteRows(state: UiState): number {
  const rows = slashAutocompleteMatches(
    state.inputDraft,
    state.inputDraft.length,
    state.slashCommandItems,
  ).length
  return rows > 0 ? 3 + Math.min(8, rows) : 0
}

function slashCommandToAutocompleteItem(command: (typeof slashCommandDefinitions)[number]): PromptAutocompleteItem {
  return {
    description: command.description,
    insertText: command.insertText,
    label: command.usage || command.name,
    value: command.name,
  }
}

function taskPanelRows(tasks: TaskRecord[]): number {
  const hasError = tasks.some((task) => task.error)
  return 4 + Math.min(3, tasks.length) + (hasError ? 1 : 0)
}

function queuedPromptPanelRows(prompts: QueuedPrompt[]): number {
  return 4 + Math.min(3, prompts.length)
}

function panelFocusOrder(state: UiState): UiFocus[] {
  const order: UiFocus[] = []
  if (state.planAction) order.push("plan_actions")
  if (state.question) order.push("question")
  if (state.tasks.length > 0) order.push("tasks")
  if (state.queuedPrompts.length > 0) order.push("queue")
  order.push("input")
  return order
}

function focusPanelAboveInput(store: UiStore, state: UiState): void {
  const order = panelFocusOrder(state)
  const inputIndex = order.indexOf("input")
  const next = inputIndex > 0 ? order[inputIndex - 1] : undefined
  if (next && next !== "input") store.update({ focus: next })
}

function focusAdjacentPanel(store: UiStore, direction: "up" | "down"): void {
  const state = store.getSnapshot()
  const order = panelFocusOrder(state)
  const currentIndex = order.indexOf(state.focus)
  if (currentIndex < 0) return
  const next = order[currentIndex + (direction === "up" ? -1 : 1)]
  if (next) {
    store.update({ focus: next })
    return
  }
  if (direction === "up") store.update({ focus: "input" })
}

function ApprovalPrompt({ request, store }: { request: ApprovalPromptState; store: UiStore }): React.ReactNode {
  const theme = useTheme()
  const choices = React.useMemo(() => approvalChoiceItems(request.toolName), [request.toolName])
  const resolve = React.useCallback(
    (decision: PermissionDecision) => {
      request.resolve(decision)
      store.update((state) => ({ ...state, approval: undefined }))
    },
    [request, store],
  )

  return (
    <Box borderStyle="round" borderColor={theme.colors.warning} flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text color={theme.colors.warning} bold>Permission required</Text>
        <Text color={theme.colors.mutedForeground}>{request.permission}</Text>
      </Box>
      <Text color={theme.colors.foreground}>{request.description}</Text>
      <Text color={theme.colors.mutedForeground}>{truncateEnd(formatApprovalArgs(request.args), 120)}</Text>
      <SelectList
        active
        items={choices}
        maxRows={4}
        onCancel={() => resolve("deny")}
        onSelect={(item) => resolve(item.value)}
      />
    </Box>
  )
}

type QuestionChoiceValue = `option:${number}` | "continue" | "custom" | "refuse" | "submit"

type QuestionDraftAnswer = AskQuestionAnswer & {
  label: string
}

function PlanActionPanel({ action, store }: { action: PlanActionState; store: UiStore }): React.ReactNode {
  const theme = useTheme()
  const active = store.getSnapshot().focus === "plan_actions"
  const items: Array<SelectListItem<PlanAction>> = [
    { label: "Execute", value: "execute", description: "switch to agent mode and run the plan" },
    { label: "Refine", value: "refine", description: "keep plan mode and edit the plan" },
    { label: "Stay in plan mode", value: "stay", description: "dismiss this choice" },
  ]

  const resolve = React.useCallback(
    (value: PlanAction) => {
      store.update((state) => ({ ...state, focus: "input", planAction: undefined }))
      action.onSelect(value)
    },
    [action, store],
  )

  return (
    <Box borderStyle="round" borderColor={active ? theme.colors.primary : theme.colors.border} flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text color={theme.colors.primary} bold>Plan ready</Text>
        <Text color={theme.colors.mutedForeground}>{action.planPath}</Text>
      </Box>
      <SelectList
        active={active}
        items={items}
        maxRows={3}
        onBoundary={(direction) => focusAdjacentPanel(store, direction)}
        onCancel={() => resolve("stay")}
        onSelect={(item) => resolve(item.value)}
      />
    </Box>
  )
}

function QuestionPrompt({ request, store }: { request: QuestionPromptState; store: UiStore }): React.ReactNode {
  const theme = useTheme()
  const [questionIndex, setQuestionIndex] = React.useState(0)
  const [answers, setAnswers] = React.useState<Record<string, QuestionDraftAnswer[]>>({})
  const [customEditing, setCustomEditing] = React.useState(false)
  const [customDraft, setCustomDraft] = React.useState("")
  const active = store.getSnapshot().focus === "question"
  const questions = request.questions
  const reviewIndex = questions.length
  const isReview = questions.length > 1 && questionIndex === reviewIndex
  const question = isReview ? undefined : questions[questionIndex]
  const allAnswered = questions.every((item) => (answers[item.id]?.length ?? 0) > 0)
  const choices = React.useMemo(() => question ? questionChoiceItems(question, answers[question.id] || []) : [], [answers, question])

  const resolve = React.useCallback(
    (response: AskQuestionResponse) => {
      request.resolve(response)
      store.update((state) => ({ ...state, focus: "input", question: undefined }))
    },
    [request, store],
  )

  const submitAnswers = React.useCallback(() => {
    const flattened = questions.flatMap((item) => answers[item.id] || [])
    resolve({ answers: flattened })
  }, [answers, questions, resolve])

  function moveQuestion(delta: number): void {
    setCustomEditing(false)
    setQuestionIndex((current) => {
      const max = questions.length > 1 ? questions.length : questions.length - 1
      return (current + delta + max + 1) % (max + 1)
    })
  }

  function selectChoice(value: QuestionChoiceValue): void {
    if (!question) {
      if (value === "submit" && allAnswered) submitAnswers()
      return
    }
    if (value === "continue") {
      if ((answers[question.id]?.length ?? 0) === 0) return
      if (questions.length === 1) {
        resolve({ answers: answers[question.id] || [] })
        return
      }
      advanceAfterAnswer()
      return
    }
    if (value === "custom") {
      setCustomEditing(true)
      setCustomDraft("")
      return
    }
    if (value === "refuse") {
      const answer = { answer: "Refuse to answer", kind: "refuse", label: "Refuse to answer", questionId: question.id } satisfies QuestionDraftAnswer
      if (questions.length === 1) {
        resolve({ answers: [answer] })
        return
      }
      setQuestionAnswer(question, [answer])
      advanceAfterAnswer()
      return
    }
    const index = Number(value.slice("option:".length))
    const option = question.options[index]
    if (!option) return
    const answer = { answer: option.label, kind: "option", label: option.label, optionId: option.id, questionId: question.id } satisfies QuestionDraftAnswer
    if (question.allowMultiple) {
      setAnswers((current) => {
        const existing = current[question.id] || []
        const present = existing.some((item) => item.kind === "option" && item.optionId === option.id)
        return {
          ...current,
          [question.id]: present ? existing.filter((item) => item.optionId !== option.id) : [...existing, answer],
        }
      })
      return
    }
    if (questions.length === 1) {
      resolve({ answers: [answer] })
      return
    }
    setQuestionAnswer(question, [answer])
    advanceAfterAnswer()
  }

  function setQuestionAnswer(question: AskQuestionItem, next: QuestionDraftAnswer[]): void {
    setAnswers((current) => ({ ...current, [question.id]: next }))
  }

  function advanceAfterAnswer(): void {
    setQuestionIndex((current) => Math.min(current + 1, reviewIndex))
  }

  useInput((input, key) => {
    if (!active) return
    if (customEditing && question) {
      if (key.escape) {
        setCustomEditing(false)
        setCustomDraft("")
        return
      }
      if (key.return) {
        const trimmed = customDraft.trim()
        if (trimmed) {
          const answer = { answer: trimmed, kind: "custom", label: trimmed, questionId: question.id } satisfies QuestionDraftAnswer
          if (!question.allowMultiple && questions.length === 1) {
            resolve({ answers: [answer] })
            return
          }
          setQuestionAnswer(question, question.allowMultiple ? [...(answers[question.id] || []).filter((item) => item.kind !== "custom"), answer] : [answer])
          setCustomEditing(false)
          setCustomDraft("")
          advanceAfterAnswer()
        }
        return
      }
      if (key.backspace || key.delete) {
        setCustomDraft((current) => current.slice(0, -1))
        return
      }
      if (!key.ctrl && !key.meta && input) setCustomDraft((current) => current + input)
      return
    }

    if (key.escape) {
      store.update({ focus: "input" })
      return
    }
    if (key.leftArrow) {
      moveQuestion(-1)
      return
    }
    if (key.rightArrow) {
      moveQuestion(1)
      return
    }
    if (isReview && key.return && allAnswered) submitAnswers()
  }, { isActive: active })

  return (
    <Box borderStyle="round" borderColor={active ? theme.colors.primary : theme.colors.border} flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text color={theme.colors.primary} bold>Questions</Text>
        <Text color={theme.colors.mutedForeground}>{active ? "focused" : "press up to answer"}</Text>
      </Box>
      {questions.length > 1 ? (
        <Text color={theme.colors.mutedForeground}>
          {questions.map((item, index) => `${index === questionIndex ? ">" : answers[item.id]?.length ? "*" : "-"} ${item.id}`).join("  ")}
          {`  ${isReview ? "> " : ""}review`}
        </Text>
      ) : null}
      {isReview ? (
        <Box flexDirection="column">
          <Text color={theme.colors.foreground}>Review answers</Text>
          {questions.map((item) => (
            <Text key={item.id} color={answers[item.id]?.length ? theme.colors.foreground : theme.colors.error}>
              {item.id}: {answers[item.id]?.map((answer) => answer.label).join(", ") || "(not answered)"}
            </Text>
          ))}
          <SelectList
            active={active && !customEditing}
            items={[{ label: "Submit answers", value: "submit" as const, description: allAnswered ? "send to agent" : "answer all first", disabled: !allAnswered }]}
            maxRows={1}
            onBoundary={(direction) => focusAdjacentPanel(store, direction)}
            onCancel={() => store.update({ focus: "input" })}
            onSelect={(item) => selectChoice(item.value)}
          />
        </Box>
      ) : question ? (
        <Box flexDirection="column">
          <Text color={theme.colors.foreground}>{question.prompt}{question.allowMultiple ? " (select all that apply)" : ""}</Text>
          {customEditing ? (
            <Box flexDirection="column">
              <Text color={theme.colors.mutedForeground}>Custom answer:</Text>
              <Text color={theme.colors.foreground}>{customDraft || " "}</Text>
              <Text color={theme.colors.mutedForeground}>enter save · esc cancel</Text>
            </Box>
          ) : (
            <SelectList
              active={active}
              items={choices}
              maxRows={6}
              onBoundary={(direction) => focusAdjacentPanel(store, direction)}
              onCancel={() => store.update({ focus: "input" })}
              onSelect={(item) => selectChoice(item.value)}
            />
          )}
        </Box>
      ) : null}
    </Box>
  )
}

export function questionChoiceItems(question: AskQuestionItem, answers: AskQuestionAnswer[] = []): SelectListItem<QuestionChoiceValue>[] {
  const selectedOptionIds = new Set(answers.flatMap((answer) => (answer.optionId ? [answer.optionId] : [])))
  const items: SelectListItem<QuestionChoiceValue>[] = question.options.map((option, index) => ({
    label: `${selectedOptionIds.has(option.id) ? "[x] " : ""}${option.label}`,
    value: `option:${index}`,
    description: option.description,
  }))
  if (question.allowCustom) items.push({ label: "Other / type your own answer", value: "custom", description: "custom answer" })
  if (question.allowMultiple) {
    items.push({
      label: "Continue",
      value: "continue",
      description: answers.length > 0 ? "next question" : "select at least one",
      disabled: answers.length === 0,
    })
  }
  items.push({ label: "Refuse to answer", value: "refuse", description: "continue without this answer" })
  return items
}

function QueuedPromptPanel({ prompts, store }: { prompts: QueuedPrompt[]; store: UiStore }): React.ReactNode {
  const theme = useTheme()
  const active = store.getSnapshot().focus === "queue"
  const [selected, setSelected] = React.useState(0)
  const selectedPrompt = prompts[Math.min(selected, Math.max(0, prompts.length - 1))]

  React.useEffect(() => {
    setSelected((current) => Math.min(current, Math.max(0, prompts.length - 1)))
  }, [prompts.length])

  useInput((input, key) => {
    if (!active) return
    if (key.escape) {
      store.update({ focus: "input" })
      return
    }
    if (key.upArrow) {
      if (selected <= 0) {
        focusAdjacentPanel(store, "up")
        return
      }
      setSelected((current) => Math.max(0, current - 1))
      return
    }
    if (key.downArrow) {
      if (selected >= prompts.length - 1) {
        focusAdjacentPanel(store, "down")
        return
      }
      setSelected((current) => Math.min(prompts.length - 1, current + 1))
      return
    }
    if (!selectedPrompt) return
    if (input === "e") {
      store.queueHandlers.onEdit?.(selectedPrompt.id)
      store.update({ focus: "input", inputDraft: selectedPrompt.text })
      return
    }
    if (input === "d") {
      store.queueHandlers.onRemove?.(selectedPrompt.id)
      return
    }
    if (key.return) {
      store.queueHandlers.onPromote?.(selectedPrompt.id)
      store.update({ focus: "input" })
    }
  }, { isActive: active })

  return (
    <Box borderStyle="round" borderColor={active ? theme.colors.primary : theme.colors.border} flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text color={theme.colors.primary} bold>Queued prompts</Text>
        <Text color={theme.colors.mutedForeground}>{active ? "focused" : "press up to manage"}</Text>
      </Box>
      {queuedPromptPreviewItems(prompts, selected).map((line) => (
        <Text key={line.id} color={line.selected ? theme.colors.primary : theme.colors.mutedForeground}>
          {line.selected ? "› " : "  "}{line.text}
        </Text>
      ))}
      <Text color={theme.colors.mutedForeground}>
        {active ? "up/down select · e edit · d remove · enter run next · esc input" : "press up from empty input to manage"}
      </Text>
    </Box>
  )
}

function TaskPanel({ tasks, store }: { tasks: TaskRecord[]; store: UiStore }): React.ReactNode {
  const theme = useTheme()
  const active = store.getSnapshot().focus === "tasks"
  const [selected, setSelected] = React.useState(0)
  const selectedTask = tasks[Math.min(selected, Math.max(0, tasks.length - 1))]
  const canBackground = tasks.some((task) => task.status === "running")
  const hasBackgrounded = tasks.some((task) => task.status === "backgrounded")
  const title = hasBackgrounded && !canBackground ? "Subagents (backgrounded)" : "Subagents"

  React.useEffect(() => {
    setSelected((current) => Math.min(current, Math.max(0, tasks.length - 1)))
  }, [tasks.length])

  useInput((input, key) => {
    if (!active) return
    if (key.escape) {
      store.update({ focus: "input" })
      return
    }
    if (key.upArrow) {
      if (selected <= 0) {
        focusAdjacentPanel(store, "up")
        return
      }
      setSelected((current) => Math.max(0, current - 1))
      return
    }
    if (key.downArrow) {
      if (selected >= tasks.length - 1) {
        focusAdjacentPanel(store, "down")
        return
      }
      setSelected((current) => Math.min(tasks.length - 1, current + 1))
      return
    }
    if (key.ctrl && input === "b" && canBackground) {
      store.taskHandlers.onBackground?.()
      store.update({ focus: "input" })
    }
  }, { isActive: active })

  return (
    <Box borderStyle="round" borderColor={active ? theme.colors.primary : theme.colors.border} flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text color={theme.colors.primary} bold>{title}</Text>
        <Text color={theme.colors.mutedForeground}>{active ? "focused" : "press up for tasks"}</Text>
      </Box>
      {taskPreviewItems(tasks, selected).map((line) => (
        <Text key={line.id} color={line.selected ? theme.colors.primary : taskStatusColor(theme, line.status)}>
          {line.selected ? "› " : "  "}{line.text}
        </Text>
      ))}
      <Text color={theme.colors.mutedForeground}>
        {active ? `up/down select · ${canBackground ? "ctrl+b background group" : hasBackgrounded ? "working in background" : "task status"} · esc input` : taskPanelSummary(tasks)}
      </Text>
      {selectedTask?.error ? <Text color={theme.colors.error}>{truncateEnd(selectedTask.error, 100)}</Text> : null}
    </Box>
  )
}

export function taskPreviewItems(tasks: TaskRecord[], selected = 0, maxItems = 3): Array<{ id: string; selected: boolean; status: TaskRecord["status"]; text: string }> {
  const clamped = Math.min(Math.max(0, selected), Math.max(0, tasks.length - 1))
  const start = Math.min(Math.max(0, tasks.length - maxItems), Math.max(0, clamped - Math.floor(maxItems / 2)))
  return tasks.slice(start, start + maxItems).map((task, index) => ({
    id: task.id,
    selected: start + index === clamped,
    status: task.status,
    text: formatTaskPreviewText(task),
  }))
}

function formatTaskPreviewText(task: TaskRecord): string {
  const description = formatQueuedPromptPreview(task.description, 72)
  if (task.status === "running" || task.status === "backgrounded") return description
  return `${task.status.padEnd(10)} ${description}`
}

function taskStatusColor(theme: Theme, status: TaskRecord["status"]): string {
  if (status === "completed") return theme.colors.success
  if (status === "failed" || status === "cancelled") return theme.colors.error
  if (status === "backgrounded") return theme.colors.warning
  return theme.colors.mutedForeground
}

function taskPanelSummary(tasks: TaskRecord[]): string {
  const running = tasks.filter((task) => task.status === "running").length
  const backgrounded = tasks.filter((task) => task.status === "backgrounded").length
  const parts = [
    running ? `${running} running` : "",
    backgrounded ? `${backgrounded} working in background` : "",
  ].filter(Boolean)
  return parts.join(" · ") || "recent task history"
}

export function queuedPromptPreviewItems(prompts: QueuedPrompt[], selected = 0, maxItems = 3): Array<{ id: string; selected: boolean; text: string }> {
  const clamped = Math.min(Math.max(0, selected), Math.max(0, prompts.length - 1))
  const start = Math.min(Math.max(0, prompts.length - maxItems), Math.max(0, clamped - Math.floor(maxItems / 2)))
  return prompts.slice(start, start + maxItems).map((prompt, index) => ({
    id: prompt.id,
    selected: start + index === clamped,
    text: formatQueuedPromptPreview(prompt.text),
  }))
}

export function formatQueuedPromptPreview(text: string, max = 72): string {
  const normalized = text.replace(/\s+/g, " ").trim()
  return normalized.length > max ? `${normalized.slice(0, Math.max(0, max - 1))}…` : normalized
}

export function approvalChoiceItems(toolName: string): SelectListItem<PermissionDecision>[] {
  return [
    { label: "Allow once", value: "allow_once", description: "only this call" },
    { label: `Allow ${toolName} for conversation`, value: "allow_tool_session", description: "future calls of this tool" },
    { label: "Allow all tools for conversation", value: "allow_all_session", description: "current conversation only" },
    { label: "Deny", value: "deny", description: "only this call" },
  ]
}

function formatApprovalArgs(args: string): string {
  try {
    const parsed = args.trim() ? JSON.parse(args) : {}
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>
      const primary = ["command", "path", "patch", "query", "url", "pattern"].find((key) => typeof record[key] === "string")
      if (primary) return `${primary}: ${String(record[primary]).replace(/\s+/g, " ").trim()}`
    }
  } catch {
    // Fall through to raw argument preview.
  }
  return args.replace(/\s+/g, " ").trim() || "no arguments"
}

function hintItems(kind: UiScreen["kind"]): string[] {
  if (kind === "model") return ["type to filter", "enter select", "tab edit", "esc cancel"]
  if (kind === "theme") return ["up/down navigate", "enter preview", "esc cancel"]
  if (kind === "history") return ["up/down navigate", "enter open", "esc cancel"]
  return ["/new", "/history", "/model", "/theme", "/tasks", "/lofi", "/reset-perms", "/exit"]
}

function ChatScreen({
  interactionActive,
  onScrollStateChange,
  thinking,
  thinkingMessage,
  reservedRows,
  toolActivities,
  transcript,
}: {
  interactionActive?: boolean
  onScrollStateChange?: (canScrollUp: boolean) => void
  reservedRows?: number
  thinking: boolean
  thinkingMessage: string
  toolActivities: ToolActivity[]
  transcript: TranscriptMessage[]
}): React.ReactNode {
  const theme = useTheme()
  const { columns, rows } = useWindowSize()
  const [scrollOffset, setScrollOffset] = React.useState(0)
  const viewportRows = chatViewportRows(rows, reservedRows || 0)
  const activityKey = React.useMemo(
    () => toolActivities.map((activity) => `${activity.id}:${activity.status}`).join("|"),
    [toolActivities],
  )
  const transcriptLines = React.useMemo(
    () => buildTranscriptLines(transcript, Math.max(20, columns - 4), toolActivities, thinking, thinkingMessage),
    [columns, thinking, thinkingMessage, toolActivities, transcript],
  )
  const maxScrollOffset = Math.max(0, transcriptLines.length - viewportRows)
  const pageScrollRows = Math.max(1, viewportRows - 2)
  const end = Math.max(0, transcriptLines.length - Math.min(scrollOffset, maxScrollOffset))
  const visibleLines = React.useMemo(
    () => visibleTranscriptWindow(transcriptLines, Math.max(0, end - viewportRows), end, viewportRows),
    [end, transcriptLines, viewportRows],
  )

  React.useEffect(() => {
    setScrollOffset((current) => Math.min(current, maxScrollOffset))
  }, [maxScrollOffset])

  React.useEffect(() => {
    setScrollOffset(0)
  }, [transcript.length])

  React.useEffect(() => {
    if (thinking || toolActivities.length > 0) setScrollOffset(0)
  }, [activityKey, thinking, thinkingMessage, toolActivities.length])

  React.useEffect(() => {
    onScrollStateChange?.(maxScrollOffset > scrollOffset)
  }, [maxScrollOffset, onScrollStateChange, scrollOffset])

  useInput((input, key) => {
    if (interactionActive) return
    if (key.pageUp || (key.ctrl && input === "u")) {
      setScrollOffset((current) => Math.min(maxScrollOffset, current + pageScrollRows))
      return
    }
    if (key.pageDown || (key.ctrl && input === "d")) {
      setScrollOffset((current) => Math.max(0, current - pageScrollRows))
      return
    }
    if (key.upArrow) {
      setScrollOffset((current) => Math.min(maxScrollOffset, current + 1))
      return
    }
    if (key.downArrow) {
      setScrollOffset((current) => Math.max(0, current - 1))
      return
    }
    if (key.end) setScrollOffset(0)
    if (key.home) setScrollOffset(maxScrollOffset)
  })

  if (transcriptLines.length === 0) {
    return (
      <Box flexGrow={1} alignItems="center" justifyContent="center">
        <Text color={theme.colors.mutedForeground}>Start a conversation, or use /history, /model, and /theme.</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      {visibleLines.map((line, index) => (
        <TranscriptLine key={`${line.messageIndex ?? "line"}-${line.kind}-${index}`} line={line} />
      ))}
    </Box>
  )
}

export function chatViewportRows(windowRows: number, reservedRows = 0): number {
  // Header, prompt, and hints use fixed bordered rows; keep one spare row so
  // Ink never clips the final assistant spinner behind the input box.
  return Math.max(3, windowRows - 11 - reservedRows)
}

type TranscriptLineData = {
  kind: "blank" | "content" | "plan" | "spinner" | "role" | "tool"
  messageIndex?: number
  planTone?: "border" | "content" | "meta"
  role?: TranscriptMessage["role"]
  status?: ToolActivity["status"]
  text: string
  toolTone?: "addition" | "context" | "deletion" | "error" | "meta" | "summary"
}

const TranscriptLine = React.memo(function TranscriptLine({ line }: { line: TranscriptLineData }): React.ReactNode {
  const theme = useTheme()
  if (line.kind === "blank") return <Text> </Text>
  if (line.kind === "spinner") return <Spinner label={line.text} />
  if (line.kind === "role") return <Text color={line.role === "user" ? theme.colors.primary : theme.colors.border} bold>{line.text}</Text>
  if (line.kind === "tool") {
    if (line.toolTone === "addition") return <Text color={theme.colors.success}>{line.text}</Text>
    if (line.toolTone === "deletion" || line.toolTone === "error") return <Text color={theme.colors.error}>{line.text}</Text>
    if (line.toolTone === "meta" || line.toolTone === "context") return <Text color={theme.colors.mutedForeground}>{line.text}</Text>
    const color = line.status === "failed" ? theme.colors.error : line.status === "done" ? theme.colors.success : theme.colors.primary
    return <Text color={color} bold={line.toolTone === "summary"}>{line.text}</Text>
  }
  if (line.kind === "plan") {
    if (line.planTone === "content") return <MarkdownLine text={line.text || " "} prefix="| " />
    const color = line.planTone === "border" ? theme.colors.primary : theme.colors.mutedForeground
    return <Text color={color}>{line.planTone === "meta" ? `| ${line.text || " "}` : line.text || " "}</Text>
  }
  if (line.role === "assistant") return <MarkdownLine text={line.text || " "} />
  return <Text color={theme.colors.foreground}>{line.text || " "}</Text>
})

function MarkdownLine({ text, prefix = "" }: { text: string; prefix?: string }): React.ReactNode {
  const theme = useTheme()
  const heading = text.match(/^(#{1,6})\s+(.+)$/)
  if (heading) {
    return (
      <Text color={theme.colors.primary} bold>
        {prefix}{heading[2]}
      </Text>
    )
  }

  const quote = text.match(/^>\s?(.*)$/)
  if (quote) {
    return (
      <Text color={theme.colors.mutedForeground}>
        {prefix}| <InlineMarkdown text={quote[1] || " "} />
      </Text>
    )
  }

  const unordered = text.match(/^(\s*)[-*]\s+(.+)$/)
  if (unordered) {
    return (
      <Text color={theme.colors.foreground}>
        {prefix}{unordered[1]}- <InlineMarkdown text={unordered[2]} />
      </Text>
    )
  }

  const ordered = text.match(/^(\s*)(\d+[.)])\s+(.+)$/)
  if (ordered) {
    return (
      <Text color={theme.colors.foreground}>
        {prefix}{ordered[1]}
        {ordered[2]} <InlineMarkdown text={ordered[3]} />
      </Text>
    )
  }

  const fence = text.match(/^```(.*)$/)
  if (fence) {
    return <Text color={theme.colors.mutedForeground}>{prefix}{fence[1] ? `code ${fence[1]}` : "code"}</Text>
  }

  return (
    <Text color={theme.colors.foreground}>
      {prefix}<InlineMarkdown text={text} />
    </Text>
  )
}

function InlineMarkdown({ text }: { text: string }): React.ReactNode {
  const theme = useTheme()
  const parts = parseInlineMarkdown(text)
  return (
    <>
      {parts.map((part, index) => {
        if (part.kind === "code") {
          return (
            <Text key={index} color={theme.colors.accentForeground} backgroundColor={theme.colors.muted}>
              {part.text}
            </Text>
          )
        }
        if (part.kind === "bold") {
          return (
            <Text key={index} color={theme.colors.foreground} bold>
              {part.text}
            </Text>
          )
        }
        if (part.kind === "italic") {
          return (
            <Text key={index} color={theme.colors.foreground} italic>
              {part.text}
            </Text>
          )
        }
        return <Text key={index}>{part.text}</Text>
      })}
    </>
  )
}

function buildTranscriptLines(transcript: TranscriptMessage[], width: number, toolActivities: ToolActivity[], thinking: boolean, thinkingMessage: string): TranscriptLineData[] {
  const lines: TranscriptLineData[] = []
  const hasToolActivities = toolActivities.length > 0
  const finalAssistantIndex = hasToolActivities && transcript[transcript.length - 1]?.role === "assistant" ? transcript.length - 1 : -1

  for (const [messageIndex, message] of transcript.entries()) {
    if (messageIndex === finalAssistantIndex) continue
    appendMessageLines(lines, message, messageIndex, width)
  }

  if (hasToolActivities) {
    appendToolLines(lines, toolActivities, finalAssistantIndex >= 0 ? finalAssistantIndex : transcript.length, width)
  }

  if (finalAssistantIndex >= 0) {
    appendMessageLines(lines, transcript[finalAssistantIndex], finalAssistantIndex, width)
  }

  if (thinking) {
    lines.push({ kind: "role", messageIndex: transcript.length, role: "assistant", text: "assistant" })
    lines.push({ kind: "spinner", messageIndex: transcript.length, role: "assistant", text: thinkingMessage })
  }
  return lines
}

function appendMessageLines(lines: TranscriptLineData[], message: TranscriptMessage, messageIndex: number, width: number): void {
  lines.push({ kind: "role", messageIndex, role: message.role, text: message.role === "user" ? "user" : "assistant" })
  if (message.role === "assistant") {
    const planPreview = splitSavedPlanPreview(message.content)
    if (planPreview) {
      appendWrappedContentLines(lines, planPreview.before.join("\n") || " ", message, messageIndex, width)
      for (const line of planPreviewBoxLines(planPreview.path, planPreview.body.join("\n"), width)) {
        lines.push({ kind: "plan", messageIndex, planTone: line.tone, role: message.role, text: line.text })
      }
      lines.push({ kind: "blank", messageIndex, role: message.role, text: "" })
      return
    }
  }
  appendWrappedContentLines(lines, message.content || " ", message, messageIndex, width)
  lines.push({ kind: "blank", messageIndex, role: message.role, text: "" })
}

function appendWrappedContentLines(lines: TranscriptLineData[], content: string, message: TranscriptMessage, messageIndex: number, width: number): void {
  for (const wrappedLine of wrapAnsi(content, width, { hard: false, wordWrap: true }).split("\n")) {
    lines.push({ kind: "content", messageIndex, role: message.role, text: wrappedLine })
  }
}

function appendToolLines(lines: TranscriptLineData[], toolActivities: ToolActivity[], messageIndex: number, width: number): void {
  lines.push({ kind: "role", messageIndex, role: "assistant", text: "tools" })
  for (const activity of toolActivities) {
    for (const rendered of formatToolActivity(activity, width)) {
      lines.push({
        kind: "tool",
        messageIndex,
        role: "assistant",
        status: activity.status,
        text: rendered.text,
        toolTone: rendered.tone,
      })
    }
  }
  lines.push({ kind: "blank", messageIndex, role: "assistant", text: "" })
}

type SavedPlanPreview = {
  before: string[]
  body: string[]
  path: string
}

function splitSavedPlanPreview(content: string): SavedPlanPreview | undefined {
  const source = content.split(/\r?\n/)
  const markerIndex = source.findIndex((line) => line.trim() === "## Saved Plan")
  if (markerIndex < 0) return undefined

  const pathIndex = source.findIndex((line, index) => index > markerIndex && /^Path: `.+`$/.test(line.trim()))
  if (pathIndex < 0) return undefined
  const path = source[pathIndex].trim().match(/^Path: `(.+)`$/)?.[1]
  if (!path) return undefined

  const before = trimEmptyLines(source.slice(0, markerIndex))
  const body = trimEmptyLines(source.slice(pathIndex + 1))
  return { before, body, path }
}

export function planPreviewBoxLines(path: string, body: string, width: number): Array<{ text: string; tone: "border" | "content" | "meta" }> {
  const boxWidth = Math.max(32, width)
  const innerWidth = Math.max(1, boxWidth - 4)
  const lines: Array<{ text: string; tone: "border" | "content" | "meta" }> = []
  lines.push({ text: planPreviewBorder(" Saved Plan ", boxWidth), tone: "border" })
  for (const wrappedPath of wrapAnsi(`Path: ${path}`, innerWidth, { hard: false, wordWrap: true }).split("\n")) {
    lines.push({ text: wrappedPath, tone: "meta" })
  }
  lines.push({ text: "|", tone: "border" })
  for (const sourceLine of body.split(/\r?\n/)) {
    const wrapped = sourceLine ? wrapAnsi(sourceLine, innerWidth, { hard: false, wordWrap: true }).split("\n") : [""]
    for (const line of wrapped) {
      lines.push({ text: line, tone: "content" })
    }
  }
  lines.push({ text: planPreviewBorder("", boxWidth), tone: "border" })
  return lines
}

function planPreviewBorder(label: string, width: number): string {
  const prefix = label ? `+${label}` : "+"
  return `${prefix}${"-".repeat(Math.max(0, width - prefix.length - 1))}+`
}

function trimEmptyLines(lines: string[]): string[] {
  const next = [...lines]
  while (next[0]?.trim() === "") next.shift()
  while (next[next.length - 1]?.trim() === "") next.pop()
  return next
}

type InlineMarkdownPart = {
  kind: "text" | "bold" | "italic" | "code"
  text: string
}

export function parseInlineMarkdown(text: string): InlineMarkdownPart[] {
  const parts: InlineMarkdownPart[] = []
  let index = 0

  while (index < text.length) {
    const nextCode = text.indexOf("`", index)
    const nextBold = text.indexOf("**", index)
    const nextItalic = nextSingleAsterisk(text, index)
    const candidates = [nextCode, nextBold, nextItalic].filter((value) => value >= 0)
    const next = candidates.length > 0 ? Math.min(...candidates) : -1

    if (next < 0) {
      pushMarkdownPart(parts, "text", text.slice(index))
      break
    }

    if (next > index) pushMarkdownPart(parts, "text", text.slice(index, next))

    if (next === nextCode) {
      const end = text.indexOf("`", next + 1)
      if (end < 0) {
        pushMarkdownPart(parts, "text", text.slice(next))
        break
      }
      pushMarkdownPart(parts, "code", text.slice(next + 1, end))
      index = end + 1
      continue
    }

    if (next === nextBold) {
      const end = text.indexOf("**", next + 2)
      if (end < 0) {
        pushMarkdownPart(parts, "text", text.slice(next))
        break
      }
      pushMarkdownPart(parts, "bold", text.slice(next + 2, end))
      index = end + 2
      continue
    }

    const end = text.indexOf("*", next + 1)
    if (end < 0) {
      pushMarkdownPart(parts, "text", text.slice(next))
      break
    }
    pushMarkdownPart(parts, "italic", text.slice(next + 1, end))
    index = end + 1
  }

  return parts.length > 0 ? parts : [{ kind: "text", text }]
}

function nextSingleAsterisk(text: string, start: number): number {
  for (let index = start; index < text.length; index += 1) {
    if (text[index] !== "*") continue
    if (text[index - 1] === "*" || text[index + 1] === "*") continue
    return index
  }
  return -1
}

function pushMarkdownPart(parts: InlineMarkdownPart[], kind: InlineMarkdownPart["kind"], text: string): void {
  if (!text) return
  const previous = parts[parts.length - 1]
  if (previous?.kind === kind) {
    previous.text += text
    return
  }
  parts.push({ kind, text })
}

type RenderedToolLine = {
  text: string
  tone?: TranscriptLineData["toolTone"]
}

export function formatToolActivity(activity: ToolActivity, width: number): RenderedToolLine[] {
  if (activity.status === "failed") {
    return [{ text: `${statusSymbol(activity.status)} ${activity.name}${formatToolArgs(activity.args, width)}${formatToolResult(activity.result, width)}`, tone: "error" }]
  }

  if (activity.name === "edit") {
    const editLines = formatEditActivity(activity, width)
    if (editLines.length > 0) return editLines
  }

  if (activity.name === "write") {
    const writeLines = formatWriteActivity(activity, width)
    if (writeLines.length > 0) return writeLines
  }

  if (activity.name === "ask_question") {
    const questionLines = formatAskQuestionActivity(activity, width)
    if (questionLines.length > 0) return questionLines
  }

  if (activity.name === "task") {
    const taskLines = formatTaskActivity(activity, width)
    if (taskLines.length > 0) return taskLines
  }

  if (activity.name === "skill_manage") {
    const skillLines = formatSkillManageActivity(activity, width)
    if (skillLines.length > 0) return skillLines
  }

  return [{ text: `${statusSymbol(activity.status)} ${activity.name}${formatToolArgs(activity.args, width)}${formatToolResult(activity.result, width)}`, tone: "summary" }]
}

function formatEditActivity(activity: ToolActivity, width: number): RenderedToolLine[] {
  const patch = parseJsonStringField(activity.args, "patch")
  if (!patch) return []

  const operations = parsePatchPreview(patch)
  if (operations.length === 0) return []

  const resultFiles = parseEditResult(activity.result || "")
  const lines: RenderedToolLine[] = []
  const totalDelta = operations.reduce((sum, operation) => sum + operation.added - operation.removed, 0)
  lines.push({
    text: `${statusSymbol(activity.status)} Edited ${operations.map((operation) => operation.file).join(", ")}${formatDelta(totalDelta)}`,
    tone: "summary",
  })

  for (const operation of operations.slice(0, 3)) {
    const result = resultFiles.find((candidate) => candidate.file === operation.file)
    const delta = formatDelta((result?.added ?? operation.added) - (result?.removed ?? operation.removed))
    lines.push({ text: `  ${operation.kind} ${truncateEnd(operation.file, Math.max(24, width - 16))}${delta}`, tone: "meta" })
    const preview = operation.lines.slice(0, 12)
    for (const line of preview) {
      const tone = line.startsWith("+") ? "addition" : line.startsWith("-") ? "deletion" : line.startsWith("@@") ? "meta" : "context"
      lines.push({ text: `  ${truncateEnd(line, Math.max(24, width - 4))}`, tone })
    }
    if (operation.lines.length > preview.length) lines.push({ text: `  ... truncated ${operation.lines.length - preview.length} more lines`, tone: "meta" })
  }
  if (operations.length > 3) lines.push({ text: `  ... ${operations.length - 3} more file operation${operations.length - 3 === 1 ? "" : "s"}`, tone: "meta" })
  return lines
}

function formatWriteActivity(activity: ToolActivity, width: number): RenderedToolLine[] {
  const path = parseJsonStringField(activity.args, "path")
  const content = parseJsonStringField(activity.args, "content")
  if (!path) return []

  const contentLines = typeof content === "string" ? content.split(/\r?\n/).filter((line, index, all) => index < all.length - 1 || line !== "") : []
  const lines: RenderedToolLine[] = [
    {
      text: `${statusSymbol(activity.status)} Wrote ${truncateEnd(path, Math.max(24, width - 24))}${contentLines.length > 0 ? ` +${contentLines.length}` : ""}`,
      tone: "summary",
    },
  ]

  for (const line of contentLines.slice(0, 8)) {
    lines.push({ text: `  +${truncateEnd(line, Math.max(24, width - 5))}`, tone: "addition" })
  }
  if (contentLines.length > 8) lines.push({ text: `  ... truncated ${contentLines.length - 8} more lines`, tone: "meta" })
  return lines
}

function formatAskQuestionActivity(activity: ToolActivity, width: number): RenderedToolLine[] {
  const questions = parseAskQuestionArgs(activity.args)
  if (questions.length === 0) return []
  const answerLines = parseAskQuestionAnswers(activity.result || "")
  const lines: RenderedToolLine[] = [
    {
      text: `${statusSymbol(activity.status)} Asked ${questions.length} question${questions.length === 1 ? "" : "s"}`,
      tone: "summary",
    },
  ]

  for (const question of questions.slice(0, 4)) {
    lines.push({ text: `  ? ${truncateEnd(question.prompt, Math.max(24, width - 6))}`, tone: "meta" })
    const options = question.options.slice(0, 4).map((option) => option.label).join(" / ")
    if (options) lines.push({ text: `    choices: ${truncateEnd(options, Math.max(24, width - 13))}`, tone: "context" })
    const answer = answerLines.find((candidate) => candidate.questionId === question.id)
    if (answer) {
      const tone = answer.kind === "refused" ? "error" : "addition"
      lines.push({ text: `    answer: ${truncateEnd(answer.text, Math.max(24, width - 12))}`, tone })
    } else if (activity.status === "running") {
      lines.push({ text: "    waiting for answer...", tone: "context" })
    }
  }
  if (questions.length > 4) lines.push({ text: `  ... ${questions.length - 4} more question${questions.length - 4 === 1 ? "" : "s"}`, tone: "meta" })
  return lines
}

function formatTaskActivity(activity: ToolActivity, width: number): RenderedToolLine[] {
  const tasks = parseTaskArgs(activity.args)
  if (tasks.length === 0) return []
  const backgrounded = /backgrounded/i.test(activity.result || "")
  const lines: RenderedToolLine[] = [
    {
      text: `${statusSymbol(activity.status)} ${backgrounded ? "Backgrounded" : activity.status === "running" ? "Running" : "Finished"} ${tasks.length} subagent${tasks.length === 1 ? "" : "s"}`,
      tone: "summary",
    },
  ]
  for (const task of tasks.slice(0, 4)) {
    lines.push({ text: `  - ${truncateEnd(task.description || task.prompt, Math.max(24, width - 6))}`, tone: "meta" })
  }
  if (tasks.length > 4) lines.push({ text: `  ... ${tasks.length - 4} more subagent${tasks.length - 4 === 1 ? "" : "s"}`, tone: "meta" })
  const firstResult = activity.result?.split(/\r?\n/).find((line) => /^Task group /.test(line))
  if (firstResult) lines.push({ text: `  ${truncateEnd(firstResult, Math.max(24, width - 4))}`, tone: backgrounded ? "context" : "addition" })
  return lines
}

function formatSkillManageActivity(activity: ToolActivity, width: number): RenderedToolLine[] {
  const args = parseJsonRecord(activity.args)
  const name = stringField(args, "name")
  const description = stringField(args, "description")
  const body = stringField(args, "body")
  if (!name || !description || !body) return []
  const target = stringField(args, "target") || "project"
  const overwrite = booleanField(args, "overwrite")
  const disableModelInvocation = booleanField(args, "disableModelInvocation")
  const file = skillManageDisplayPath(name, target)
  const contentLines = renderSkillManagePreview(name, description, body, disableModelInvocation).split(/\r?\n/)
  const lines: RenderedToolLine[] = [
    {
      text: `${statusSymbol(activity.status)} ${overwrite ? "Update" : "Create"} skill ${name}`,
      tone: activity.status === "failed" ? "error" : "summary",
    },
    { text: `  target ${target} -> ${truncateEnd(file, Math.max(24, width - 16))}`, tone: "meta" },
  ]
  for (const line of contentLines.slice(0, 10)) {
    lines.push({ text: `  +${truncateEnd(line, Math.max(24, width - 5))}`, tone: "addition" })
  }
  if (contentLines.length > 10) lines.push({ text: `  ... truncated ${contentLines.length - 10} more lines`, tone: "meta" })
  if (activity.result) {
    const firstResult = activity.result.split(/\r?\n/)[0]
    if (firstResult) lines.push({ text: `  ${truncateEnd(firstResult, Math.max(24, width - 4))}`, tone: "addition" })
  }
  return lines
}

type PatchPreviewOperation = {
  added: number
  file: string
  kind: "Added" | "Deleted" | "Edited"
  lines: string[]
  removed: number
}

function parsePatchPreview(patch: string): PatchPreviewOperation[] {
  const operations: PatchPreviewOperation[] = []
  const lines = patch.replace(/\r\n/g, "\n").split("\n")
  let current: PatchPreviewOperation | undefined

  for (const line of lines) {
    if (line.startsWith("*** Add File: ")) {
      current = { added: 0, file: line.slice("*** Add File: ".length).trim(), kind: "Added", lines: [], removed: 0 }
      operations.push(current)
      continue
    }
    if (line.startsWith("*** Update File: ")) {
      current = { added: 0, file: line.slice("*** Update File: ".length).trim(), kind: "Edited", lines: [], removed: 0 }
      operations.push(current)
      continue
    }
    if (line.startsWith("*** Delete File: ")) {
      current = { added: 0, file: line.slice("*** Delete File: ".length).trim(), kind: "Deleted", lines: [], removed: 0 }
      operations.push(current)
      continue
    }
    if (!current || line === "*** Begin Patch" || line === "*** End Patch" || line === "*** End of File") continue
    if (line.startsWith("@@")) {
      current.lines.push(line)
      continue
    }
    if (line.startsWith("+")) {
      current.added += 1
      current.lines.push(line)
      continue
    }
    if (line.startsWith("-")) {
      current.removed += 1
      current.lines.push(line)
      continue
    }
    if (line.startsWith(" ")) current.lines.push(line)
  }

  return operations
}

function parseEditResult(result: string): Array<{ added: number; file: string; removed: number }> {
  return result.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^(Added|Updated|Deleted)\s+(.+?)(?:\s+\(|$)/)
    if (!match) return []
    return [{ added: 0, file: match[2], removed: 0 }]
  })
}

function formatDelta(delta: number): string {
  if (delta === 0) return ""
  return delta > 0 ? ` +${delta}` : ` ${delta}`
}

function parseJsonStringField(args: string, key: string): string | undefined {
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>
    return typeof parsed[key] === "string" ? parsed[key] : undefined
  } catch {
    return undefined
  }
}

function parseJsonRecord(args: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(args) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function stringField(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === "string" ? value : undefined
}

function booleanField(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key]
  return typeof value === "boolean" ? value : undefined
}

function skillManageDisplayPath(name: string, target: string): string {
  const root = target === "user" ? "~/.furnace/skills" : target === "cursor-user" ? "~/.cursor/skills" : target === "claude-user" ? "~/.claude/skills" : ".furnace/skills"
  return `${root}/${name}/SKILL.md`
}

function renderSkillManagePreview(name: string, description: string, body: string, disableModelInvocation?: boolean): string {
  return [
    "---",
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`,
    disableModelInvocation === false ? undefined : "disable-model-invocation: true",
    "---",
    "",
    body.trim(),
  ].filter((line) => line !== undefined).join("\n")
}

function parseAskQuestionArgs(args: string): Array<{ id: string; options: Array<{ label: string }>; prompt: string }> {
  try {
    const parsed = JSON.parse(args) as { questions?: unknown }
    if (!Array.isArray(parsed.questions)) return []
    return parsed.questions.flatMap((item, index) => {
      if (!item || typeof item !== "object") return []
      const record = item as Record<string, unknown>
      const prompt = typeof record.prompt === "string" ? record.prompt : typeof record.question === "string" ? record.question : ""
      if (!prompt) return []
      const options = Array.isArray(record.options)
        ? record.options.flatMap((option) => {
            if (typeof option === "string") return [{ label: option }]
            if (!option || typeof option !== "object") return []
            const label = (option as Record<string, unknown>).label
            return typeof label === "string" ? [{ label }] : []
          })
        : []
      return [{ id: typeof record.id === "string" ? record.id : `q${index + 1}`, options, prompt }]
    })
  } catch {
    return []
  }
}

function parseAskQuestionAnswers(result: string): Array<{ kind: "refused" | "selected" | "wrote"; questionId: string; text: string }> {
  return result.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^([^:]+): user (selected|wrote|refused) "(.+)"$/)
    if (!match) return []
    return [{ questionId: match[1], kind: match[2] as "refused" | "selected" | "wrote", text: `${match[2]} "${match[3]}"` }]
  })
}

function parseTaskArgs(args: string): Array<{ description?: string; prompt: string }> {
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>
    if (Array.isArray(parsed.tasks)) {
      return parsed.tasks.flatMap((item) => {
        if (!item || typeof item !== "object") return []
        const record = item as Record<string, unknown>
        return typeof record.prompt === "string" ? [{ description: typeof record.description === "string" ? record.description : undefined, prompt: record.prompt }] : []
      })
    }
    return typeof parsed.prompt === "string" ? [{ description: typeof parsed.description === "string" ? parsed.description : undefined, prompt: parsed.prompt }] : []
  } catch {
    return []
  }
}

function statusSymbol(status: ToolActivity["status"]): string {
  if (status === "running") return ">"
  if (status === "failed") return "x"
  return "ok"
}

function formatToolArgs(args: string, width: number): string {
  const compact = compactToolArgs(args)
  if (!compact) return ""
  const maxLength = Math.max(16, Math.min(72, width - 16))
  return ` ${truncateEnd(compact, maxLength)}`
}

function formatToolResult(result: string | undefined, width: number): string {
  if (!result) return ""
  const firstLine = result.split(/\r?\n/).find((line) => line.trim())?.trim()
  if (!firstLine) return ""
  const maxLength = Math.max(16, Math.min(56, width - 24))
  return ` -> ${truncateEnd(firstLine, maxLength)}`
}

function compactToolArgs(args: string): string {
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>
    if (Array.isArray(parsed.tasks)) return `tasks: ${parsed.tasks.length}`
    if (typeof parsed.prompt === "string") return `prompt: ${JSON.stringify(parsed.prompt)}`
    const summary = ["path", "pattern", "query", "command", "patch"]
      .flatMap((key) => (typeof parsed[key] === "string" ? [`${key}: ${JSON.stringify(parsed[key])}`] : []))
      .slice(0, 2)
      .join(", ")
    return summary || JSON.stringify(parsed)
  } catch {
    return args.trim()
  }
}

function visibleTranscriptWindow(lines: TranscriptLineData[], start: number, end: number, viewportRows: number): TranscriptLineData[] {
  const visible = lines.slice(start, end)
  while (visible[0]?.kind === "blank") visible.shift()

  const first = visible[0]
  if (first && first.kind !== "role" && first.role) {
    visible.unshift({
      kind: "role",
      messageIndex: first.messageIndex,
      role: first.role,
      text: `${first.role === "user" ? "user" : "assistant"} (continued)`,
    })
  }

  return visible.slice(0, viewportRows)
}

function HistoryScreen({ screen, store }: { screen: Extract<UiScreen, { kind: "history" }>; store: UiStore }): React.ReactNode {
  const theme = useTheme()
  const [filter, setFilter] = React.useState("")

  const filteredChoices = React.useMemo(() => {
    const normalized = filter.trim().toLowerCase()
    if (!normalized) return screen.choices
    return screen.choices.filter((c) => c.title.toLowerCase().includes(normalized))
  }, [screen.choices, filter])

  const items: Array<SelectListItem<string>> = React.useMemo(
    () =>
      filteredChoices.map((choice) => ({
        description: formatRelativeTime(choice.updatedAt),
        label: choice.title,
        value: choice.id,
      })),
    [filteredChoices],
  )

  useInput((input, key) => {
    if (key.escape) {
      store.update({ screen: { kind: "chat" } })
      screen.onCancel()
      return
    }
    if (key.backspace || key.delete) {
      setFilter((current) => current.slice(0, -1))
      return
    }
    if (!key.ctrl && !key.meta && !key.upArrow && !key.downArrow && !key.return && input) {
      setFilter((current) => current + input)
    }
  })

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Text color={theme.colors.primary} bold>
        Select a conversation
      </Text>
      <Text color={theme.colors.mutedForeground}>Filter: {filter || "type to search"}</Text>
      <SelectList
        items={items}
        maxRows={12}
        onCancel={() => {
          store.update({ screen: { kind: "chat" } })
          screen.onCancel()
        }}
        onSelect={(item) => {
          store.update({ screen: { kind: "chat" } })
          screen.onSelect(item.value)
        }}
        selectedValue={filter ? null : screen.currentSessionId}
      />
    </Box>
  )
}

function ThemeScreen({ screen, store }: { screen: Extract<UiScreen, { kind: "theme" }>; store: UiStore }): React.ReactNode {
  const theme = useTheme()
  const items: Array<SelectListItem<string>> = React.useMemo(
    () =>
      screen.choices.map((choice) => ({
        description: choice.description,
        label: choice.name,
        value: choice.name,
      })),
    [screen.choices],
  )
  const previewTheme = React.useCallback(
    (item: SelectListItem<string>) => {
      const choice = resolveTheme(item.value)
      store.update({ theme: choice.theme, themeName: choice.name })
    },
    [store],
  )

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Text color={theme.colors.primary} bold>
        Select a theme
      </Text>
      <SelectList
        items={items}
        maxRows={12}
        onCancel={() => {
          const choice = resolveTheme(screen.currentTheme)
          store.update({ theme: choice.theme, themeName: choice.name, screen: { kind: "chat" } })
          screen.onCancel()
        }}
        onHighlight={previewTheme}
        onSelect={(item) => {
          const choice = resolveTheme(item.value)
          store.update({ theme: choice.theme, themeName: choice.name, screen: { kind: "chat" } })
          screen.onSelect(choice.name, true)
        }}
        selectedValue={screen.currentTheme}
      />
    </Box>
  )
}

function ModelScreen({ model, screen, store }: { model: string; screen: Extract<UiScreen, { kind: "model" }>; store: UiStore }): React.ReactNode {
  const theme = useTheme()
  const [filter, setFilter] = React.useState("")
  const [activeIndex, setActiveIndex] = React.useState(0)
  const [editing, setEditing] = React.useState<{ choice: ModelChoice; selectedIndex: number } | undefined>()
  const filteredChoices = React.useMemo(() => filterModels(screen.choices, filter), [screen.choices, filter])
  const selectedChoice = filteredChoices[activeIndex]

  React.useEffect(() => {
    setActiveIndex((current) => Math.min(Math.max(0, current), Math.max(0, filteredChoices.length - 1)))
  }, [filteredChoices.length])

  useInput((input, key) => {
    if (editing) {
      const rows = modelEditorRows(editing.choice, settingsForModel(screen, editing.choice.id))
      if (key.escape || key.tab) {
        setEditing(undefined)
        return
      }
      if (key.upArrow) return setEditing({ ...editing, selectedIndex: Math.max(0, editing.selectedIndex - 1) })
      if (key.downArrow) return setEditing({ ...editing, selectedIndex: Math.min(rows.length - 1, editing.selectedIndex + 1) })
      if (key.return) {
        const row = rows[editing.selectedIndex]
        if (row && !row.disabled) applyModelEditorRow(store, screen, editing.choice, row)
      }
      return
    }

    if (key.escape) {
      store.update({ screen: { kind: "chat" } })
      screen.onCancel()
      return
    }
    if (key.upArrow) return setActiveIndex((current) => Math.max(0, current - 1))
    if (key.downArrow) return setActiveIndex((current) => Math.min(filteredChoices.length - 1, current + 1))
    if (key.tab) {
      if (selectedChoice) setEditing({ choice: selectedChoice, selectedIndex: 0 })
      return
    }
    if (key.return) {
      if (!selectedChoice) return
      store.update({ screen: { kind: "chat" } })
      screen.onSelect(selectedChoice.id, settingsForModel(screen, selectedChoice.id), true)
      return
    }
    if (key.backspace || key.delete) {
      setFilter((current) => current.slice(0, -1))
      setActiveIndex(0)
      return
    }
    if (!key.ctrl && !key.meta && input) {
      setFilter((current) => `${current}${input}`)
      setActiveIndex(0)
    }
  })

  if (editing) return <ModelEditorScreen choice={editing.choice} selectedIndex={editing.selectedIndex} settings={settingsForModel(screen, editing.choice.id)} />

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Text color={theme.colors.primary} bold>
        Available OpenRouter models
      </Text>
      <Text color={theme.colors.mutedForeground}>Filter: {filter || "type to search"}</Text>
      {renderModelRows(filteredChoices, activeIndex, model)}
    </Box>
  )
}

function ModelEditorScreen({ choice, selectedIndex, settings }: { choice: ModelChoice; selectedIndex: number; settings: ModelSettings }): React.ReactNode {
  const theme = useTheme()
  const rows = modelEditorRows(choice, settings)

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Text color={theme.colors.primary} bold>
        {choice.name} - Edit parameters
      </Text>
      {rows.map((row, index) => (
        <Box key={`${row.kind}-${row.label}`} justifyContent="space-between">
          <Text color={row.disabled ? theme.colors.mutedForeground : index === selectedIndex ? theme.colors.primary : theme.colors.foreground}>
            {index === selectedIndex ? "› " : "  "}
            {row.label}
          </Text>
          <Text color={row.selected ? theme.colors.success : theme.colors.mutedForeground}>{row.selected ? "selected" : row.disabled ? "disabled" : ""}</Text>
        </Box>
      ))}
    </Box>
  )
}

function renderModelRows(choices: ModelChoice[], activeIndex: number, currentModel: string): React.ReactNode {
  const theme = useTheme()
  const maxRows = 12
  const half = Math.floor(maxRows / 2)
  const maxOffset = Math.max(0, choices.length - maxRows)
  const offset = Math.min(maxOffset, Math.max(0, activeIndex - half))
  const visibleChoices = choices.slice(offset, offset + maxRows)

  if (choices.length === 0) return <Text color={theme.colors.mutedForeground}>No matching models.</Text>

  return (
    <Box flexDirection="column">
      {visibleChoices.map((choice, visibleIndex) => {
        const index = offset + visibleIndex
        const isActive = index === activeIndex
        const isSelected = choice.id === currentModel
        return (
          <Box key={choice.id} justifyContent="space-between">
            <Box>
              <Text color={isActive ? theme.colors.primary : theme.colors.mutedForeground}>{isActive ? "› " : "  "}</Text>
              <Text color={isActive ? theme.colors.primary : isSelected ? theme.colors.success : theme.colors.foreground} bold={isActive || isSelected}>
                {isSelected ? "* " : ""}
                {choice.name}
              </Text>
            </Box>
            <Text color={theme.colors.mutedForeground}>
              {formatContext(choice.contextLength)} {supportsReasoning(choice) ? "reasoning " : ""}
              {choice.id}
            </Text>
          </Box>
        )
      })}
      {choices.length > maxRows ? (
        <Text color={theme.colors.mutedForeground}>
          {offset + 1}-{Math.min(choices.length, offset + maxRows)} of {choices.length}
        </Text>
      ) : null}
    </Box>
  )
}

type ModelEditorRow =
  | { kind: "context"; label: string; value: number; selected: boolean; disabled?: boolean }
  | { kind: "reasoning"; label: string; value: ReasoningEffort; selected: boolean; disabled?: boolean }
  | { kind: "fast"; label: string; selected: boolean; disabled?: boolean }

function settingsForModel(screen: Extract<UiScreen, { kind: "model" }>, model: string): ModelSettings {
  const choice = findModelChoice(screen.choices, model)
  const normalized = normalizeModelSettings(screen.settingsByModel[model] || {}, choice)
  screen.settingsByModel[model] = normalized
  return normalized
}

function applyModelEditorRow(store: UiStore, screen: Extract<UiScreen, { kind: "model" }>, choice: ModelChoice, row: ModelEditorRow): void {
  const current = settingsForModel(screen, choice.id)
  const next =
    row.kind === "context"
      ? normalizeModelSettings({ ...current, contextLength: row.value }, choice)
      : row.kind === "reasoning"
        ? normalizeModelSettings({ ...current, reasoningEffort: row.value }, choice)
        : normalizeModelSettings({ ...current, fast: !current.fast }, choice)

  const nextScreen = { ...screen, currentModel: choice.id, settingsByModel: { ...screen.settingsByModel, [choice.id]: next } }
  store.update((state) => ({ ...state, model: choice.id, modelSettings: next, screen: nextScreen }))
  screen.onSelect(choice.id, next, false)
}

function modelEditorRows(choice: ModelChoice, settings: ModelSettings): ModelEditorRow[] {
  const rows: ModelEditorRow[] = []
  for (const option of contextOptions(choice)) rows.push({ kind: "context", label: `Context ${formatContext(option)}`, value: option, selected: settings.contextLength === option })

  const reasoningOptions: Array<{ label: string; value: ReasoningEffort }> = [
    { label: "Reasoning none", value: "none" },
    { label: "Reasoning low", value: "low" },
    { label: "Reasoning medium", value: "medium" },
    { label: "Reasoning high", value: "high" },
    { label: "Reasoning extra high", value: "xhigh" },
  ]
  for (const option of supportsReasoning(choice) ? reasoningOptions : reasoningOptions.slice(0, 1)) {
    rows.push({ kind: "reasoning", label: option.label, value: option.value, selected: settings.reasoningEffort === option.value, disabled: option.value !== "none" && !supportsReasoning(choice) })
  }

  rows.push({ kind: "fast", label: "Fast provider routing", selected: Boolean(settings.fast), disabled: !supportsFastContext(settings.contextLength) })
  return rows
}

function filterModels(choices: ModelChoice[], filter: string): ModelChoice[] {
  const normalized = filter.trim().toLowerCase()
  if (!normalized) return choices
  return choices.filter((choice) => `${choice.id} ${choice.name}`.toLowerCase().includes(normalized))
}

function findModelChoice(choices: ModelChoice[], model: string): ModelChoice | undefined {
  return choices.find((choice) => choice.id === model)
}

function formatContext(contextLength: number | null | undefined): string {
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

function modeLabel(state: UiState): string {
  return state.mode === "plan" ? `plan${state.planPath ? ` ${state.planPath}` : ""}` : "agent"
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

function shortenHome(path: string): string {
  const home = process.env.HOME
  if (!home) return path
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path
}

export { themeChoices }
