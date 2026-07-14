import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import readline from "node:readline"
import { runAgentTurn } from "./agent/loop.js"
import { applyHeadroomLiteRequestTransforms } from "./compression/request-transform.js"
import { argumentScopeFor, isHistoryCommand, isKnownSlashCommand, parseSlashCommand } from "./commands.js"
import { isApiKeyMissing, loadConfig } from "./config.js"
import { calculateUsageCostUsd, summarizeUsageCosts } from "./usage/cost.js"
import { LofiPlayer } from "./lofi.js"
import { listOpenRouterModels, type OpenRouterMessage, type OpenRouterModel, type OpenRouterToolDefinition } from "./openrouter.js"
import { setStoredKey, removeStoredKey } from "./keys.js"
import { BUILTIN_PROVIDERS, resolveProvider } from "./providers/registry.js"
import { loadCustomProviders } from "./providers/custom.js"
import { createModelListCache, type ProviderModel } from "./providers/catalog.js"
import { activateProvider, resolveProviderKey } from "./providers/resolution.js"
import type { CustomProvider, ProviderDefinition } from "./providers/types.js"
import { SessionPermissionStore, type PermissionGrantSummary } from "./permissions.js"
import type { PermissionDecision, PermissionRequest } from "./permissions.js"
import { appendPlanModeGuidance, currentPlanModeState, renderPlanExecutionPrompt, renderVisiblePlanArtifact, transitionPlanMode, type AgentMode, type PlanModeEntryData } from "./plan-mode.js"
import { saveGlobalPreferences, saveModelPreferences, saveThemePreference, statusLinePreferencesFrom, type FurnacePreferences, type ModelSettings } from "./preferences.js"
import { compactSessionIfNeeded, estimateRequestTokens, resolveCompactionSettings, type CompactionReason } from "./session/compaction.js"
import { entriesToModelMessages, entriesToTranscript } from "./session/context.js"
import { resolveForkEntryId } from "./session/navigation.js"
import { fallbackTitle, generateSessionTitle } from "./session/title.js"
import type { SessionStore } from "./session/store.js"
import type { MessageEntryData, SessionRecord } from "./session/types.js"
import { loadCustomCommands, renderCustomCommandTemplate } from "./custom-commands/loader.js"
import type { CustomCommand } from "./custom-commands/types.js"
import { PromptQueueStore, type PromptQueueInput } from "./prompt-queue.js"
import { generateRepoIndex, shouldOfferRepoIndex } from "./repo-index.js"
import { appendSkillGuidance, renderSkillInvocationMessage } from "./skills/context.js"
import { loadSkillByName, loadSkills } from "./skills/loader.js"
import type { Skill } from "./skills/types.js"
import { isSkillCommand, slashAutocompleteItems } from "./slash-command-router.js"
import { TaskManager, makeTaskId, type TaskManagerOptions } from "./tasks/manager.js"
import type { TaskRecord } from "./tasks/types.js"
import { createSessionTerminalBridge, runtimeUiFor, type SessionRuntimeUi } from "./task-ui-bridge.js"
import { childToolDefinitions, toolDefinitions } from "./tools/registry.js"
import type { FurnaceTerminal, PromptAutocompleteItem, PromptAutocompleteMatch, QueuedPrompt, ToolActivity } from "./ui/terminal-types.js"
import type { EvolveOutcome } from "./evolve/types.js"
import type { ImageAttachment } from "./utils/images.js"
import type { AskQuestionRequest, AskQuestionResponse } from "./questions.js"
import { findTheme, resolveTheme, themeChoices } from "./ui/terminal-themes/index.js"
import {
  renderAssistantStart,
  renderConversation,
  renderDone,
} from "./ui/terminal.js"
import { packageName, packageVersion } from "./version.js"

