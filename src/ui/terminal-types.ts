import type { AskQuestionRequest, AskQuestionResponse } from "../questions.js"
import type { PermissionDecision, PermissionGrantSummary, PermissionRequest } from "../permissions.js"
import type { FurnacePreferences, ModelSettings, StatusLinePreferences, TerminalLayout } from "../preferences.js"
import type { TranscriptMessage } from "../session/types.js"
import type { TaskRecord } from "../tasks/types.js"
import type { AgentMode } from "../plan-mode.js"
import type { ImageAttachment, ImageSource } from "../utils/images.js"

export type PromptAutocompleteItem = {
  browsable?: boolean
  description?: string
  insertText?: string
  label: string
  relatedValue?: string
  value: string
}

export type PromptAutocompleteMatch = PromptAutocompleteItem & {
  selected: boolean
}

export type StatusNoticeTone = "default" | "warning" | "error" | "success"

export type FurnaceTerminal = {
  clearInteractionPrompts(): void
  clearToolActivities(): void
  clearPlanActions(): void
  requestQuestions(request: AskQuestionRequest): Promise<AskQuestionResponse>
  requestApproval(request: PermissionRequest): Promise<PermissionDecision>
  showQuestionPrompt(request: AskQuestionRequest, resolve: (response: AskQuestionResponse) => void): void
  showApprovalPrompt(request: PermissionRequest, resolve: (decision: PermissionDecision) => void): void
  run(): Promise<void>
  stop(): void
  waitForInputFocus(): Promise<void>
  setBusy(busy: boolean): void
  setContextUsage(tokens: number, window: number): void
  setCostUsage(costUsd?: number): void
  setInputDraft(value: string): void
  setInputDisabled(disabled: boolean): void
  setStatusLinePreferences(preferences: StatusLinePreferences): void
  setSessionMeta(meta: { forkParentTitle?: string; title: string }): void
  setLofi(enabled: boolean): void
  setLayout(layout: TerminalLayout): void
  setMode(mode: AgentMode, planPath?: string): void
  setThinking(thinking: boolean, message?: string): void
  setQueuedPrompts(prompts: QueuedPrompt[]): void
  setSlashCommandItems(items: PromptAutocompleteItem[]): void
  setTasks(tasks: TaskRecord[]): void
  showModelEditor(
    choice: ModelChoice,
    settings: ModelSettings,
    onSelect: (model: string, settings: ModelSettings, done: boolean) => void,
    onCancel: () => void,
  ): void
  showModelSelector(
    models: ModelBrowserItem[],
    currentModelId: string | undefined,
    onSelect: (model: ModelBrowserItem) => void,
    onCancel: () => void,
  ): void
  showSelectList(title: string, items: SelectListChoice[], onSelect: (value: string) => void, onCancel: () => void): void
  showPermissions(
    grants: PermissionGrantSummary[],
    onRemove: (grant: PermissionGrantSummary) => void,
    onClearAll: () => void,
    onCancel: () => void,
  ): void
  showPlanActions(planPath: string, onSelect: (action: PlanAction) => void): void
  showSettings(prefs: FurnacePreferences, onSave: (prefs: FurnacePreferences) => void): void
  showApiKeySetup(provider: string, label: string, onSave: (key: string) => void, onCancel: () => void): void
  showProviderSelector(
    rows: ProviderDisplayRow[],
    onSelect: (providerId: string) => void,
    onCancel: () => void,
    onDelete?: (providerId: string) => void,
  ): void
  setModel(model: string, settings: ModelSettings, displayName?: string): void
  setTheme(theme: string): void
  setTitle(title: string): void
  setToolActivities(activities: ToolActivity[]): void
  clearTranscriptDisplay(): void
  setStreamingContent(text: string): void
  setStatusNotice(content?: string, tone?: StatusNoticeTone): void
  setTranscript(transcript: TranscriptMessage[]): void
  suspendForEditor(draft: string): Promise<string>
  insertImageAttachment(source: ImageSource, options?: { displayName?: string; size?: number }): void
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

export type ModelBrowserItem = ModelChoice & {
  providerId: string
  providerLabel: string
}

export type SelectListChoice = {
  description?: string
  label: string
  value: string
}

export type ToolActivity = {
  args: string
  id: string
  name: string
  narrationBefore?: string
  result?: string
  status: "running" | "done" | "failed"
}

export type ContextUsage = {
  limit?: number | null
  tokens: number
}

export type QueuedPrompt = {
  createdAt: number
  hidden?: boolean
  id: string
  images?: ImageAttachment[]
  source?: string
  text: string
}

export type PlanAction = "execute" | "refine" | "stay"

export type ProviderDisplayRow = {
  canDelete: boolean
  id: string
  displayName: string
  sourceLabel: string
  status: "configured" | "unconfigured" | "active"
  protocol: string
}
