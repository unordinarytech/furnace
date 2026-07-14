import type { FurnaceTerminal, ToolActivity } from "./ui/terminal-types.js"
import { liveStreamingPreview } from "./ui/streaming.js"
import type { PermissionDecision, PermissionRequest } from "./permissions.js"
import type { AskQuestionRequest, AskQuestionResponse } from "./questions.js"

export type SessionRuntimeUi = {
  streamingContent: string
  thinking: boolean
  thinkingMessage: string
  toolActivities: ToolActivity[]
}

export function runtimeUiFor(store: Map<string, SessionRuntimeUi>, id: string): SessionRuntimeUi {
  let state = store.get(id)
  if (!state) {
    state = { streamingContent: "", thinking: false, thinkingMessage: "Thinking", toolActivities: [] }
    store.set(id, state)
  }
  return state
}

export function createSessionTerminalBridge(input: {
  base: FurnaceTerminal
  isVisible(): boolean
  pendingApprovals: Map<string, { request: PermissionRequest; resolve: (decision: PermissionDecision) => void }>
  pendingPlanActions: Map<string, { onSelect: (action: "execute" | "refine" | "stay") => void; planPath: string }>
  pendingQuestions: Map<string, { request: AskQuestionRequest; resolve: (response: AskQuestionResponse) => void }>
  runtimeUi: Map<string, SessionRuntimeUi>
  targetSessionId: string
}): FurnaceTerminal {
  const visible = input.isVisible
  const terminal = input.base
  const targetSessionId = input.targetSessionId
  return {
    ...terminal,
    clearInteractionPrompts() {
      input.pendingApprovals.delete(targetSessionId)
      input.pendingQuestions.delete(targetSessionId)
      input.pendingPlanActions.delete(targetSessionId)
      if (visible()) terminal.clearInteractionPrompts()
    },
    clearToolActivities() {
      runtimeUiFor(input.runtimeUi, targetSessionId).toolActivities = []
      if (visible()) terminal.clearToolActivities()
    },
    clearPlanActions() {
      input.pendingPlanActions.delete(targetSessionId)
      if (visible()) terminal.clearPlanActions()
    },
    requestApproval(request) {
      return new Promise<PermissionDecision>((resolve) => {
        const wrappedResolve = (decision: PermissionDecision): void => {
          input.pendingApprovals.delete(targetSessionId)
          resolve(decision)
        }
        input.pendingApprovals.set(targetSessionId, { request, resolve: wrappedResolve })
        if (visible()) terminal.showApprovalPrompt(request, wrappedResolve)
      })
    },
    requestQuestions(request) {
      return new Promise<AskQuestionResponse>((resolve) => {
        const wrappedResolve = (response: AskQuestionResponse): void => {
          input.pendingQuestions.delete(targetSessionId)
          resolve(response)
        }
        input.pendingQuestions.set(targetSessionId, { request, resolve: wrappedResolve })
        if (visible()) terminal.showQuestionPrompt(request, wrappedResolve)
      })
    },
    showApprovalPrompt(request, resolve) {
      const wrappedResolve = (decision: PermissionDecision): void => {
        input.pendingApprovals.delete(targetSessionId)
        resolve(decision)
      }
      input.pendingApprovals.set(targetSessionId, { request, resolve: wrappedResolve })
      if (visible()) terminal.showApprovalPrompt(request, wrappedResolve)
    },
    showQuestionPrompt(request, resolve) {
      const wrappedResolve = (response: AskQuestionResponse): void => {
        input.pendingQuestions.delete(targetSessionId)
        resolve(response)
      }
      input.pendingQuestions.set(targetSessionId, { request, resolve: wrappedResolve })
      if (visible()) terminal.showQuestionPrompt(request, wrappedResolve)
    },
    setBusy(busy) { if (visible()) terminal.setBusy(busy) },
    setContextUsage(tokens, window) { if (visible()) terminal.setContextUsage(tokens, window) },
    setCostUsage(costUsd) { if (visible()) terminal.setCostUsage(costUsd) },
    setMode(mode, planPath) { if (visible()) terminal.setMode(mode, planPath) },
    setSessionMeta(meta) { if (visible()) terminal.setSessionMeta(meta) },
    setStreamingContent(text) {
      runtimeUiFor(input.runtimeUi, targetSessionId).streamingContent = liveStreamingPreview(text)
      if (visible()) terminal.setStreamingContent(text)
    },
    setThinking(thinking, message = "Thinking") {
      const runtimeUi = runtimeUiFor(input.runtimeUi, targetSessionId)
      runtimeUi.thinking = thinking
      runtimeUi.thinkingMessage = message
      if (visible()) terminal.setThinking(thinking, message)
    },
    setTitle(title) { if (visible()) terminal.setTitle(title) },
    setToolActivities(activities) {
      runtimeUiFor(input.runtimeUi, targetSessionId).toolActivities = activities
      if (visible()) terminal.setToolActivities(activities)
    },
    setTranscript(transcript) {
      const runtimeUi = runtimeUiFor(input.runtimeUi, targetSessionId)
      runtimeUi.streamingContent = ""
      runtimeUi.toolActivities = []
      if (visible()) terminal.setTranscript(transcript)
    },
    showPlanActions(planPath, onSelect) {
      const wrappedSelect = (action: "execute" | "refine" | "stay"): void => {
        input.pendingPlanActions.delete(targetSessionId)
        onSelect(action)
      }
      input.pendingPlanActions.set(targetSessionId, { onSelect: wrappedSelect, planPath })
      if (visible()) terminal.showPlanActions(planPath, wrappedSelect)
    },
  }
}