export async function runInteractive(input: {
  config: Awaited<ReturnType<typeof loadConfig>>
  cwd: string
  sessionId: string
  store: SessionStore
  shouldClear: boolean
}): Promise<void> {
  if (input.shouldClear) clearTerminalViewportAndScrollback()
  let sessionId = input.sessionId
  const permissions = new SessionPermissionStore()
  const lofi = new LofiPlayer()
  const pendingBackgroundRecords = new Map<string, TaskRecord[]>()
  const promptQueues = new PromptQueueStore()
  const pendingBackgroundPrompts = new Map<string, string[]>()
  let modelListCache = createModelListCache(input.config)
  let skillCatalog = await loadSkills(input.cwd, { extraPaths: input.config.skillPaths })
  let customCommands: CustomCommand[] = await loadCustomCommands(input.cwd)
  let baseAutocompleteItems: PromptAutocompleteItem[] = []
  let currentAutocompleteScope: ReturnType<typeof argumentScopeFor> | undefined
  let previewedTheme: string | undefined
  const runningSessionIds = new Set<string>()
  let activeDisplaySessionId = sessionId
  const activeAbortControllers = new Map<string, AbortController>()
  const unreadCompletedSessionIds = new Set<string>()
  const pendingApprovals = new Map<string, { request: PermissionRequest; resolve: (decision: PermissionDecision) => void }>()
  const pendingQuestions = new Map<string, { request: AskQuestionRequest; resolve: (response: AskQuestionResponse) => void }>()
  const pendingPlanActions = new Map<string, { onSelect: (action: "execute" | "refine" | "stay") => void; planPath: string }>()
  const sessionRuntimeUi = new Map<string, SessionRuntimeUi>()
  let transientStatusTimer: ReturnType<typeof setTimeout> | undefined
  let transientStatusToken = 0
  let persistentUpgradeNotice: string | undefined
  let repoIndexOnboardingRunning = false
  const initialSession = input.store.getSession(sessionId)
  let terminal!: FurnaceTerminal
  const isCurrentSessionRunning = (): boolean => repoIndexOnboardingRunning || runningSessionIds.has(sessionId)
  const isSessionRunning = (id: string): boolean => runningSessionIds.has(id)
  const currentAbortController = (): AbortController | undefined => activeAbortControllers.get(sessionId)
  const taskManager = createSubagentTaskManager({
    cwd: input.cwd,
    executeChildTask: (record, signal, manager) => runSubagentTask({ config: input.config, cwd: input.cwd, permissions, record, signal, store: input.store, taskManager: manager, terminal: terminalForSession(record.parentSessionId) }),
    onGroupComplete: ({ backgrounded, parentSessionId, records }) => {
      if (!backgrounded) return
      const pendingRecords = [...(pendingBackgroundRecords.get(parentSessionId) || []), ...records]
      pendingBackgroundRecords.set(parentSessionId, pendingRecords)
      if (hasActiveSubagentTasks(taskManager.status(parentSessionId).tasks)) return
      pendingBackgroundRecords.delete(parentSessionId)
      const prompt = formatBackgroundTaskCompletion(pendingRecords)
      if (parentSessionId === activeDisplaySessionId) {
        void enqueueOrRunSyntheticPrompt(prompt)
        return
      }
      const pending = pendingBackgroundPrompts.get(parentSessionId) || []
      pending.push(prompt)
      pendingBackgroundPrompts.set(parentSessionId, pending)
    },
    permissions,
    store: input.store,
  })
  const { createFurnaceTerminal } = await import("./ui/pi-terminal.js")
  terminal = createFurnaceTerminal({
    cwd: input.cwd,
    layout: input.config.layout,
    statusLine: input.config.statusLine,
    model: input.config.model,
    modelSettings: input.config.modelSettings,
    onQueueEdit: (id) => {
      removeQueuedPrompt(id)
    },
    onQueuePromote: (id) => {
      promoteQueuedPrompt(id)
    },
    onQueueRemove: (id) => {
      removeQueuedPrompt(id)
    },
    onInterrupt: () => {
      currentAbortController()?.abort()
    },
    onTaskBackground: () => {
      const promoted = taskManager.promoteActiveGroup(sessionId)
      showTransientStatus(promoted ? "Subagents moved to background. Furnace will continue once the task tool returns." : "No active foreground subagents to background.")
    },
    onModeCycle: (direction) => {
      if (isCurrentSessionRunning()) {
        showTransientStatus("Mode switching is available after the current turn finishes.")
        return
      }
      const current = currentPlanModeState(input.store.getActivePath(sessionId)).mode
      void switchMode(current === "plan" ? "agent" : "plan", { reason: "user", seed: direction > 0 ? "plan" : "agent" }).catch((error) => showTransientStatus(formatError(error)))
    },
    onInputChange: (value) => {
      if (isCurrentSessionRunning()) return
      const scope = argumentScopeFor(value)
      if (!scope) {
        if (currentAutocompleteScope !== undefined) {
          if (currentAutocompleteScope === "theme" && previewedTheme && previewedTheme !== input.config.theme) terminal.setTheme(input.config.theme)
          previewedTheme = undefined
          currentAutocompleteScope = undefined
          terminal.setSlashCommandItems(baseAutocompleteItems)
        }
        return
      }
      if (currentAutocompleteScope === scope) return
      if (currentAutocompleteScope === "theme" && previewedTheme && previewedTheme !== input.config.theme) terminal.setTheme(input.config.theme)
      previewedTheme = undefined
      currentAutocompleteScope = scope
      if (scope === "theme") {
        terminal.setSlashCommandItems(themeAutocompleteItems())
      } else if (scope === "history") {
        terminal.setSlashCommandItems(resumeAutocompleteItems(input.store.listHistorySessions(input.cwd)))
      } else if (scope === "fork") {
        terminal.setSlashCommandItems(forkAutocompleteItems())
      } else {
        void modelListCache.promise.then((models) => {
          if (currentAutocompleteScope === "model") terminal.setSlashCommandItems(modelAutocompleteItems(models))
        })
      }
    },
    onAutocompleteTab: (match) => {
      if (!match.value.startsWith("/model ") || !modelListCache.settled) return false
      const modelId = match.value.slice("/model ".length).trim()
      void modelListCache.promise.then((models) => {
        const candidates = models.filter((entry) => entry.id === modelId)
        const choice = candidates.find((entry) => entry.providerId === input.config.provider) || candidates[0]
        if (!choice) return
        terminal.showModelEditor(
          choice,
          choice.id === input.config.model ? input.config.modelSettings : {},
          (_model, settings, done) => {
            void applyModelSelection(choice, settings, { persist: done, refresh: done })
          },
          () => refreshCurrentSession(),
        )
      })
      return true
    },

    onAutocompleteHover: (match) => {
      if (currentAutocompleteScope !== "theme") return
      const value = match?.value || ""
      const themeName = value.startsWith("/theme ") ? value.slice("/theme ".length).trim() : ""
      const choice = themeName ? findTheme(themeName) : undefined
      if (!choice || previewedTheme === choice.name) return
      previewedTheme = choice.name
      terminal.setTheme(choice.name)
    },
    onOpenEditor: (draft) => {
      if (isCurrentSessionRunning()) {
        showTransientStatus("Editor is available after the current turn finishes.")
        return Promise.resolve(draft)
      }
      return terminal.suspendForEditor(draft)
    },
    onCopy: () => {
      const activePath = input.store.getActivePath(sessionId)
      const lastAssistant = [...activePath].reverse().find((entry) => entry.type === "message" && entry.role === "assistant")
      if (!lastAssistant) {
        showTransientStatus("Nothing to copy yet.")
        return
      }
      const content = (lastAssistant.data as { content: string }).content
      copyToClipboard(content)
      showTransientStatus("Copied to clipboard.")
    },
    themeName: input.config.theme,
    typingIndicatorBlink: input.config.typingIndicatorBlink,
    typingIndicator: input.config.typingIndicator,
    title: initialSession.title,
    onSubmit: (prompt, images) => {
      const submittedSessionId = sessionId
      void handleInteractiveSubmit(prompt, images).catch((error) => {
        runningSessionIds.delete(submittedSessionId)
        activeAbortControllers.delete(submittedSessionId)
        if (activeDisplaySessionId === submittedSessionId) terminal.setBusy(false)
        process.stdout.write("\x07")
        if (activeDisplaySessionId === submittedSessionId) {
          terminal.setThinking(false)
          terminal.setTranscript([...entriesToTranscript(input.store.getActivePath(submittedSessionId)), { role: "assistant", content: formatError(error) }])
        }
      })
    },
  })
  applyBaseAutocompleteItems(slashAutocompleteItems(skillCatalog.skills, customCommands))
  syncPersistentStatusNotice()
  syncModelDisplayFromCache()
  void maybeRunRepoIndexOnboarding().catch((error) => {
    showTransientStatus(`Repo indexing failed: ${formatError(error)}`, 6000)
  })

  // Non-blocking startup update check — shown persistently until the session ends
  void checkForUpdate().then((notice) => {
    if (notice) {
      persistentUpgradeNotice = notice
      syncPersistentStatusNotice()
    }
  })

  refreshCurrentSession()
  try {
    await terminal.run()
  } finally {
    clearTransientStatus()
    lofi.stop()
  }

  async function handleInteractiveSubmit(prompt: string, images?: ImageAttachment[]): Promise<void> {
    const command = parseSlashCommand(prompt)

    // Bare messages (non-slash) need an API key. Slash commands always pass through.
    if (!command.name.startsWith("/") && isApiKeyMissing(input.config)) {
      showTransientStatus("No API key configured. Use /login to set one.")
      return
    }
    if (command.name === "/exit" || command.name === "/quit") {
      currentAbortController()?.abort()
      lofi.stop()
      terminal.stop()
      return
    }
    if (command.name === "/lofi") {
      const result = lofi.toggle()
      terminal.setLofi(result.enabled)
      showTransientStatus(result.message)
      return
    }
    if (command.name === "/evolve") {
      if (isCurrentSessionRunning()) {
        showTransientStatus("/evolve is available after the current turn finishes.")
        return
      }
      await handleEvolveCommand(command.argument)
      return
    }
    if (command.name === "/reset") {
      if (isCurrentSessionRunning()) {
        showTransientStatus("/reset is available after the current turn finishes.")
        return
      }
      await handleResetCommand()
      return
    }
    if (command.name === "/clear") {
      terminal.clearTranscriptDisplay()
      return
    }
    if (command.name === "/image") {
      await handleImageCommand(command.argument)
      return
    }
    if (isSkillCommand(command.name)) {
      if (isCurrentSessionRunning()) {
        showTransientStatus(`${command.name} is available after the current turn finishes.`)
        return
      }
      await runSkillCommand(command.name, command.argument)
      return
    }
    if (isCurrentSessionRunning() && prompt.startsWith("/")) {
      if (command.name === "/tasks") {
        showTaskStatus()
        return
      }
      if (command.name === "/skills") {
        await handleSkillsCommand(command.argument)
        return
      }
      if (command.name === "/compact") {
        showTransientStatus("/compact is available after the current turn finishes.")
        return
      }
      if (command.name === "/init") {
        showTransientStatus("/init is available after the current turn finishes.")
        return
      }
      if (command.name === "/fork" || command.name === "/clone") {
        showTransientStatus(`${command.name} is available after the current turn finishes.`)
        return
      }
      if (command.name === "/plan" || command.name === "/agent" || command.name === "/mode") {
        showTransientStatus(`${command.name} is available after the current turn finishes.`)
        return
      }
      if (command.name === "/permissions") {
        openPermissionsPanel()
        return
      }
      if (command.name === "/theme" && command.argument) {
        await setThemeByName(command.argument)
        return
      }
      showTransientStatus(isKnownSlashCommand(command.name) ? `${command.name} is available after the current turn finishes.` : `Unknown command while Furnace is working: ${command.name}`)
      return
    }
    if (isCurrentSessionRunning()) {
      enqueuePrompt(prompt)
      return
    }
    if (command.name === "/plan") {
      await switchMode("plan", { reason: "user", seed: command.argument || "plan" })
      if (command.argument) await runPromptQueue(command.argument)
      return
    }
    if (command.name === "/agent") {
      await switchMode("agent", { reason: "user" })
      return
    }
    if (command.name === "/mode") {
      await handleModeCommand(command.argument)
      return
    }
    if (command.name === "/new") {
      clearTransientStatus()
      const session = input.store.getSession(sessionId)
      const next = session.activeLeafId ? input.store.createSession({ cwd: input.cwd, title: "New Chat" }) : session
      activateSession(next.id)
      return
    }
    if (command.name === "/permissions") {
      openPermissionsPanel()
      return
    }
    if (command.name === "/login") {
      await openLoginPanel()
      return
    }
    if (command.name === "/init") {
      await runRepoIndexInitialization({ manual: true })
      return
    }
    if (command.name === "/settings" || command.name === "/prefs") {
      const currentPrefs: FurnacePreferences = {
        layout: input.config.layout,
        typingIndicator: input.config.typingIndicator,
        typingIndicatorBlink: input.config.typingIndicatorBlink,
        notifications: input.config.notifications,
        model: input.config.model,
        theme: input.config.theme,
        modelSettings: input.config.modelSettings,
        ...input.config.statusLine,
      }
      terminal.showSettings(currentPrefs, async (updated) => {
        Object.assign(input.config, {
          layout: updated.layout ?? input.config.layout,
          typingIndicator: updated.typingIndicator ?? input.config.typingIndicator,
          typingIndicatorBlink: updated.typingIndicatorBlink === true,
          notifications: updated.notifications === true,
          statusLine: statusLinePreferencesFrom(updated),
        })
        terminal.setLayout(input.config.layout)
        terminal.setStatusLinePreferences(input.config.statusLine)
        try {
          await saveGlobalPreferences(updated)
          showTransientStatus("Settings saved globally.", 1800)
        } catch (error) {
          showTransientStatus(`Failed to save settings: ${formatError(error)}`, 8000)
        }
      })
      return
    }
    if (isHistoryCommand(command.name)) {
      if (command.argument) {
        resumeSessionByToken(command.argument)
        return
      }
      showHistoryHint()
      return
    }
    if (command.name === "/tasks") {
      showTaskStatus()
      return
    }
    if (command.name === "/skills") {
      await handleSkillsCommand(command.argument)
      return
    }
    if (command.name === "/compact") {
      await compactCurrentSession(command.argument)
      return
    }
    if (command.name === "/fork") {
      await handleForkCommand(command.argument)
      return
    }
    if (command.name === "/clone") {
      await handleForkCommand("current")
      return
    }
    if (command.name === "/model") {
      if (command.argument) {
        await setModelByArgument(command.argument)
        return
      }
      const models = await modelListCache.promise.catch(() => [] as ProviderModel[])
      if (models.length === 0) {
        showTransientStatus("No models available. Use /login to add a provider key.")
        return
      }
      openModelPicker(models, () => {})
      return
    }
    if (command.name === "/models") {
      await openModelBrowser()
      return
    }
    if (command.name === "/theme") {
      if (command.argument) {
        await setThemeByName(command.argument)
        return
      }
      showTransientStatus(`Current theme: ${resolveTheme(input.config.theme).name}. Type /theme <name> to change.`)
      return
    }
    if (command.name === "/status") {
      showStatusSummary()
      return
    }
    if (command.name === "/export") {
      await exportConversation(command.argument)
      return
    }
    if (command.name === "/diff") {
      await showSessionDiff()
      return
    }
    if (command.name === "/undo") {
      await undoLastFileChange()
      return
    }
    if (command.name === "/copy") {
      const activePath = input.store.getActivePath(sessionId)
      const lastAssistant = [...activePath].reverse().find((entry) => entry.type === "message" && entry.role === "assistant")
      if (!lastAssistant) { showTransientStatus("Nothing to copy yet."); return }
      const content = (lastAssistant.data as { content: string }).content
      copyToClipboard(content)
      showTransientStatus("Copied to clipboard.")
      return
    }
    if (command.name === "/cost") {
      await showCostSummary()
      return
    }
    if (command.name === "/editor") {
      if (isCurrentSessionRunning()) { showTransientStatus("Editor is available after the current turn finishes."); return }
      const current = ""
      const result = await terminal.suspendForEditor(current)
      if (result.trim()) await runPromptQueue(result.trim())
      return
    }
    if (command.name === "/bug") {
      const title = command.argument.trim()
      const url = `https://github.com/amoreX/furnace/issues/new${title ? `?title=${encodeURIComponent(title)}` : ""}`
      const opener = process.platform === "darwin" ? "open" : "xdg-open"
      const result = spawnSync(opener, [url])
      if (result.status !== 0) showTransientStatus(`File a bug at: ${url}`, 8000)
      else showTransientStatus("Opening browser for bug report.")
      return
    }

    // Custom user-defined slash commands
    const customCmd = customCommands.find((c) => `/${c.name}` === command.name)
    if (customCmd) {
      if (isCurrentSessionRunning()) {
        showTransientStatus(`/${customCmd.name} is available after the current turn finishes.`)
        return
      }
      clearTransientStatus()
      const rendered = renderCustomCommandTemplate(customCmd.template, command.argument)
      await runPromptQueue({ hidden: true, source: "custom_command", text: rendered })
      return
    }

    clearTransientStatus()
    await runPromptQueue(prompt, images)
  }

  function showTransientStatus(content: string, ttlMs = 3000): void {
    clearTransientStatus()
    const token = ++transientStatusToken
    terminal.setStatusNotice(content)
    transientStatusTimer = setTimeout(() => {
      if (token !== transientStatusToken) return
      transientStatusTimer = undefined
      syncPersistentStatusNotice()
    }, ttlMs)
    transientStatusTimer.unref?.()
  }

  async function handleEvolveCommand(argument: string): Promise<void> {
    const request = argument.trim()
    const { resolveFurnaceRoot } = await import("./evolve/root.js")
    const rootResult = resolveFurnaceRoot()
    if (!rootResult.available) {
      showTransientStatus(rootResult.message, 8000)
      return
    }
    if (!request) {
      terminal.setInputDraft("/evolve ")
      showTransientStatus("Describe what to change in furnace, e.g. /evolve add cost to the statusline.", 6000)
      return
    }

    const { runEvolve } = await import("./evolve/orchestrator.js")
    const evolveSession = input.store.createSession({ cwd: rootResult.root, relationType: "subagent", title: `evolve: ${request}` })
    // Broad session grant for the evolve edit turn (KTD9 — permissions are
    // session-scoped, not path-scoped; the content-level diff review is the control).
    permissions.applyDecision(
      { args: "", callId: "evolve", cwd: rootResult.root, description: "evolve", pattern: "*", permission: "*", sessionId: evolveSession.id, toolName: "*" },
      "allow_all_session",
    )

    terminal.setInputDisabled(true)
    try {
      const outcome = await runEvolve({
        request,
        rootResult,
        interaction: {
          notify: (message) => showTransientStatus(message, 12000),
          confirmApply: async ({ diff, createdFiles, verifyLog }) => {
            const response = await terminal.requestQuestions({
              questions: [
                {
                  id: "apply",
                  allowCustom: false,
                  allowMultiple: false,
                  prompt: renderEvolveConsentPrompt(diff, createdFiles, verifyLog),
                  options: [
                    { id: "apply", label: "Apply and prompt restart" },
                    { id: "discard", label: "Discard the change (revert)" },
                  ],
                },
              ],
            })
            if (response.rejected) return false
            return response.answers.some((answer) => answer.optionId === "apply")
          },
          runEditTurn: async ({ root, request: editRequest }) => {
            await runSingleTurn({
              config: input.config,
              cwd: root,
              prompt: renderEvolveEditPrompt(editRequest, root),
              sessionId: evolveSession.id,
              store: input.store,
              permissions,
              terminal,
              hiddenUserMessage: true,
              hiddenUserMessageSource: "evolve",
            })
          },
        },
      })
      // Surface the outcome durably in the user's conversation (the edit ran in a
      // hidden session, so its result would otherwise vanish on refresh).
      input.store.appendMessage(sessionId, "assistant", renderEvolveOutcomeMessage(request, outcome), input.config.model)
    } catch (error) {
      input.store.appendMessage(sessionId, "assistant", `Evolve failed: ${formatError(error)}`, input.config.model)
    } finally {
      terminal.setThinking(false)
      terminal.setBusy(false)
      terminal.setInputDisabled(false)
      refreshCurrentSession()
    }
  }

  async function handleResetCommand(): Promise<void> {
    const { resolveFurnaceRoot } = await import("./evolve/root.js")
    const rootResult = resolveFurnaceRoot()
    if (!rootResult.available) {
      showTransientStatus(rootResult.message, 8000)
      return
    }
    const { pointsForRoot, resetToBaseline } = await import("./evolve/recovery.js")
    const points = pointsForRoot(rootResult.root)
    if (points.length === 0) {
      showTransientStatus("No evolve changes recorded — furnace is already at its default state.", 6000)
      return
    }

    const undoing = points.map((point) => `• ${point.description}`).join("\n")
    const created = [...new Set(points.flatMap((point) => point.createdFiles))]
    const createdNote = created.length > 0 ? `\n\nFiles that will be removed:\n${created.map((path) => `• ${path}`).join("\n")}` : ""
    const response = await terminal.requestQuestions({
      questions: [
        {
          id: "reset",
          allowCustom: false,
          allowMultiple: false,
          prompt: `Reset furnace to its default state? This reverts the harness source to before your first evolve and discards these ${points.length} evolve change(s):\n\n${undoing}${createdNote}\n\nGit-committed work is kept.`,
          options: [
            { id: "reset", label: "Reset to default" },
            { id: "cancel", label: "Cancel" },
          ],
        },
      ],
    })
    if (response.rejected || !response.answers.some((answer) => answer.optionId === "reset")) {
      showTransientStatus("Reset cancelled.")
      return
    }

    terminal.setInputDisabled(true)
    try {
      const result = resetToBaseline(rootResult.root)
      if (result.ok) {
        showTransientStatus(`Reset furnace to default (undid ${result.undoneCount} evolve change(s)). Restart furnace to load the default harness.`, 12000)
      } else {
        showTransientStatus(`Reset failed: ${result.message}`, 8000)
      }
    } finally {
      terminal.setInputDisabled(false)
      refreshCurrentSession()
    }
  }

  function syncPersistentStatusNotice(): void {
    if (transientStatusTimer) return
    const notice = missingApiKeyNotice()
    if (notice) {
      terminal.setStatusNotice(notice, "warning")
      return
    }
    if (persistentUpgradeNotice) {
      terminal.setStatusNotice(persistentUpgradeNotice)
      return
    }
    terminal.setStatusNotice(undefined)
  }

  function missingApiKeyNotice(): string | undefined {
    if (!isApiKeyMissing(input.config)) return undefined
    return `No API key configured for ${input.config.providerConfig.displayName}. Type /login to save one to ~/.furnace/auth.json.`
  }

  async function maybeRunRepoIndexOnboarding(): Promise<void> {
    if (isApiKeyMissing(input.config)) return
    if (!(await shouldOfferRepoIndex(input.cwd))) return

    const response = await terminal.requestQuestions({
      questions: [
        {
          allowCustom: false,
          allowMultiple: false,
          allowRefuse: false,
          id: "repo_index",
          prompt: "Initialize Furnace for this git repo? Furnace will spend a little time learning the codebase and save a local `.furnace/repo-index.md` guide.",
          options: [
            { id: "yes", label: "Yes, learn this repo now" },
            { id: "no", label: "Not now" },
          ],
        },
      ],
    })
    const answer = response.answers.find((item) => item.questionId === "repo_index")
    if (response.rejected || answer?.optionId !== "yes") return

    await runRepoIndexInitialization({ manual: false })
  }

  async function runRepoIndexInitialization(options: { manual: boolean }): Promise<void> {
    if (isApiKeyMissing(input.config)) {
      showTransientStatus("No API key configured. Use /login first, then run /init.", 6000)
      return
    }

    repoIndexOnboardingRunning = true
    terminal.setBusy(true)
    terminal.setInputDisabled(true)
    terminal.setThinking(true, "Learning about repo")
    terminal.setStatusNotice(options.manual ? "Learning about this folder. This may take a little time." : "Learning about repo. This may take a little time.")
    try {
      const models = modelListCache.models || await modelListCache.promise.catch(() => [])
      await generateRepoIndex({ config: input.config, cwd: input.cwd, models })
      showTransientStatus("Repo index saved to .furnace/repo-index.md.", 6000)
    } finally {
      repoIndexOnboardingRunning = false
      terminal.setInputDisabled(false)
      terminal.setBusy(false)
      terminal.setThinking(false)
      syncPersistentStatusNotice()
    }
  }

  function refreshModelListCache(): void {
    modelListCache = createModelListCache(input.config)
    syncModelDisplayFromCache(modelListCache)
    if (currentAutocompleteScope === "model") {
      const cache = modelListCache
      void cache.promise.then((models) => {
        if (cache !== modelListCache || currentAutocompleteScope !== "model") return
        terminal.setSlashCommandItems(modelAutocompleteItems(models))
      }).catch(() => {})
    }
  }

  function syncModelDisplayFromCache(cache = modelListCache): void {
    void cache.promise.then((models) => {
      if (cache !== modelListCache) return
      const match = models.find((model) => model.id === input.config.model)
      terminal.setModel(input.config.model, input.config.modelSettings, match?.name)
      refreshCurrentSession()
    }).catch(() => {
      if (cache !== modelListCache) return
      terminal.setModel(input.config.model, input.config.modelSettings)
    })
  }

  async function openLoginPanel(): Promise<void> {
    const customProviders = await loadCustomProviders()
    const allProviders = [...BUILTIN_PROVIDERS, ...customProviders.map(({ apiKey: _, ...def }) => def)]
    const rows = []
    for (const def of allProviders) {
      const keyState = await resolveProviderKeyState(def, customProviders)
      rows.push({
        canDelete: keyState.hasSavedKey,
        id: def.id,
        displayName: def.displayName,
        sourceLabel: keyState.sourceLabel,
        status: def.id === input.config.provider ? "active" as const : keyState.apiKey ? "configured" as const : "unconfigured" as const,
        protocol: def.protocol,
      })
    }
    terminal.showProviderSelector(
      rows,
      (providerId) => showApiKeySetupForProvider(providerId, customProviders),
      () => syncPersistentStatusNotice(),
      (providerId) => { void deleteSavedKey(providerId, customProviders) },
    )
  }

  async function resolveProviderKeyState(def: ProviderDefinition, customProviders: Awaited<ReturnType<typeof loadCustomProviders>>): Promise<{ apiKey: string; hasSavedKey: boolean; sourceLabel: string }> {
    const state = await resolveProviderKey(def, customProviders)
    const sourceLabel = state.source === "environment"
      ? state.hasSavedKey ? "env + saved" : "env"
      : state.source === "saved"
        ? "saved"
        : state.source === "custom"
          ? "custom"
          : state.hasSavedKey
            ? "saved unresolved"
            : state.hasCustomKey
              ? "custom unresolved"
              : "not configured"
    return { apiKey: state.apiKey, hasSavedKey: state.hasSavedKey, sourceLabel }
  }

  function showApiKeySetupForProvider(providerId: string, customProviders: Awaited<ReturnType<typeof loadCustomProviders>>): void {
    const def = resolveProvider(providerId, customProviders)
    if (!def) return
    const label = def.displayName
    terminal.showApiKeySetup(
      providerId,
      label,
      async (key) => {
        const normalizedKey = key.trim()
        if (!normalizedKey) {
          showTransientStatus(`API key for ${label} cannot be empty.`, 6000)
          return
        }
        try {
          await setStoredKey(providerId, normalizedKey)
        } catch (error) {
          showTransientStatus(`Failed to save API key to ~/.furnace/auth.json: ${formatError(error)}`, 8000)
          return
        }
        activateProvider(input.config, def, normalizedKey)
        const newModel = def.defaultModel || def.models?.[0]?.id || input.config.model
        if (newModel !== input.config.model) {
          input.config.model = newModel
          input.config.modelSettings = {}
          terminal.setModel(newModel, {})
          refreshModelListCache()
          await saveGlobalPreferences({ provider: providerId, model: newModel, modelSettings: {} }).catch(() => {})
        } else {
          refreshModelListCache()
          await saveGlobalPreferences({ provider: providerId }).catch(() => {})
        }
        showTransientStatus(`Provider set to ${label}. API key saved. Use /model to pick a model.`, 4000)
      },
      () => { void openLoginPanel() },
    )
  }

  async function deleteSavedKey(providerId: string, customProviders: Awaited<ReturnType<typeof loadCustomProviders>>): Promise<void> {
    const def = resolveProvider(providerId, customProviders)
    if (!def) return
    let deleted = false
    try {
      deleted = await removeStoredKey(providerId)
    } catch (error) {
      showTransientStatus(`Failed to delete saved ${def.displayName} key: ${formatError(error)}`, 8000)
      return
    }
    if (!deleted) {
      showTransientStatus(`No saved ${def.displayName} key in ~/.furnace/auth.json. Remove env/custom keys from their source.`, 6000)
      await openLoginPanel()
      return
    }
    if (providerId === input.config.provider) {
      const next = await resolveProviderKeyState(def, customProviders)
      activateProvider(input.config, def, next.apiKey)
      refreshModelListCache()
    }
    showTransientStatus(`Deleted saved ${def.displayName} key from ~/.furnace/auth.json.`, 4000)
    await openLoginPanel()
  }

  function openPermissionsPanel(): void {
    const onRemove = (grant: PermissionGrantSummary): void => {
      permissions.removeGrant(sessionId, grant)
      terminal.showPermissions(permissions.listSessionGrants(sessionId), onRemove, onClearAll, onClose)
    }
    const onClearAll = (): void => {
      const removed = permissions.clearSession(sessionId)
      showTransientStatus(removed > 0 ? `Reset ${removed} permission grant${removed === 1 ? "" : "s"} for this conversation.` : "No permission grants to reset for this conversation.")
      terminal.showPermissions(permissions.listSessionGrants(sessionId), onRemove, onClearAll, onClose)
    }
    const onClose = (): void => refreshCurrentSession()
    terminal.showPermissions(permissions.listSessionGrants(sessionId), onRemove, onClearAll, onClose)
  }

  function showTaskStatus(): void {
    const status = formatTaskStatusForUser(taskManager.status(sessionId).tasks)
    terminal.setTranscript([...entriesToTranscript(input.store.getActivePath(sessionId)), { role: "assistant", content: status }])
  }

  function applyBaseAutocompleteItems(items: PromptAutocompleteItem[]): void {
    baseAutocompleteItems = items
    if (currentAutocompleteScope === undefined) terminal.setSlashCommandItems(baseAutocompleteItems)
  }

  function themeAutocompleteItems(): PromptAutocompleteItem[] {
    return themeChoices.map((choice) => ({
      browsable: true,
      description: choice.description,
      label: choice.displayLabel,
      value: `/theme ${choice.name}`,
    }))
  }

  function modelAutocompleteItems(models: ProviderModel[]): PromptAutocompleteItem[] {
    return models.map((model) => ({
      browsable: true,
      description: [model.providerLabel, model.contextLength ? `${formatTokenCount(model.contextLength)} context` : undefined]
        .filter(Boolean)
        .join(" · "),
      label: model.name || model.id,
      value: `/model ${model.id}`,
    }))
  }

  function resumeAutocompleteItems(sessions: ReturnType<SessionStore["listSessions"]>): PromptAutocompleteItem[] {
    return sessions.map((session, index) => {
      const parentIndex = session.parentSessionId ? sessions.findIndex((candidate) => candidate.id === session.parentSessionId) : -1
      return {
        browsable: true,
        description:
          session.relationType === "fork" && session.parentSessionId
            ? `${formatRelativeTime(session.updatedAt)} · fork of ${sessionTitleById(input.store, session.parentSessionId)}`
            : formatRelativeTime(session.updatedAt),
        label: session.title,
        relatedValue: parentIndex >= 0 ? `/resume ${parentIndex + 1}` : undefined,
        value: `/resume ${index + 1}`,
      }
    })
  }

  function forkAutocompleteItems(): PromptAutocompleteItem[] {
    const current = input.store.getSession(sessionId)
    const points = input.store.listForkPoints(sessionId)
    const items: PromptAutocompleteItem[] = []
    if (hasConversationMessages(input.store.getActivePath(sessionId))) {
      items.push({
        browsable: true,
        description: "Fork through the current active leaf",
        label: `current · ${current.title}`,
        value: "/fork current",
      })
    }
    items.push(
      ...points.map(({ entry, forkCount }) => {
        const preview = firstLine((entry.data as { content: string }).content)
        return {
          browsable: true,
          description: `${formatRelativeTime(entry.createdAt)}${forkCount > 0 ? ` · ${forkCount} fork${forkCount === 1 ? "" : "s"}` : ""}`,
          label: preview,
          value: `/fork ${preview}`,
        }
      }),
    )
    return items
  }

  function showHistoryHint(): void {
    const sessions = input.store.listHistorySessions(input.cwd)
    if (sessions.length === 0) {
      showTransientStatus("No saved conversations yet.")
      return
    }
    showTransientStatus(`Type /resume <number> to switch, or type /resume and browse with the arrow keys.\n${formatHistoryOverview(input.store, input.cwd, sessions).join("\n")}`)
  }

  function resumeSessionByToken(argument: string): void {
    const sessions = input.store.listHistorySessions(input.cwd)
    const index = Number.parseInt(argument.trim(), 10)
    const target = Number.isInteger(index) ? sessions[index - 1] : undefined
    if (!target) {
      showTransientStatus(`Unknown conversation: ${argument}`)
      return
    }
    switchToSession(target.id)
  }

  function switchToSession(targetSessionId: string): void {
    activateSession(targetSessionId, { clearScreen: targetSessionId !== sessionId })
  }

  function activateSession(targetSessionId: string, options: { clearDraft?: boolean; clearScreen?: boolean } = {}): void {
    unreadCompletedSessionIds.delete(targetSessionId)
    sessionId = targetSessionId
    activeDisplaySessionId = targetSessionId
    if (options.clearScreen) process.stdout.write("\x1b[2J\x1b[H")
    if (options.clearDraft) terminal.setInputDraft("")
    terminal.clearTranscriptDisplay()
    refreshCurrentSession()
    syncQueuedPrompts()
    restoreSessionRuntimeUi(targetSessionId)
    restoreSessionInteractionState(targetSessionId)
    flushPendingBackgroundPrompts()
  }

  function restoreSessionRuntimeUi(targetSessionId: string): void {
    const runtimeUi = runtimeUiFor(sessionRuntimeUi, targetSessionId)
    terminal.setStreamingContent(runtimeUi.streamingContent)
    terminal.setToolActivities(runtimeUi.toolActivities)
    terminal.setThinking(runtimeUi.thinking || isSessionRunning(targetSessionId), runtimeUi.thinkingMessage || "Thinking")
    terminal.setBusy(isSessionRunning(targetSessionId))
  }

  function restoreSessionInteractionState(targetSessionId: string): void {
    terminal.clearInteractionPrompts()
    const approval = pendingApprovals.get(targetSessionId)
    if (approval) {
      terminal.showApprovalPrompt(approval.request, approval.resolve)
      return
    }
    const question = pendingQuestions.get(targetSessionId)
    if (question) {
      terminal.showQuestionPrompt(question.request, question.resolve)
      return
    }
    const planAction = pendingPlanActions.get(targetSessionId)
    if (planAction) terminal.showPlanActions(planAction.planPath, planAction.onSelect)
  }

  function terminalForSession(targetSessionId: string): FurnaceTerminal {
    return createSessionTerminalBridge({
      base: terminal,
      isVisible: () => activeDisplaySessionId === targetSessionId,
      pendingApprovals,
      pendingPlanActions,
      pendingQuestions,
      runtimeUi: sessionRuntimeUi,
      targetSessionId,
    })
  }

  /**
   * Apply a model choice, switching the active provider first when the model
   * belongs to a different (credentialed) provider.
   */
  async function applyModelSelection(match: ProviderModel, settings: ModelSettings, opts?: { global?: boolean; persist?: boolean; refresh?: boolean }): Promise<boolean> {
    const persist = opts?.persist ?? true
    const refresh = opts?.refresh ?? true
    if (match.providerId !== input.config.provider) {
      const customProviders = await loadCustomProviders().catch(() => [] as CustomProvider[])
      const def = resolveProvider(match.providerId, customProviders)
      if (!def) {
        showTransientStatus(`Unknown provider: ${match.providerId}`)
        return false
      }
      const apiKey = (await resolveProviderKey(def, customProviders)).apiKey
      if (!apiKey) {
        showTransientStatus(`No API key for ${def.displayName}. Use /login to add one.`)
        return false
      }
      activateProvider(input.config, def, apiKey)
      if (persist) await saveGlobalPreferences({ provider: def.id }).catch(() => {})
    }
    input.config.model = match.id
    input.config.modelSettings = settings
    terminal.setModel(match.id, settings, match.name)
    if (persist) {
      await (opts?.global
        ? saveGlobalPreferences({ model: match.id, modelSettings: settings })
        : saveModelPreferences(input.cwd, { model: match.id, modelSettings: settings })
      ).catch((error) => {
        terminal.setTranscript([{ role: "assistant", content: `Failed to save model preference: ${formatError(error)}` }])
      })
    }
    if (refresh) refreshCurrentSession()
    return true
  }

  async function setModelByArgument(argument: string): Promise<void> {
    const isGlobal = argument.trimStart().startsWith("--global ")
    const trimmed = (isGlobal ? argument.trimStart().slice("--global ".length) : argument).trim()
    const models = await modelListCache.promise
    const lowered = trimmed.toLowerCase()
    const candidates = [
      ...models.filter((model) => model.id.toLowerCase() === lowered),
      ...models.filter((model) => model.name.toLowerCase() === lowered),
    ]
    // Prefer the active provider when the same id exists in several catalogs.
    const match = candidates.find((model) => model.providerId === input.config.provider) || candidates[0]
    if (!match) {
      showTransientStatus(`Unknown model: ${trimmed}`)
      return
    }
    const applied = await applyModelSelection(match, {}, { global: isGlobal })
    if (applied && isGlobal) showTransientStatus(`Model set globally to ${match.name}.`)
  }

  /** /models: pick a provider, then fuzzy-search its models pi-style, then tune settings. */
  async function openModelBrowser(): Promise<void> {
    const models = await modelListCache.promise.catch(() => [] as ProviderModel[])
    const byProvider = new Map<string, ProviderModel[]>()
    for (const model of models) {
      const group = byProvider.get(model.providerId)
      if (group) group.push(model)
      else byProvider.set(model.providerId, [model])
    }
    if (byProvider.size === 0) {
      showTransientStatus("No providers with models available. Use /login to add a provider key.")
      return
    }
    const providerItems = [...byProvider.entries()].map(([providerId, group]) => ({
      value: providerId,
      label: group[0]?.providerLabel || providerId,
      description: `${group.length} model${group.length === 1 ? "" : "s"}${providerId === input.config.provider ? " · active" : ""}`,
    }))
    terminal.showSelectList("Select a provider", providerItems, (providerId) => {
      const group = byProvider.get(providerId) || []
      openModelPicker(group)
    }, () => {})
  }

  function openModelPicker(models: ProviderModel[], onCancel?: () => void): void {
    terminal.showModelSelector(
      models,
      input.config.model,
      (selected) => {
        const match = models.find((model) => model.id === selected.id && model.providerId === selected.providerId)
        if (!match) return
        terminal.showModelEditor(
          match,
          match.id === input.config.model ? input.config.modelSettings : {},
          (_model, settings, done) => {
            void applyModelSelection(match, settings, { persist: done, refresh: done })
          },
          () => {},
        )
      },
      // Esc from a provider's model list goes back to the provider list;
      // Esc from the all-models picker (/model) just closes.
      onCancel ?? (() => void openModelBrowser()),
    )
  }

  async function handleForkCommand(argument: string): Promise<void> {
    const activePath = input.store.getActivePath(sessionId)
    if (activePath.length === 0) {
      showTransientStatus("Nothing to fork yet.")
      return
    }
    const currentSession = input.store.getSession(sessionId)
    if (currentSession.relationType === "fork") {
      showTransientStatus("Forking from a fork is not supported yet. Resume the original conversation to create another level-one fork.", 8000)
      return
    }
    const trimmed = argument.trim()
    if (!trimmed) {
      if (input.store.listForkPoints(sessionId).length === 0) {
        showTransientStatus("No forkable prompts yet. Forking needs an earlier user prompt after at least one assistant response.", 8000)
        return
      }
      terminal.setInputDraft("/fork ")
      terminal.setSlashCommandItems(forkAutocompleteItems())
      showTransientStatus("Choose a fork point with arrow keys, then press Enter. Use /fork current to fork the tip.", 6000)
      return
    }
    const isCurrent = ["current", "tip", "head"].includes(trimmed.toLowerCase())
    const sourceEntryId = isCurrent ? undefined : resolveForkEntryId(input.store, sessionId, trimmed)
    if (!isCurrent && !sourceEntryId) {
      showTransientStatus(`Unknown fork point: ${trimmed}. Type /fork and pick a prompt.`)
      return
    }
    try {
      const result = input.store.forkSession({
        position: isCurrent ? "at" : "before",
        sourceEntryId,
        sourceSessionId: sessionId,
      })
      activateSession(result.forkedSession.id, { clearDraft: true })
      showTransientStatus(`Forked into ${result.forkedSession.title}.`, 6000)
    } catch (error) {
      showTransientStatus(formatError(error), 8000)
    }
  }

  async function setThemeByName(name: string): Promise<void> {
    const isGlobal = name.trimStart().startsWith("--global ")
    const themeName = (isGlobal ? name.trimStart().slice("--global ".length) : name).trim()
    const choice = findTheme(themeName)
    if (!choice) {
      terminal.setTranscript([{ role: "assistant", content: `Unknown theme: ${themeName}\nAvailable themes: ${themeChoices.map((theme) => theme.name).join(", ")}` }])
      return
    }
    input.config.theme = choice.name
    terminal.setTheme(choice.name)
    if (isGlobal) {
      await saveGlobalPreferences({ theme: choice.name })
      showTransientStatus(`Theme set globally to ${choice.name}.`)
    } else {
      await saveThemePreference(input.cwd, choice.name)
      showTransientStatus(`Theme set to ${choice.name}.`)
    }
  }

  async function handleModeCommand(argument: string): Promise<void> {
    const requested = argument.trim().toLowerCase()
    if (!requested) {
      const state = currentPlanModeState(input.store.getActivePath(sessionId))
      const detail = state.mode === "plan" && state.planPath ? ` (${state.planPath})` : ""
      showTransientStatus(`Current mode: ${state.mode}${detail}`)
      return
    }
    if (requested !== "agent" && requested !== "plan") {
      showTransientStatus("Usage: /mode [agent|plan]")
      return
    }
    await switchMode(requested, { reason: "user", seed: requested })
  }

  async function switchMode(mode: AgentMode, options: { reason: PlanModeEntryData["reason"]; seed?: string }): Promise<void> {
    clearTransientStatus()
    const state = transitionPlanMode({
      cwd: input.cwd,
      mode,
      reason: options.reason || "user",
      seed: options.seed,
      sessionId,
      store: input.store,
    })
    permissions.setSessionMode(sessionId, state.mode, state.planPath)
    terminal.setMode(state.mode, state.planPath)
    if (mode === "agent") terminal.clearPlanActions()
    showTransientStatus(state.mode === "plan" ? `Plan mode active. Plan artifact: ${state.planPath}` : "Agent mode active.")
  }

  async function handlePlanAction(action: "execute" | "refine" | "stay", planPath: string): Promise<void> {
    if (action === "stay") {
      terminal.clearPlanActions()
      terminal.setInputDraft("")
      return
    }
    if (action === "refine") {
      terminal.clearPlanActions()
      terminal.setInputDraft(`Refine the plan in ${planPath}: `)
      return
    }

    terminal.clearPlanActions()
    await switchMode("agent", { reason: "tool" })
    await runPromptQueue({
      hidden: true,
      source: "plan_execute",
      text: renderPlanExecutionPrompt(planPath),
    })
  }

  async function runSkillCommand(commandName: string, userInstruction: string): Promise<void> {
    const skillName = commandName.slice("/skill:".length)
    const skill = skillCatalog.skills.find((candidate) => candidate.name === skillName)
    if (!skill) {
      showTransientStatus(`Unknown skill: ${skillName}`)
      return
    }
    clearTransientStatus()
    await runPromptQueue({
      hidden: true,
      source: "skill_invocation",
      text: renderSkillInvocationMessage(skill, userInstruction),
    })
  }

  async function handleSkillsCommand(argument: string): Promise<void> {
    const [subcommand = "list", ...rest] = argument.trim().split(/\s+/).filter(Boolean)
    if (subcommand === "reload") {
      await reloadSkillCatalog()
      showTransientStatus(`Reloaded ${skillCatalog.skills.length} skill${skillCatalog.skills.length === 1 ? "" : "s"}.`)
      return
    }
    if (subcommand === "view") {
      const name = rest.join(" ").trim()
      terminal.setTranscript([...entriesToTranscript(input.store.getActivePath(sessionId)), { role: "assistant", content: formatSkillView(skillCatalog.skills, name) }])
      return
    }
    if (subcommand !== "list") {
      terminal.setTranscript([...entriesToTranscript(input.store.getActivePath(sessionId)), { role: "assistant", content: `Unknown /skills command: ${subcommand}\nUsage: /skills [list|view <name>|reload]` }])
      return
    }
    terminal.setTranscript([...entriesToTranscript(input.store.getActivePath(sessionId)), { role: "assistant", content: formatSkillsList(skillCatalog.skills) }])
  }

  async function reloadSkillCatalog(): Promise<void> {
    skillCatalog = await loadSkills(input.cwd, { extraPaths: input.config.skillPaths })
    customCommands = await loadCustomCommands(input.cwd)
    applyBaseAutocompleteItems(slashAutocompleteItems(skillCatalog.skills, customCommands))
  }

  async function handleImageCommand(argument: string): Promise<void> {
    if (!argument.trim()) {
      showTransientStatus("Usage: /image <path|url>")
      return
    }
    const { loadImageAsBase64, parseImageUrl } = await import("./utils/images.js")
    const path = argument.trim()

    // Check if it's a URL
    const url = parseImageUrl(path)
    if (url) {
      terminal.insertImageAttachment({ type: "url", url }, { displayName: path })
      showTransientStatus(`Added image from URL: ${path}`)
      return
    }

    // Try to load as local file
    const result = await loadImageAsBase64(path)
    if (!result.success) {
      showTransientStatus(`Error loading image: ${result.error}`)
      return
    }

    terminal.insertImageAttachment(result.source, { displayName: path, size: result.size })
    const sizeStr = result.size < 1024 ? `${result.size} B` : result.size < 1024 * 1024 ? `${(result.size / 1024).toFixed(1)} KB` : `${(result.size / (1024 * 1024)).toFixed(1)} MB`
    showTransientStatus(`Added image: ${path} (${sizeStr})`)
  }

  async function compactCurrentSession(focus: string): Promise<void> {
    clearTransientStatus()
    const compactSessionId = sessionId
    runningSessionIds.add(compactSessionId)
    if (sessionId === activeDisplaySessionId) terminal.setBusy(true)
    terminal.setInputDisabled(true)
    terminal.setThinking(true, "Compacting context")
    try {
      const activePath = input.store.getActivePath(sessionId)
      const planState = currentPlanModeState(activePath)
      const systemPrompt = appendPlanModeGuidance(appendSkillGuidance(input.config.systemPrompt, skillCatalog.skills), planState)
      const result = await compactSessionIfNeeded({
        config: input.config,
        cwd: input.cwd,
        focus: focus.trim() || undefined,
        force: true,
        reason: "manual",
        sessionId: compactSessionId,
        store: input.store,
        systemPrompt,
        tools: toolDefinitions,
      })
      if (activeDisplaySessionId === compactSessionId) {
        terminal.setThinking(false)
        refreshCurrentSession()
        const u = estimateContextUsageFor(compactSessionId)
        terminal.setContextUsage(u.tokens, u.window)
      }
      const message = result.entry
        ? `Compacted context: ${formatTokenCount(result.tokensBefore)} -> ${formatTokenCount(result.tokensAfter || result.tokensBefore)} tokens. File-read state cleared.`
        : `Compaction skipped: ${formatCompactionSkip(result.skipped)}.`
      showTransientStatus(message, 6000)
    } catch (error) {
      showTransientStatus(`Compaction failed: ${formatError(error)}`, 6000)
    } finally {
      if (activeDisplaySessionId === compactSessionId) terminal.setThinking(false)
      terminal.setInputDisabled(false)
      if (activeDisplaySessionId === compactSessionId) terminal.setBusy(false)
      runningSessionIds.delete(compactSessionId)
    }
  }

  function clearTransientStatus(): void {
    transientStatusToken += 1
    if (transientStatusTimer) {
      clearTimeout(transientStatusTimer)
      transientStatusTimer = undefined
    }
    syncPersistentStatusNotice()
  }

  function showStatusSummary(): void {
    const session = input.store.getSession(sessionId)
    const activePath = input.store.getActivePath(sessionId)
    const state = currentPlanModeState(activePath)
    const usage = estimateContextUsage()
    const grantCount = permissions.listSessionGrants(sessionId).length
    const lines = [
      `Session:  ${session.id}`,
      `Title:    ${session.title}`,
      `Cwd:      ${input.cwd}`,
      `Model:    ${input.config.model}`,
      `Mode:     ${state.mode}`,
      `Context:  ${formatTokenCompact(usage.tokens)} / ${formatTokenCompact(usage.window)}`,
      `Theme:    ${resolveTheme(input.config.theme).name}`,
      `Grants:   ${grantCount} permission grant${grantCount === 1 ? "" : "s"}`,
    ]
    terminal.setTranscript([...entriesToTranscript(activePath), { role: "assistant", content: lines.join("\n") }])
  }

  async function exportConversation(argument: string): Promise<void> {
    const args = argument.trim().toLowerCase().split(/\s+/)
    const isJson = args.includes("json")
    const pathArg = args.find((a) => a !== "json" && a.length > 0)
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
    const defaultPath = resolve(input.cwd, `furnace-export-${timestamp}.${isJson ? "json" : "md"}`)
    const outPath = pathArg ? resolve(input.cwd, pathArg) : defaultPath
    const activePath = input.store.getActivePath(sessionId)
    const session = input.store.getSession(sessionId)
    const transcript = entriesToTranscript(activePath)
    let content: string
    if (isJson) {
      content = JSON.stringify({ sessionId, title: session.title, messages: transcript }, null, 2) + "\n"
    } else {
      const lines = [`# ${session.title}`, ""]
      for (const msg of transcript) {
        const text = Array.isArray(msg.content)
          ? msg.content.filter((b) => b.type === "text").map((b) => (b as { type: "text"; text: string }).text).join("") + (msg.content.some((b) => b.type === "image_url") ? "\n[image attachment]" : "")
          : msg.content
        lines.push(`### ${msg.role === "user" ? "You" : "Furnace"}`, "", text, "")
      }
      content = lines.join("\n")
    }
    try {
      await writeFile(outPath, content, "utf8")
      showTransientStatus(`Exported to ${outPath}`, 5000)
    } catch (error) {
      showTransientStatus(`Export failed: ${formatError(error)}`)
    }
  }

  async function showSessionDiff(): Promise<void> {
    const activePath = input.store.getActivePath(sessionId)
    const writeCalls = activePath.filter(
      (entry) => entry.type === "tool_call" &&
        ["write", "edit"].includes((entry.data as { name: string }).name) &&
        (entry.data as { fileSnapshot?: { path: string; existed: boolean; previousContent?: string } }).fileSnapshot,
    )
    if (writeCalls.length === 0) {
      terminal.setTranscript([...entriesToTranscript(activePath), { role: "assistant", content: "No file changes this session." }])
      return
    }
    // Group by path, keeping earliest snapshot per path (pre-session state)
    const earliest = new Map<string, { path: string; existed: boolean; previousContent?: string }>()
    for (const entry of writeCalls) {
      const snap = (entry.data as { fileSnapshot: { path: string; existed: boolean; previousContent?: string } }).fileSnapshot
      if (!earliest.has(snap.path)) earliest.set(snap.path, snap)
    }
    const patches: string[] = []
    for (const [filePath, snap] of earliest) {
      const absPath = resolve(input.cwd, filePath)
      let current = ""
      try { current = readFileSync(absPath, "utf8") } catch { /* file deleted */ }
      const prev = snap.previousContent ?? ""
      if (prev === current) continue
      patches.push(simpleDiff(filePath, prev, current))
    }
    const output = patches.length > 0 ? patches.join("\n") : "No uncommitted changes for tracked files."
    terminal.setTranscript([...entriesToTranscript(activePath), { role: "assistant", content: output }])
  }

  async function undoLastFileChange(): Promise<void> {
    const activePath = input.store.getActivePath(sessionId)
    // Find undone entries
    const undoneToolIds = new Set(
      activePath
        .filter((e) => e.type === "custom" && (e.data as { kind?: string }).kind === "undo")
        .map((e) => (e.data as { toolCallId: string }).toolCallId),
    )
    // Find last non-undone write/edit with a snapshot
    const candidate = [...activePath].reverse().find(
      (entry) =>
        entry.type === "tool_call" &&
        ["write", "edit"].includes((entry.data as { name: string }).name) &&
        (entry.data as { fileSnapshot?: unknown }).fileSnapshot &&
        !undoneToolIds.has(entry.id),
    )
    if (!candidate) {
      showTransientStatus("Nothing to undo.")
      return
    }
    const snap = (candidate.data as { fileSnapshot: { path: string; existed: boolean; previousContent?: string } }).fileSnapshot
    const absPath = resolve(input.cwd, snap.path)
    try {
      if (snap.existed && snap.previousContent !== undefined) {
        writeFileSync(absPath, snap.previousContent, "utf8")
      } else {
        try { unlinkSync(absPath) } catch { /* already gone */ }
      }
      input.store.appendEntry(sessionId, "custom", null, { kind: "undo", toolCallId: candidate.id })
      showTransientStatus(`Undid: ${snap.path}`)
    } catch (error) {
      showTransientStatus(`Undo failed: ${formatError(error)}`)
    }
  }

  async function showCostSummary(): Promise<void> {
    const activePath = input.store.getActivePath(sessionId)
    const session = summarizeUsageCosts(activePath)
    const allSessions = input.store.listSessions(input.cwd)
    const lifetime = summarizeUsageCosts(allSessions.flatMap((sess) => input.store.getActivePath(sess.id)))
    const fmtTokens = (p: number, c: number): string => `${formatTokenCompact(p)} prompt + ${formatTokenCompact(c)} completion = ${formatTokenCompact(p + c)} tokens`
    const fmtUnknown = (unknown: number): string => unknown > 0 ? ` (${unknown} turn${unknown === 1 ? "" : "s"} with unknown cost)` : ""
    const providerLines = session.byProvider.length === 0
      ? ["Providers: none yet"]
      : [
        "Providers:",
        ...session.byProvider.map((provider) => `- ${provider.provider}: ${formatCostUsd(provider.costUsd)} · ${fmtTokens(provider.promptTokens, provider.completionTokens)}${fmtUnknown(provider.unknownCostTurns)}`),
      ]
    const lines = [
      `Session:  ${formatCostUsd(session.costUsd)} · ${fmtTokens(session.promptTokens, session.completionTokens)}${fmtUnknown(session.unknownCostTurns)}`,
      `Cache:    ${formatTokenCompact(session.cacheReadTokens)} read + ${formatTokenCompact(session.cacheWriteTokens)} written tokens reported by provider`,
      `Lifetime: ${formatCostUsd(lifetime.costUsd)} · ${fmtTokens(lifetime.promptTokens, lifetime.completionTokens)}${fmtUnknown(lifetime.unknownCostTurns)}`,
      `Cache:    ${formatTokenCompact(lifetime.cacheReadTokens)} read + ${formatTokenCompact(lifetime.cacheWriteTokens)} written tokens reported by provider`,
      "",
      ...providerLines,
    ]
    terminal.setTranscript([...entriesToTranscript(activePath), { role: "assistant", content: lines.join("\n") }])
  }

  function enqueuePrompt(text: string, options: { hidden?: boolean; source?: string } = {}): void {
    promptQueues.enqueue(sessionId, text, options)
    syncQueuedPrompts()
  }

  function removeQueuedPrompt(id: string): QueuedPrompt | undefined {
    const removed = promptQueues.remove(sessionId, id)
    syncQueuedPrompts()
    return removed
  }

  function promoteQueuedPrompt(id: string): void {
    const prompt = promptQueues.promote(sessionId, id)
    if (!prompt) return
    syncQueuedPrompts()
    currentAbortController()?.abort()
  }

  function syncQueuedPrompts(): void {
    terminal.setQueuedPrompts(promptQueue().filter((prompt) => !prompt.hidden))
  }

  function refreshCurrentSession(): void {
    refreshInteractive(terminal, input.store, sessionId)
    const state = currentPlanModeState(input.store.getActivePath(sessionId))
    permissions.setSessionMode(sessionId, state.mode, state.planPath)
    terminal.setMode(state.mode, state.planPath)
    if (state.mode !== "plan") terminal.clearPlanActions()
    const usage = estimateContextUsage()
    terminal.setContextUsage(usage.tokens, usage.window)
    updateTerminalCostUsage(terminal, input.store, sessionId)
  }

  function estimateContextUsage(): { tokens: number; window: number } {
    return estimateContextUsageFor(sessionId)
  }

  function estimateContextUsageFor(targetSessionId: string): { tokens: number; window: number } {
    const systemPrompt = appendPlanModeGuidance(appendSkillGuidance(input.config.systemPrompt, skillCatalog.skills), currentPlanModeState(input.store.getActivePath(targetSessionId)))
    const messages = entriesToModelMessages(systemPrompt, input.store.getActivePath(targetSessionId), { cwd: input.cwd })
    const tokens = estimateRequestTokens(messages, toolDefinitions)
    return { tokens, window: effectiveContextWindow(input.config, modelListCache.models) }
  }

  async function enqueueOrRunSyntheticPrompt(text: string): Promise<void> {
    if (isCurrentSessionRunning()) {
      enqueuePrompt(text, { hidden: true, source: "background_subagent_completion" })
      return
    }
    await runPromptQueue({ hidden: true, source: "background_subagent_completion", text })
  }

  function promptQueue(targetSessionId = sessionId): QueuedPrompt[] {
    return promptQueues.get(targetSessionId)
  }

  function flushPendingBackgroundPrompts(): void {
    const prompts = pendingBackgroundPrompts.get(sessionId)
    if (!prompts || prompts.length === 0) return
    pendingBackgroundPrompts.delete(sessionId)
    for (const prompt of prompts) enqueuePrompt(prompt, { hidden: true, source: "background_subagent_completion" })
    const queue = promptQueue()
    if (!isCurrentSessionRunning() && queue.length > 0) {
      const next = queue.shift()
      syncQueuedPrompts()
      if (next) void runPromptQueue(next).catch((error) => {
        terminal.setTranscript([...entriesToTranscript(input.store.getActivePath(sessionId)), { role: "assistant", content: formatError(error) }])
      })
    }
  }

  async function runPromptQueue(firstPrompt: PromptQueueInput, submittedImages?: ImageAttachment[]): Promise<void> {
    const targetSessionId = sessionId
    const queue = promptQueue(targetSessionId)
    promptQueues.unshiftActive(targetSessionId, firstPrompt, submittedImages)
    syncQueuedPrompts()
    if (isSessionRunning(targetSessionId)) return

    runningSessionIds.add(targetSessionId)
    if (targetSessionId === activeDisplaySessionId) terminal.setBusy(true)
    try {
      while (queue.length > 0) {
        const next = queue.shift()
        syncQueuedPrompts()
        if (!next) continue
        const controller = new AbortController()
        activeAbortControllers.set(targetSessionId, controller)
        const turnSessionId = targetSessionId
        let completed = false
        try {
          await runSingleTurn({
            config: input.config,
            contextWindow: effectiveContextWindow(input.config, modelListCache.models),
            cwd: input.cwd,
            hiddenUserMessage: next.hidden,
            hiddenUserMessageSource: next.hidden ? next.source || "hidden_prompt" : undefined,
            images: next.images,
            permissions,
            prompt: next.text,
            sessionId: turnSessionId,
            signal: controller.signal,
            onPlanReady: (planPath) => {
              terminalForSession(turnSessionId).showPlanActions(planPath, (action) => {
                void handlePlanAction(action, planPath).catch((error) => showTransientStatus(formatError(error)))
              })
            },
            store: input.store,
            taskRunner: taskManager,
            terminal: terminalForSession(turnSessionId),
          })
          completed = true
        } catch (error) {
          if (!isAbortError(error)) throw error
          input.store.appendMessage(turnSessionId, "assistant", "Interrupted by queued prompt.", input.config.model)
          if (activeDisplaySessionId === turnSessionId) {
            terminal.setThinking(false)
            terminal.setTranscript(entriesToTranscript(input.store.getActivePath(turnSessionId)))
          }
        } finally {
          if (completed && !next.hidden) {
            if (activeDisplaySessionId === turnSessionId) unreadCompletedSessionIds.delete(turnSessionId)
            else unreadCompletedSessionIds.add(turnSessionId)
          }
          if (activeAbortControllers.get(turnSessionId) === controller) activeAbortControllers.delete(turnSessionId)
          if (activeDisplaySessionId === turnSessionId) {
            const usage = estimateContextUsageFor(turnSessionId)
            terminal.setContextUsage(usage.tokens, usage.window)
            updateTerminalCostUsage(terminal, input.store, turnSessionId)
          }
        }
      }
    } finally {
      runningSessionIds.delete(targetSessionId)
      activeAbortControllers.delete(targetSessionId)
      if (targetSessionId === activeDisplaySessionId) {
        terminal.setBusy(false)
        terminal.setThinking(false)
      }
      if (input.config.notifications) process.stdout.write("\x07")
      syncQueuedPrompts()
    }
  }
}

function clearTerminalViewportAndScrollback(): void {
  // 2J clears the visible viewport, 3J clears terminal scrollback in terminals
  // that support xterm's extension, and H returns the cursor to the top-left.
  // This prevents `npm run dev` / shell output from remaining above the first
  // Furnace render while preserving `--no-clear` for users who want it.
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H")
}

function refreshInteractive(terminal: FurnaceTerminal, store: SessionStore, sessionId: string): void {
  const session = store.getSession(sessionId)
  const activePath = store.getActivePath(sessionId)
  const transcript = entriesToTranscript(activePath)
  const forkParentTitle = session.relationType === "fork" && session.parentSessionId ? sessionTitleById(store, session.parentSessionId) : undefined
  terminal.setSessionMeta({ forkParentTitle, title: session.title })
  terminal.clearToolActivities()
  terminal.setTranscript(transcript)
}

async function visibleAssistantTextForMode(cwd: string, assistantText: string, state: { mode: AgentMode; planPath?: string }): Promise<string> {
  if (state.mode !== "plan" || !state.planPath) return assistantText
  try {
    const content = await readFile(resolve(cwd, state.planPath), "utf8")
    return renderVisiblePlanArtifact(assistantText, state.planPath, content)
  } catch {
    return assistantText
  }
}

export async function runPiped(input: {
  config: Awaited<ReturnType<typeof loadConfig>>
  sessionId: string
  store: SessionStore
}): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin })
  let sessionId = input.sessionId
  const permissions = new SessionPermissionStore()

  for await (const line of rl) {
    const prompt = line.trim()
    if (!prompt) continue
    const command = parseSlashCommand(prompt)
    if (command.name === "/exit" || command.name === "/quit") break
    if (command.name === "/new") {
      const session = input.store.getSession(sessionId)
      sessionId = session.activeLeafId ? input.store.createSession({ cwd: process.cwd(), title: "New Chat" }).id : session.id
      continue
    }
    if (command.name === "/plan") {
      const state = transitionPlanMode({ cwd: process.cwd(), mode: "plan", reason: "user", seed: command.argument, sessionId, store: input.store })
      permissions.setSessionMode(sessionId, state.mode, state.planPath)
      process.stdout.write(`Plan mode active. Plan artifact: ${state.planPath}\n`)
      if (command.argument) {
        await runSingleTurn({ config: input.config, cwd: process.cwd(), permissions, prompt: command.argument, sessionId, store: input.store })
      }
      continue
    }
    if (command.name === "/agent") {
      const state = transitionPlanMode({ cwd: process.cwd(), mode: "agent", reason: "user", sessionId, store: input.store })
      permissions.setSessionMode(sessionId, state.mode)
      process.stdout.write("Agent mode active.\n")
      continue
    }
    if (command.name === "/mode") {
      const requested = command.argument.trim().toLowerCase()
      if (!requested) {
        const state = currentPlanModeState(input.store.getActivePath(sessionId))
        process.stdout.write(`Current mode: ${state.mode}${state.mode === "plan" && state.planPath ? ` (${state.planPath})` : ""}\n`)
        continue
      }
      if (requested === "agent") {
        const state = transitionPlanMode({ cwd: process.cwd(), mode: "agent", reason: "user", sessionId, store: input.store })
        permissions.setSessionMode(sessionId, state.mode)
        process.stdout.write("Agent mode active.\n")
        continue
      }
      if (requested === "plan") {
        const state = transitionPlanMode({ cwd: process.cwd(), mode: "plan", reason: "user", sessionId, store: input.store })
        permissions.setSessionMode(sessionId, state.mode, state.planPath)
        process.stdout.write(`Plan mode active. Plan artifact: ${state.planPath}\n`)
        continue
      }
      process.stdout.write("Usage: /mode [agent|plan]\n")
      continue
    }
    if (command.name === "/permissions") {
      const removed = permissions.clearSession(sessionId)
      process.stdout.write(removed > 0 ? `Reset ${removed} permission grant${removed === 1 ? "" : "s"} for this conversation.\n` : "No permission grants to reset for this conversation.\n")
      continue
    }
    if (isHistoryCommand(command.name)) {
      process.stdout.write(`${formatHistoryOverview(input.store, process.cwd()).join("\n")}\n`)
      continue
    }
    if (command.name === "/fork" || command.name === "/clone") {
      const arg = command.name === "/clone" ? "current" : command.argument.trim()
      if (!arg) {
        const points = input.store.listForkPoints(sessionId)
        if (hasConversationMessages(input.store.getActivePath(sessionId))) process.stdout.write(`current - ${input.store.getSession(sessionId).title}\n`)
        for (const { entry, forkCount } of points) {
          process.stdout.write(`${firstLine(entry.data.content)} - ${formatRelativeTime(entry.createdAt)}${forkCount > 0 ? ` - ${forkCount} fork${forkCount === 1 ? "" : "s"}` : ""}\n`)
        }
        process.stdout.write("Use /fork current or /fork <prompt preview>.\n")
        continue
      }
      const isCurrent = ["current", "tip", "head"].includes(arg.toLowerCase())
      const sourceEntryId = isCurrent ? undefined : resolveForkEntryId(input.store, sessionId, arg)
      if (!isCurrent && !sourceEntryId) {
        process.stdout.write(`Unknown fork point: ${arg}\n`)
        continue
      }
      const result = input.store.forkSession({ position: isCurrent ? "at" : "before", sourceEntryId, sourceSessionId: sessionId })
      sessionId = result.forkedSession.id
      process.stdout.write(`Forked: ${result.forkedSession.title}\n`)
      continue
    }
    if (command.name === "/model") {
      process.stdout.write(`${input.config.model}\n`)
      continue
    }
    if (command.name === "/skills") {
      const catalog = await loadSkills(process.cwd(), { extraPaths: input.config.skillPaths })
      const [subcommand = "list", ...rest] = command.argument.trim().split(/\s+/).filter(Boolean)
      if (subcommand === "reload") {
        process.stdout.write(`Reloaded ${catalog.skills.length} skill${catalog.skills.length === 1 ? "" : "s"}.\n`)
        continue
      }
      if (subcommand === "view") {
        process.stdout.write(`${formatSkillView(catalog.skills, rest.join(" ").trim())}\n`)
        continue
      }
      process.stdout.write(`${formatSkillsList(catalog.skills)}\n`)
      continue
    }
    if (command.name === "/compact") {
      const catalog = await loadSkills(process.cwd(), { extraPaths: input.config.skillPaths })
      const activePath = input.store.getActivePath(sessionId)
      const planState = currentPlanModeState(activePath)
      const systemPrompt = appendPlanModeGuidance(appendSkillGuidance(input.config.systemPrompt, catalog.skills), planState)
      const result = await compactSessionIfNeeded({
        config: input.config,
        cwd: process.cwd(),
        focus: command.argument.trim() || undefined,
        force: true,
        reason: "manual",
        sessionId,
        store: input.store,
        systemPrompt,
        tools: toolDefinitions,
      })
      process.stdout.write(
        result.entry
          ? `Compacted context: ${formatTokenCount(result.tokensBefore)} -> ${formatTokenCount(result.tokensAfter || result.tokensBefore)} tokens. File-read state cleared.\n`
          : `Compaction skipped: ${formatCompactionSkip(result.skipped)}.\n`,
      )
      continue
    }
    if (command.name === "/theme") {
      if (!command.argument) {
        process.stdout.write(`${resolveTheme(input.config.theme).name}\n`)
        for (const choice of themeChoices) process.stdout.write(`${choice.name} - ${choice.description}\n`)
        continue
      }
      const choice = findTheme(command.argument)
      if (!choice) {
        process.stdout.write(`Unknown theme: ${command.argument}\nAvailable themes: ${themeChoices.map((theme) => theme.name).join(", ")}\n`)
        continue
      }
      input.config.theme = choice.name
      await saveThemePreference(process.cwd(), choice.name)
      process.stdout.write(`${choice.name}\n`)
      continue
    }
    if (command.name === "/lofi") {
      process.stdout.write("Lofi mode is only available in the interactive TUI.\n")
      continue
    }
    if (command.name === "/evolve") {
      process.stdout.write("/evolve is only available in the interactive TUI (it needs the diff-review consent step).\n")
      continue
    }
    if (command.name === "/reset") {
      process.stdout.write("/reset is only available in the interactive TUI (it needs a confirmation step).\n")
      continue
    }
    if (command.name === "/settings" || command.name === "/prefs") {
      const statusLine = input.config.statusLine
      const statusContext =
        statusLine.statusContextMode === "off" || statusLine.statusShowContext === false
          ? "off"
          : statusLine.statusContextMode === "percent"
            ? "percent only"
            : statusLine.statusContextMode === "tokens-percent" || statusLine.statusShowContextPercent === true
              ? "percent"
              : "on"
      process.stdout.write(
        `layout=${input.config.layout}\n` +
          `typingIndicator=${input.config.typingIndicator ?? "block"}\n` +
          `typingIndicatorBlink=${input.config.typingIndicatorBlink === true}\n` +
          `notifications=${input.config.notifications === true}\n` +
          `statusAppName=${statusLine.statusShowAppName !== false}\n` +
          `statusCwd=${statusLine.statusShowCwd !== false}\n` +
          `statusTitle=${statusLine.statusShowTitle !== false}\n` +
          `statusContext=${statusContext}\n` +
          `statusCost=${statusLine.statusShowCost !== false}\n` +
          `statusMode=${statusLine.statusShowMode !== false}\n` +
          `statusWindow=${statusLine.statusShowWindow !== false}\n` +
          `statusTheme=${statusLine.statusShowTheme !== false}\n` +
          `statusModel=${statusLine.statusShowModel !== false}\n` +
          `statusReasoning=${statusLine.statusShowReasoning !== false}\n` +
          `statusFast=${statusLine.statusShowFast !== false}\n` +
          `statusForkParent=${statusLine.statusShowForkParent !== false}\n`,
      )
      continue
    }
    if (isSkillCommand(command.name)) {
      const skillName = command.name.slice("/skill:".length)
      const skill = await loadSkillByName(process.cwd(), skillName, { extraPaths: input.config.skillPaths })
      if (!skill) {
        process.stdout.write(`Unknown skill: ${skillName}\n`)
        continue
      }
      await runSingleTurn({
        config: input.config,
        cwd: process.cwd(),
        hiddenUserMessage: true,
        hiddenUserMessageSource: "skill_invocation",
        permissions,
        prompt: renderSkillInvocationMessage(skill, command.argument),
        sessionId,
        store: input.store,
      })
      continue
    }
    await runSingleTurn({ config: input.config, cwd: process.cwd(), permissions, prompt, sessionId, store: input.store })
  }
}

export async function runSingleTurn(input: {
  config: Awaited<ReturnType<typeof loadConfig>>
  contextWindow?: number
  cwd: string
  hiddenUserMessage?: boolean
  hiddenUserMessageSource?: string
  images?: ImageAttachment[]
  outputFormat?: "text" | "json"
  permissions?: SessionPermissionStore
  prompt: string
  sessionId: string
  signal?: AbortSignal
  skipTitle?: boolean
  onPlanReady?: (planPath: string) => void
  store: SessionStore
  taskRunner?: TaskManager
  terminal?: FurnaceTerminal
}): Promise<void> {
  const permissions = input.permissions || new SessionPermissionStore()
  const taskRunner: TaskManager =
    input.taskRunner ||
    createSubagentTaskManager({
      cwd: input.cwd,
      executeChildTask: (record, signal, manager) => runSubagentTask({ config: input.config, cwd: input.cwd, permissions, record, signal, store: input.store, taskManager: manager, terminal: input.terminal }),
      permissions,
      store: input.store,
    })

  const referencedImages = (input.images ?? []).filter((img) => {
    if (!img.label || !input.prompt.includes(`[Image #${img.label}]`)) return false
    if (img.source.type === "base64" && !img.source.data) return false
    return true
  })
  input.store.appendMessage(input.sessionId, "user", input.prompt, {
    ...(input.hiddenUserMessage ? { hidden: true, source: input.hiddenUserMessageSource || "hidden_prompt" } : {}),
    ...(referencedImages.length > 0 ? { images: referencedImages } : {}),
  })

  if (input.terminal) {
    input.terminal.clearToolActivities()
    input.terminal.setTranscript(entriesToTranscript(input.store.getActivePath(input.sessionId)))
    input.terminal.setThinking(true, "Thinking")
  }
  if (!input.hiddenUserMessage && !input.skipTitle) await maybeTitleSession(input.store, input.sessionId, input.config, input.prompt)
  input.terminal?.setTitle(input.store.getSession(input.sessionId).title)

  const activePath = input.store.getActivePath(input.sessionId)
  const transcript = entriesToTranscript(activePath)
  const planState = currentPlanModeState(activePath)
  permissions.setSessionMode(input.sessionId, planState.mode, planState.planPath)
  const skillCatalog = await loadSkills(input.cwd, { extraPaths: input.config.skillPaths })
  const systemPrompt = appendPlanModeGuidance(appendSkillGuidance(input.config.systemPrompt, skillCatalog.skills), planState)
  const messages: OpenRouterMessage[] = entriesToModelMessages(systemPrompt, activePath, { cwd: input.cwd })
  updateTerminalContextUsage(input.terminal, input.config, messages, toolDefinitions, input.contextWindow)

  if (input.terminal) input.terminal.setTranscript(transcript)
  else if (input.outputFormat !== "json") renderAssistantStart(transcript)

  const toolActivities: ToolActivity[] = []
  const terminal = input.terminal
  let streamingText = ""
  terminal?.setStreamingContent("")
  let agentResult
  const startedAt = Date.now()
  try {
    agentResult = await runAgentTurn({
    config: input.config,
    cwd: input.cwd,
    fileReadStore: input.store,
    messages,
    onTextDelta: terminal
      ? (delta) => {
          streamingText += delta
          terminal.setThinking(false)
          terminal.setStreamingContent(streamingText)
        }
      : undefined,
    onPermissionRequest: terminal
      ? async (request) => {
          terminal.setThinking(true, `Waiting for ${request.toolName} approval`)
          const decision = await terminal.requestApproval(request)
          terminal.setThinking(true, "Thinking")
          return decision
        }
      : undefined,
    onQuestionRequest: terminal
      ? async (request) => {
          terminal.setThinking(true, "Waiting for your answer")
          const response = await terminal.requestQuestions(request)
          terminal.setThinking(true, "Thinking")
          return response
        }
      : undefined,
    permissions,
    sessionId: input.sessionId,
    signal: input.signal,
    taskRunner,
    todoStore: input.store,
    onBeforeModelRequest: async (currentMessages, activeTools) => {
      const compacted = await compactMessagesBeforeRequest({
        config: input.config,
        currentMessages,
        cwd: input.cwd,
        reason: "threshold",
        sessionId: input.sessionId,
        store: input.store,
        systemPrompt,
        terminal: input.terminal,
        tools: activeTools,
      })
      const transformed = await applyHeadroomLiteRequestTransforms({ cwd: input.cwd, messages: compacted })
      updateTerminalContextUsage(input.terminal, input.config, transformed.messages, activeTools, input.contextWindow)
      return transformed.messages
    },
    onContextOverflow: (_currentMessages, activeTools) => compactMessagesAfterOverflow({
      config: input.config,
      cwd: input.cwd,
      sessionId: input.sessionId,
      store: input.store,
      systemPrompt,
      terminal: input.terminal,
      tools: activeTools,
    }),
    onToolStart: (call) => {
      streamingText = ""
      terminal?.setStreamingContent("")
      const fileSnapshot = captureFileSnapshot(call.name, call.arguments, input.cwd)
      input.store.appendToolCall(input.sessionId, {
        arguments: call.arguments,
        fileSnapshot,
        name: call.name,
        toolCallId: call.id,
      })
      toolActivities.push({ args: call.arguments, id: call.id, name: call.name, status: "running" })
      input.terminal?.setToolActivities([...toolActivities])
      input.terminal?.setThinking(true, `Running ${call.name}`)
    },
    onToolResult: (call, content, execution) => {
      input.store.appendToolResult(input.sessionId, {
        content,
        name: call.name,
        status: execution.status,
        toolCallId: call.id,
      })
      const index = toolActivities.findIndex((activity) => activity.id === call.id)
      const status = execution.status === "error" ? "failed" : "done"
      const activity = { args: call.arguments, id: call.id, name: call.name, result: content, status } satisfies ToolActivity
      if (index >= 0) toolActivities[index] = activity
      else toolActivities.push(activity)
      input.terminal?.setToolActivities([...toolActivities])
      streamingText = ""
      terminal?.setStreamingContent("")
      input.terminal?.setThinking(true, "Thinking")
    },
  })
  } catch (error) {
    if (isAbortError(error) && streamingText.trim()) {
      input.store.appendMessage(input.sessionId, "assistant", streamingText, { model: input.config.model })
      if (terminal) {
        terminal.setThinking(false)
        terminal.setStreamingContent("")
        terminal.setTranscript(entriesToTranscript(input.store.getActivePath(input.sessionId)))
      }
    }
    throw error
  }
  const assistantText = await visibleAssistantTextForMode(input.cwd, agentResult.content, planState)
  const pricing = await currentModelPricing(input.config, input.config.model)

  const turnUsage = agentResult.usage
    ? {
      cacheReadTokens: agentResult.usage.cacheReadTokens,
      cacheWriteTokens: agentResult.usage.cacheWriteTokens,
      promptTokens: agentResult.usage.promptTokens,
      completionTokens: agentResult.usage.completionTokens,
      costUsd: typeof agentResult.usage.costUsd === "number" ? agentResult.usage.costUsd : calculateUsageCostUsd(agentResult.usage, pricing),
      model: input.config.model,
      provider: input.config.provider,
    }
    : undefined

  input.store.appendMessage(input.sessionId, "assistant", assistantText, { model: input.config.model, usage: turnUsage })
  if (input.terminal) {
    input.terminal.setThinking(false)
    updateTerminalCostUsage(input.terminal, input.store, input.sessionId)
    input.terminal.setTranscript(entriesToTranscript(input.store.getActivePath(input.sessionId)))
    if (planState.mode === "plan" && planState.planPath) {
      input.onPlanReady?.(planState.planPath)
    }
  } else if (input.outputFormat === "json") {
    const promptTokens = agentResult.usage?.promptTokens ?? null
    const cacheReadTokens = agentResult.usage?.cacheReadTokens ?? null
    const cacheWriteTokens = agentResult.usage?.cacheWriteTokens ?? null
    const completionTokens = agentResult.usage?.completionTokens ?? null
    const promptTokensIncludeCache = input.config.provider === "openrouter"
    const freshInputTokens = promptTokens === null
      ? null
      : promptTokensIncludeCache
        ? Math.max(promptTokens - (cacheReadTokens ?? 0), 0)
        : promptTokens
    const output = {
      content: agentResult.content,
      model: input.config.model,
      provider: input.config.provider,
      sessionId: input.sessionId,
      cacheReadTokens,
      cacheWriteTokens,
      costUsd: turnUsage?.costUsd ?? null,
      promptTokens,
      inputTokens: freshInputTokens,
      completionTokens,
      totalTokens: promptTokens !== null
        ? (freshInputTokens ?? 0)
          + (completionTokens ?? 0)
          + (cacheReadTokens ?? 0)
          + (cacheWriteTokens ?? 0)
        : null,
      toolCalls: toolActivities.length,
      elapsedMs: Date.now() - startedAt,
    }
    process.stdout.write(JSON.stringify(output, null, 2) + "\n")
  } else {
    renderConversation(entriesToTranscript(input.store.getActivePath(input.sessionId)))
    renderDone()
  }
}

function createSubagentTaskManager(input: {
  cwd: string
  executeChildTask: (record: TaskRecord, signal: AbortSignal, manager: TaskManager) => Promise<string>
  onGroupComplete?: TaskManagerOptions["onGroupComplete"]
  permissions: SessionPermissionStore
  store: SessionStore
}): TaskManager {
  let manager!: TaskManager
  manager = new TaskManager({
    createChildTask: ({ description, parentSessionId, prompt }) => {
      const child = input.store.createSession({
        cwd: input.cwd,
        parentSessionId,
        relationType: "subagent",
        rootSessionId: parentSessionId,
        title: `${description} (subagent)`,
      })
      input.permissions.inheritSession(child.id, parentSessionId)
      inheritPlanMode(input.store, input.permissions, parentSessionId, child.id)
      return {
        background: false,
        childSessionId: child.id,
        description,
        id: makeTaskId("task"),
        parentSessionId,
        prompt,
        startedAt: Date.now(),
        status: "running",
      }
    },
    executeChildTask: (record, signal) => input.executeChildTask(record, signal, manager),
    onGroupComplete: input.onGroupComplete,
  })
  return manager
}

function inheritPlanMode(
  store: SessionStore,
  permissions: SessionPermissionStore,
  parentSessionId: string,
  childSessionId: string,
): void {
  const state = currentPlanModeState(store.getActivePath(parentSessionId))
  if (state.mode !== "plan") return
  store.appendEntry<PlanModeEntryData>(childSessionId, "custom", null, {
    kind: "mode_change",
    mode: "plan",
    planPath: state.planPath,
    reason: "inherited",
  })
  permissions.setSessionMode(childSessionId, "plan", state.planPath)
}

async function runSubagentTask(input: {
  config: Awaited<ReturnType<typeof loadConfig>>
  cwd: string
  permissions: SessionPermissionStore
  record: TaskRecord
  signal: AbortSignal
  store: SessionStore
  taskManager?: TaskManager
  terminal?: FurnaceTerminal
}): Promise<string> {
  const prompt = formatSubagentPrompt(input.record)
  input.store.appendMessage(input.record.childSessionId, "user", prompt)
  const skillCatalog = await loadSkills(input.cwd, { extraPaths: input.config.skillPaths })
  const activePath = input.store.getActivePath(input.record.childSessionId)
  const planState = currentPlanModeState(activePath)
  input.permissions.setSessionMode(input.record.childSessionId, planState.mode, planState.planPath)
  const systemPrompt = appendPlanModeGuidance(appendSkillGuidance(input.config.subagentSystemPrompt, skillCatalog.skills), planState)
  const messages: OpenRouterMessage[] = entriesToModelMessages(systemPrompt, activePath, { cwd: input.cwd })
  const terminal = input.terminal
  const foregroundTerminal = (): FurnaceTerminal | undefined => input.record.background ? undefined : terminal

  const result = await runAgentTurn({
    config: input.config,
    cwd: input.cwd,
    fileReadStore: input.store,
    messages,
    onPermissionRequest: terminal
      ? async (request) => {
          foregroundTerminal()?.setThinking(true, `Waiting for subagent ${request.toolName} approval`)
          const decision = await terminal.requestApproval(request)
          foregroundTerminal()?.setThinking(true, "Thinking")
          return decision
        }
      : undefined,
    onQuestionRequest: terminal
      ? async (request) => {
          foregroundTerminal()?.setThinking(true, "Waiting for your subagent answer")
          const response = await terminal.requestQuestions(request)
          foregroundTerminal()?.setThinking(true, "Thinking")
          return response
        }
      : undefined,
    permissions: input.permissions,
    sessionId: input.record.childSessionId,
    signal: input.signal,
    tools: childToolDefinitions,
    todoStore: input.store,
    onBeforeModelRequest: async (currentMessages, activeTools) => {
      const compacted = await compactMessagesBeforeRequest({
        config: input.config,
        currentMessages,
        cwd: input.cwd,
        reason: "threshold",
        sessionId: input.record.childSessionId,
        store: input.store,
        systemPrompt,
        terminal: foregroundTerminal(),
        tools: activeTools,
      })
      return (await applyHeadroomLiteRequestTransforms({ cwd: input.cwd, messages: compacted })).messages
    },
    onContextOverflow: (_currentMessages, activeTools) => compactMessagesAfterOverflow({
      config: input.config,
      cwd: input.cwd,
      sessionId: input.record.childSessionId,
      store: input.store,
      systemPrompt,
      terminal: foregroundTerminal(),
      tools: activeTools,
    }),
    onToolStart: (call) => {
      input.store.appendToolCall(input.record.childSessionId, {
        arguments: call.arguments,
        name: call.name,
        toolCallId: call.id,
      })
      input.taskManager?.recordToolActivity(input.record.childSessionId, call.name)
    },
    onToolResult: (call, content, execution) => {
      input.store.appendToolResult(input.record.childSessionId, {
        content,
        name: call.name,
        status: execution.status,
        toolCallId: call.id,
      })
    },
  })

  input.store.appendMessage(input.record.childSessionId, "assistant", result.content, input.config.model)
  return result.content
}

async function compactMessagesBeforeRequest(input: {
  config: Awaited<ReturnType<typeof loadConfig>>
  currentMessages: OpenRouterMessage[]
  cwd: string
  reason: Extract<CompactionReason, "threshold">
  sessionId: string
  store: SessionStore
  systemPrompt: string
  terminal?: FurnaceTerminal
  tools: OpenRouterToolDefinition[]
}): Promise<OpenRouterMessage[]> {
  const result = await runCompaction({
    config: input.config,
    cwd: input.cwd,
    reason: input.reason,
    sessionId: input.sessionId,
    store: input.store,
    systemPrompt: input.systemPrompt,
    terminal: input.terminal,
    tools: input.tools,
  })
  if (!result.entry) return input.currentMessages
  return entriesToModelMessages(input.systemPrompt, input.store.getActivePath(input.sessionId), { cwd: input.cwd })
}

async function compactMessagesAfterOverflow(input: {
  config: Awaited<ReturnType<typeof loadConfig>>
  cwd: string
  sessionId: string
  store: SessionStore
  systemPrompt: string
  terminal?: FurnaceTerminal
  tools: OpenRouterToolDefinition[]
}): Promise<OpenRouterMessage[] | undefined> {
  const result = await runCompaction({
    config: input.config,
    cwd: input.cwd,
    force: true,
    reason: "overflow",
    sessionId: input.sessionId,
    store: input.store,
    systemPrompt: input.systemPrompt,
    terminal: input.terminal,
    tools: input.tools,
  })
  if (!result.entry) return undefined
  return entriesToModelMessages(input.systemPrompt, input.store.getActivePath(input.sessionId), { cwd: input.cwd })
}

async function runCompaction(input: {
  config: Awaited<ReturnType<typeof loadConfig>>
  cwd: string
  force?: boolean
  reason: CompactionReason
  sessionId: string
  store: SessionStore
  systemPrompt: string
  terminal?: FurnaceTerminal
  tools: OpenRouterToolDefinition[]
}) {
  input.terminal?.setThinking(true, input.reason === "overflow" ? "Compacting after context overflow" : "Checking context")
  const result = await compactSessionIfNeeded({
    config: input.config,
    cwd: input.cwd,
    force: input.force,
    reason: input.reason,
    sessionId: input.sessionId,
    store: input.store,
    systemPrompt: input.systemPrompt,
    tools: input.tools,
  })
  if (result.entry) input.terminal?.setThinking(true, "Compacted context")
  else input.terminal?.setThinking(true, "Thinking")

  return result
}

function formatSubagentPrompt(record: TaskRecord): string {
  return [
    `Delegated task: ${record.description}`,
    "",
    "You are running in a child session linked to a parent Furnace conversation.",
    "Use only the context below; if something is missing, make a conservative assumption and mention it in your final summary.",
    "",
    "<task_prompt>",
    record.prompt,
    "</task_prompt>",
    "",
    "Final response requirements:",
    "- Start with a concise outcome summary.",
    "- Include files changed, commands run, and verification results when applicable.",
    "- If blocked, state the blocker and the next action the parent agent should take.",
  ].join("\n")
}

function formatBackgroundTaskCompletion(records: TaskRecord[]): string {
  const lines = [
    "Background subagent group completed. Use these results to continue the user's work.",
    "",
    ...records.flatMap((record, index) => [
      `Task ${index + 1}: ${record.description}`,
      `- task_id: ${record.id}`,
      `- status: ${record.status}`,
      ...(record.error ? [`- error: ${record.error}`] : []),
      ...(record.result ? [`- result:\n${indentBlock(record.result)}`] : []),
      "",
    ]),
  ]
  return lines.join("\n").trim()
}

function hasActiveSubagentTasks(records: TaskRecord[]): boolean {
  return records.some((record) => record.status === "running" || record.status === "backgrounded")
}

function lastUserPrompt(store: SessionStore, sessionId: string): string {
  const entry = [...store.getActivePath(sessionId)].reverse().find((candidate) => candidate.type === "message" && candidate.role === "user" && !(candidate.data as MessageEntryData).hidden)
  const content = entry ? (entry.data as MessageEntryData).content : ""
  return firstLine(content)
}

function formatTaskStatusForUser(records: TaskRecord[]): string {
  const visible = records.filter((record) => record.status === "running" || record.status === "backgrounded")
  if (visible.length === 0) return "No active subagent tasks for this conversation."
  return visible
    .map((record) => {
      const elapsed = formatTaskElapsed((record.completedAt || Date.now()) - record.startedAt)
      return [
        `${record.status}: ${record.description}`,
        `task_id: ${record.id}`,
        `elapsed: ${elapsed}`,
        record.error ? `error: ${record.error}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    })
    .join("\n\n")
}

function formatTaskElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m${(seconds % 60).toString().padStart(2, "0")}s`
}

function shortEntryId(id: string): string {
  const suffix = id.includes("_") ? id.split("_").pop() || id : id
  return suffix.slice(0, 8)
}

function firstLine(value: string, max = 72): string {
  const line = value.replace(/\s+/g, " ").trim().split("\n")[0] || "(empty prompt)"
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function hasConversationMessages(entries: ReturnType<SessionStore["getActivePath"]>): boolean {
  const hasUser = entries.some((entry) => entry.type === "message" && entry.role === "user" && typeof (entry.data as { content?: unknown }).content === "string" && (entry.data as { content: string }).content.trim())
  const hasAssistant = entries.some((entry) => entry.type === "message" && entry.role === "assistant" && typeof (entry.data as { content?: unknown }).content === "string" && (entry.data as { content: string }).content.trim())
  return hasUser && hasAssistant
}

function sessionTitleById(store: SessionStore, sessionId: string): string {
  try {
    return store.getSession(sessionId).title
  } catch {
    return sessionId
  }
}

function formatHistoryOverview(store: SessionStore, cwd: string, sessions = store.listHistorySessions(cwd)): string[] {
  const recent = sessions.slice(0, 10).map((session, index) => {
    const forkLabel = session.relationType === "fork" && session.parentSessionId ? `      fork of ${sessionTitleById(store, session.parentSessionId)}` : ""
    return `${index + 1}. ${session.title} (${formatRelativeTime(session.updatedAt)})${forkLabel}`
  })
  const roots = sessions.filter((session) => session.relationType !== "fork")
  const branchLines: string[] = []
  for (const root of roots) {
    const children = store.listForkChildren(root.id)
    if (children.length === 0) continue
    branchLines.push(root.title)
    children.slice(0, 6).forEach((child, index) => {
      const stem = index === Math.min(children.length, 6) - 1 ? "└─" : "├─"
      branchLines.push(`${stem} ${child.title} (${formatRelativeTime(child.updatedAt)})`)
    })
  }
  if (branchLines.length === 0) return ["Recent", ...recent]
  return ["Recent", ...recent, "", "Branches", ...branchLines]
}

function formatSkillsList(skills: Skill[]): string {
  if (skills.length === 0) return "No skills discovered. Add SKILL.md files or configure skillPaths in .furnace/preferences.json, then run /skills reload."
  return [
    `Discovered ${skills.length} skill${skills.length === 1 ? "" : "s"}:`,
    "",
    ...skills.map((skill) => {
      const mode = skill.disableModelInvocation ? "manual" : "auto"
      return `- /skill:${skill.name} [${mode}, ${skill.provenance}] ${skill.description}`
    }),
    "",
    "Use /skills view <name> to inspect a skill, or /skills reload after adding/editing skills.",
  ].join("\n")
}

function formatSkillView(skills: Skill[], name: string): string {
  if (!name) return "Usage: /skills view <name>"
  const skill = skills.find((candidate) => candidate.name === name)
  if (!skill) return `Unknown skill: ${name}\nUse /skills list to see available skills.`
  return [
    `# ${skill.name}`,
    "",
    `Description: ${skill.description}`,
    `Invocation: ${skill.disableModelInvocation ? "manual only" : "automatic guidance + explicit /skill"}`,
    `Provenance: ${skill.provenance}`,
    `Path: ${skill.filePath}`,
    "",
    skill.content.trim(),
  ].join("\n")
}

function indentBlock(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => `  ${line}`)
    .join("\n")
}

async function maybeTitleSession(
  store: SessionStore,
  sessionId: string,
  config: Awaited<ReturnType<typeof loadConfig>>,
  firstPrompt: string,
): Promise<void> {
  const session = store.getSession(sessionId)
  if (session.title !== "New Chat") return

  try {
    store.updateSessionTitle(sessionId, await generateSessionTitle(config, firstPrompt))
  } catch {
    store.updateSessionTitle(sessionId, fallbackTitle(firstPrompt))
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function renderEvolveEditPrompt(request: string, root: string): string {
  return [
    "You are modifying the furnace harness itself (self-modification / evolve mode).",
    `The furnace source root is: ${root}`,
    "",
    `Requested change: ${request}`,
    "",
    "Guidelines:",
    "- Edit the furnace source under this root to implement the requested change.",
    "- Follow existing patterns (themes in src/ui/terminal-themes/, thinking text via setThinking in src/ui/pi-terminal.ts, status line in the footer, etc.).",
    "- Keep the change minimal and focused on the request.",
    "- Do NOT run `npm run build`, `npm test`, or scripts/clean-dist.mjs — the evolve orchestrator owns verification and building.",
    "- Ensure the change is type-correct; the orchestrator will run typecheck, tests, and an atomic build after you finish.",
    "- When done, briefly summarize what you changed.",
  ].join("\n")
}

function renderEvolveOutcomeMessage(request: string, outcome: EvolveOutcome): string {
  if (outcome.status === "unavailable") {
    return `Evolve unavailable: ${outcome.message}`
  }
  const themeFiles = outcome.createdFiles.filter((path) => /terminal-themes\/.+\.ts$/.test(path) && !path.endsWith("index.ts"))
  if (outcome.status === "applied") {
    const lines = [
      `Evolved furnace: "${request}".`,
      "Verified (typecheck, build, launch check) and applied.",
      ...(outcome.createdFiles.length > 0 ? [`New files: ${outcome.createdFiles.join(", ")}`] : []),
      ...(themeFiles.length > 0 ? ["New theme added — after restarting, run /theme and select it to activate it."] : []),
      `Restart furnace to load your changes. If startup breaks, run: furnace --recover ${outcome.recoveryId}`,
      ...(outcome.runningBinMatchesRoot ? [] : ["Note: the running furnace appears to live outside this source root, so the rebuilt bundle may not be what you launch."]),
    ]
    return lines.join("\n")
  }
  if (outcome.status === "verify-failed") {
    return `Evolve "${request}" failed verification at the ${outcome.step} step and was reverted — no changes applied. Recovery point ${outcome.recoveryId} left in place.\n\n${outcome.log.slice(0, 1500)}`
  }
  return `Evolve "${request}" was discarded (change not approved) and reverted — no changes applied.`
}

function renderEvolveConsentPrompt(diff: string, createdFiles: string[], _verifyLog: string): string {
  const created = createdFiles.length > 0 ? `\nNew files: ${createdFiles.join(", ")}` : ""
  const stat = diff
    ? diff.length > 2000 ? `${diff.slice(0, 2000)}\n... (truncated)` : diff
    : "(no tracked-file changes detected)"
  return `Apply this change to furnace? Verified (typecheck, build, launch check passed).${created}\n\nChanged files:\n${stat}`
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`
  return String(tokens)
}

function updateTerminalContextUsage(
  terminal: FurnaceTerminal | undefined,
  config: Awaited<ReturnType<typeof loadConfig>>,
  messages: OpenRouterMessage[],
  tools: OpenRouterToolDefinition[],
  contextWindow?: number,
): void {
  terminal?.setContextUsage(estimateRequestTokens(messages, tools), contextWindow ?? effectiveContextWindow(config))
}

function effectiveContextWindow(config: Awaited<ReturnType<typeof loadConfig>>, models: OpenRouterModel[] = []): number {
  const configured = config.modelSettings.contextLength
  if (typeof configured === "number" && configured > 0) return configured
  const modelContext = models.find((model) => model.id === config.model)?.contextLength
  if (typeof modelContext === "number" && modelContext > 0) return modelContext
  return resolveCompactionSettings(config).contextWindow
}

function updateTerminalCostUsage(terminal: FurnaceTerminal | undefined, store: SessionStore, sessionId: string): void {
  if (!terminal) return
  terminal.setCostUsage(summarizeUsageCosts(store.getActivePath(sessionId)).costUsd)
}

async function currentModelPricing(config: Awaited<ReturnType<typeof loadConfig>>, modelId: string): Promise<{ prompt: number; completion: number } | undefined> {
  const models = await listOpenRouterModels(config).catch(() => [])
  return models.find((model) => model.id === modelId)?.pricing
}

function formatCompactionSkip(reason: string | undefined): string {
  if (reason === "below_threshold") return "context is below the automatic threshold"
  if (reason === "empty_session") return "session is empty"
  if (reason === "already_compacted") return "latest entry is already a compaction marker"
  if (reason === "no_recent_suffix") return "could not find a safe recent suffix"
  if (reason === "nothing_to_summarize") return "not enough older context to summarize"
  if (reason === "ineffective_compaction") return "compaction did not save enough context"
  return reason || "unknown reason"
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && (error.name === "AbortError" || /aborted|interrupted/i.test(error.message))
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diffMs = Math.max(0, now - timestamp)
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour

  if (isYesterday(timestamp, now) && diffMs >= 15 * hour) return "Yesterday"
  if (diffMs < minute) return "Just now"
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

function captureFileSnapshot(toolName: string, args: string, cwd: string): { existed: boolean; path: string; previousContent?: string } | undefined {
  if (toolName !== "write" && toolName !== "edit") return undefined
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>
    let filePath: string | undefined
    if (toolName === "write") {
      filePath = typeof parsed.path === "string" ? parsed.path : undefined
    } else {
      const patch = typeof parsed.patch === "string" ? parsed.patch : ""
      const match = patch.match(/^\*\*\* (?:Update|Add) File: (.+)$/m)
      filePath = match?.[1]?.trim()
    }
    if (!filePath) return undefined
    const absPath = resolve(cwd, filePath)
    if (!existsSync(absPath)) return { existed: false, path: filePath }
    const previousContent = readFileSync(absPath, "utf8")
    return { existed: true, path: filePath, previousContent }
  } catch {
    return undefined
  }
}

function formatTokenCompact(tokens: number): string {
  if (tokens >= 1_000_000) {
    const v = tokens / 1_000_000
    return Number.isInteger(v) ? `${v}M` : `${v.toFixed(1)}M`
  }
  if (tokens >= 1_000) {
    const v = tokens / 1_000
    return Number.isInteger(v) ? `${v}K` : `${v.toFixed(1)}K`
  }
  return String(tokens)
}

function formatCostUsd(value: number): string {
  if (value <= 0) return "$0.0000"
  if (value < 0.0001) return "<$0.0001"
  if (value < 1) return `$${value.toFixed(4)}`
  if (value < 100) return `$${value.toFixed(2)}`
  return `$${Math.round(value).toLocaleString()}`
}

function simpleDiff(filePath: string, before: string, after: string): string {
  const beforeLines = before.split("\n")
  const afterLines = after.split("\n")
  const lines: string[] = [`--- a/${filePath}`, `+++ b/${filePath}`]
  // Minimal line-by-line diff (shows all changed hunks, no context)
  const maxLen = Math.max(beforeLines.length, afterLines.length)
  let hunkStart = -1
  for (let i = 0; i <= maxLen; i++) {
    const same = i < maxLen && beforeLines[i] === afterLines[i]
    if (!same && hunkStart < 0) hunkStart = i
    if ((same || i === maxLen) && hunkStart >= 0) {
      lines.push(`@@ -${hunkStart + 1},${i - hunkStart} +${hunkStart + 1},${i - hunkStart} @@`)
      for (let j = hunkStart; j < i; j++) {
        if (j < beforeLines.length) lines.push(`-${beforeLines[j]}`)
        if (j < afterLines.length) lines.push(`+${afterLines[j]}`)
      }
      hunkStart = -1
    }
  }
  return lines.join("\n")
}

function copyToClipboard(text: string): void {
  try {
    if (process.platform === "darwin") {
      const proc = spawnSync("pbcopy", { input: text })
      if (proc.status === 0) return
    } else {
      let proc = spawnSync("xclip", ["-selection", "clipboard"], { input: text })
      if (proc.status === 0) return
      proc = spawnSync("xsel", ["--clipboard", "--input"], { input: text })
    }
  } catch { /* clipboard tool unavailable */ }
}

async function checkForUpdate(): Promise<string | undefined> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${packageName}/latest`, { signal: AbortSignal.timeout(2000) })
    if (!res.ok) return undefined
    const data = (await res.json()) as { version?: string }
    const latest = data.version
    if (!latest || latest === packageVersion) return undefined
    if (semverGt(latest, packageVersion)) return `Furnace ${latest} available — run npm i -g ${packageName} to upgrade.`
  } catch { /* network unavailable or timeout */ }
  return undefined
}

function semverGt(a: string, b: string): boolean {
  const parse = (v: string): number[] => v.split(".").map(Number)
  const [aMaj = 0, aMin = 0, aPat = 0] = parse(a)
  const [bMaj = 0, bMin = 0, bPat = 0] = parse(b)
  if (aMaj !== bMaj) return aMaj > bMaj
  if (aMin !== bMin) return aMin > bMin
  return aPat > bPat
}
