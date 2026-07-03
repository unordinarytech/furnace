#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { Command } from "commander"
import readline from "node:readline"
import { runAgentTurn } from "./agent/loop.js"
import { applyHeadroomLiteRequestTransforms } from "./compression/request-transform.js"
import { argumentScopeFor, isHistoryCommand, isKnownSlashCommand, parseSlashCommand, slashCommandDefinitions } from "./commands.js"
import { loadConfig, type FurnaceConfig } from "./config.js"
import { LofiPlayer } from "./lofi.js"
import { listOpenRouterModels, type OpenRouterMessage, type OpenRouterModel, type OpenRouterToolDefinition } from "./openrouter.js"
import { SessionPermissionStore, type PermissionGrantSummary } from "./permissions.js"
import { appendPlanModeGuidance, createPlanPath, currentPlanModeState, renderPlanExecutionPrompt, renderVisiblePlanArtifact, type AgentMode, type PlanModeEntryData } from "./plan-mode.js"
import { saveGlobalPreferences, saveModelPreferences, saveThemePreference, type ModelSettings } from "./preferences.js"
import { compactSessionIfNeeded, estimateRequestTokens, resolveCompactionSettings, type CompactionReason } from "./session/compaction.js"
import { entriesToModelMessages, entriesToTranscript } from "./session/context.js"
import { fallbackTitle, generateSessionTitle } from "./session/title.js"
import type { SessionStore } from "./session/store.js"
import { loadCustomCommands, renderCustomCommandTemplate } from "./custom-commands/loader.js"
import type { CustomCommand } from "./custom-commands/types.js"
import { appendSkillGuidance, renderSkillInvocationMessage } from "./skills/context.js"
import { loadSkillByName, loadSkills } from "./skills/loader.js"
import type { Skill } from "./skills/types.js"
import { TaskManager, makeTaskId } from "./tasks/manager.js"
import type { TaskRecord } from "./tasks/types.js"
import { childToolDefinitions, toolDefinitions } from "./tools/registry.js"
import { createFurnaceTerminal, type FurnaceTerminal, type QueuedPrompt, type ToolActivity } from "./ui/ink-terminal.js"
import type { PromptAutocompleteItem, PromptAutocompleteMatch } from "./ui/components/prompt-input.js"
import type { ImageAttachment } from "./utils/images.js"
import { findTheme, resolveTheme, themeChoices } from "./ui/terminal-themes/index.js"
import {
  renderAssistantStart,
  renderAssistantToken,
  renderConversation,
  renderDone,
  renderError,
} from "./ui/terminal.js"

const program = new Command()

program
  .name("furnace")
  .description("A from-scratch harness for agentic coding.")
  .argument("[prompt...]", "prompt to send to the model")
  .option("-p, --print <prompt>", "run a single prompt without opening the input area")
  .option("--continue", "continue the latest local session instead of starting fresh")
  .option("--new-session", "start a new local session; this is now the default")
  .option("--no-clear", "do not clear the terminal before rendering")
  .option("--session <id>", "resume a specific saved session by id")
  .option("--output-format <format>", "output format for headless mode: text (default) or json")
  .version("0.0.0")
  .addCommand(
    new Command("completion")
      .argument("<shell>", "shell type: bash, zsh, or fish")
      .description("Print shell completion script for the furnace CLI")
      .action((shell: string) => {
        const scripts: Record<string, string> = {
          bash: '# Add to ~/.bash_completion or source in ~/.bashrc\n_furnace_completions() {\n  local cur="${COMP_WORDS[COMP_CWORD]}"\n  local opts="--print --continue --new-session --no-clear --session --output-format --version --help"\n  COMPREPLY=( $(compgen -W "$opts" -- "$cur") )\n}\ncomplete -F _furnace_completions furnace\n',
          zsh: `#compdef furnace\n_furnace() {\n  local -a opts\n  opts=(--print --continue --new-session --no-clear --session --output-format --version --help)\n  _arguments '*: :->args' && return\n  case $state in args) _values "option" $opts ;; esac\n}\n_furnace "$@"\n`,
          fish: `# Save to ~/.config/fish/completions/furnace.fish\ncomplete -c furnace -l print -d "Run a single prompt"\ncomplete -c furnace -l continue -d "Continue latest session"\ncomplete -c furnace -l new-session -d "Start new session"\ncomplete -c furnace -l no-clear -d "Do not clear terminal"\ncomplete -c furnace -l session -d "Resume session by id" -r\ncomplete -c furnace -l output-format -d "Output format (text or json)" -r\ncomplete -c furnace -l version -d "Show version"\n`,
        }
        const script = scripts[shell.toLowerCase()]
        if (!script) {
          process.stderr.write(`Unknown shell: ${shell}. Supported: bash, zsh, fish\n`)
          process.exitCode = 1
          return
        }
        process.stdout.write(script)
      }),
  )
  .action(async (promptParts: string[], options: { print?: string; continue?: boolean; newSession?: boolean; clear: boolean; session?: string; outputFormat?: string }) => {
    try {
      const config = await loadConfig()
      const cwd = process.cwd()
      const { SessionStore } = await import("./session/store.js")
      const store = SessionStore.open(cwd)
      store.deleteEmptySessions(cwd)
      let session
      if (options.session) {
        try { session = store.getSession(options.session) } catch {
          process.stderr.write(`Session not found: ${options.session}\n`)
          process.exitCode = 1
          return
        }
      } else {
        session = options.continue ? store.getOrCreateLatestSession(cwd) : store.createSession({ cwd, title: "New Chat" })
      }
      const prompt = options.print || promptParts.join(" ")
      const outputFormat = options.outputFormat?.toLowerCase() === "json" ? "json" : "text"

      try {
        if (prompt.trim()) {
          await runSingleTurn({ config, cwd, prompt, sessionId: session.id, store, outputFormat })
          return
        }

        if (!process.stdin.isTTY) {
          await runPiped({ config, sessionId: session.id, store })
          return
        }

        await runInteractive({ config, cwd, sessionId: session.id, store, shouldClear: options.clear })
      } finally {
        store.deleteEmptySessions(cwd)
        store.close()
      }
    } catch (error) {
      renderError(error)
      process.exitCode = 1
    }
  })

await program.parseAsync()

type ModelListCache = {
  promise: Promise<OpenRouterModel[]>
  settled: boolean
}

function createModelListCache(config: FurnaceConfig): ModelListCache {
  const promise = listOpenRouterModels(config)
  const cache: ModelListCache = { promise, settled: false }
  promise.then(
    () => {
      cache.settled = true
    },
    () => {
      cache.settled = true
    },
  )
  return cache
}

async function runInteractive(input: {
  config: Awaited<ReturnType<typeof loadConfig>>
  cwd: string
  sessionId: string
  store: SessionStore
  shouldClear: boolean
}): Promise<void> {
  if (input.shouldClear) process.stdout.write("\x1b[2J\x1b[H")
  let sessionId = input.sessionId
  const permissions = new SessionPermissionStore()
  const lofi = new LofiPlayer()
  const pendingBackgroundRecords = new Map<string, TaskRecord[]>()
  const queuedPrompts: QueuedPrompt[] = []
  const pendingBackgroundPrompts = new Map<string, string[]>()
  const modelListCache = createModelListCache(input.config)
  let skillCatalog = await loadSkills(input.cwd, { extraPaths: input.config.skillPaths })
  let customCommands: CustomCommand[] = await loadCustomCommands(input.cwd)
  let baseAutocompleteItems: PromptAutocompleteItem[] = []
  let currentAutocompleteScope: ReturnType<typeof argumentScopeFor> | undefined
  let queueCounter = 0
  let running = false
  let activeAbortController: AbortController | undefined
  let transientStatusTimer: ReturnType<typeof setTimeout> | undefined
  let transientStatusToken = 0
  const initialSession = input.store.getSession(sessionId)
  let terminal!: FurnaceTerminal
  const taskManager: TaskManager = new TaskManager({
    createChildTask: ({ description, parentSessionId, prompt }) => {
      const child = input.store.createSession({ cwd: input.cwd, parentSessionId, title: `${description} (subagent)` })
      permissions.inheritSession(child.id, parentSessionId)
      inheritPlanMode(parentSessionId, child.id)
      return {
        background: false,
        childSessionId: child.id,
        description,
        id: makeTaskId("task"),
        parentSessionId,
        prompt,
        startedAt: Date.now(),
        status: "running",
      } satisfies TaskRecord
    },
    executeChildTask: (record, signal) => runSubagentTask({ config: input.config, cwd: input.cwd, permissions, record, signal, store: input.store, taskManager, terminal }),
    onGroupComplete: ({ backgrounded, parentSessionId, records }) => {
      if (!backgrounded) return
      const pendingRecords = [...(pendingBackgroundRecords.get(parentSessionId) || []), ...records]
      pendingBackgroundRecords.set(parentSessionId, pendingRecords)
      if (hasActiveSubagentTasks(taskManager.status(parentSessionId).tasks)) return
      pendingBackgroundRecords.delete(parentSessionId)
      const prompt = formatBackgroundTaskCompletion(pendingRecords)
      if (parentSessionId === sessionId) {
        void enqueueOrRunSyntheticPrompt(prompt)
        return
      }
      const pending = pendingBackgroundPrompts.get(parentSessionId) || []
      pending.push(prompt)
      pendingBackgroundPrompts.set(parentSessionId, pending)
    },
    onUpdate: (snapshot) => {
      if (snapshot.parentSessionId !== sessionId) return
      terminal.setTasks(snapshot.tasks)
    },
  })
  terminal = createFurnaceTerminal({
    cwd: input.cwd,
    inputMode: input.config.inputMode,
    sidebarEnabled: input.config.sidebarEnabled,
    onSidebarToggle: (enabled) => {
      void saveGlobalPreferences({ sidebarEnabled: enabled }).catch(() => {})
    },
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
      activeAbortController?.abort()
    },
    onTaskBackground: () => {
      const promoted = taskManager.promoteActiveGroup(sessionId)
      showTransientStatus(promoted ? "Subagents moved to background. Furnace will continue once the task tool returns." : "No active foreground subagents to background.")
    },
    onModeCycle: (direction) => {
      if (running) {
        showTransientStatus("Mode switching is available after the current turn finishes.")
        return
      }
      const current = currentPlanModeState(input.store.getActivePath(sessionId)).mode
      void switchMode(current === "plan" ? "agent" : "plan", { reason: "user", seed: direction > 0 ? "plan" : "agent" }).catch((error) => showTransientStatus(formatError(error)))
    },
    onInputChange: (value) => {
      if (running) return
      const scope = argumentScopeFor(value)
      if (!scope) {
        if (currentAutocompleteScope !== undefined) {
          currentAutocompleteScope = undefined
          terminal.setSlashCommandItems(baseAutocompleteItems)
        }
        return
      }
      if (currentAutocompleteScope === scope) return
      currentAutocompleteScope = scope
      if (scope === "theme") {
        terminal.setSlashCommandItems(themeAutocompleteItems())
      } else if (scope === "history") {
        terminal.setSlashCommandItems(resumeAutocompleteItems(input.store.listSessions(input.cwd)))
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
        const choice = models.find((entry) => entry.id === modelId)
        if (!choice) return
        terminal.showModelEditor(
          choice,
          choice.id === input.config.model ? input.config.modelSettings : {},
          (model, settings, done) => {
            input.config.model = model
            input.config.modelSettings = settings
            terminal.setModel(model, settings, choice.name)
            void saveModelPreferences(input.cwd, { model, modelSettings: settings }).catch((error) => {
              terminal.setTranscript([{ role: "assistant", content: `Failed to save model preference: ${formatError(error)}` }])
            })
            if (done) refreshCurrentSession()
          },
          () => refreshCurrentSession(),
        )
      })
      return true
    },
    onOpenEditor: (draft) => {
      if (running) {
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
    title: initialSession.title,
    onSubmit: (prompt, images) => {
      void handleInteractiveSubmit(prompt, images).catch((error) => {
        running = false
        activeAbortController = undefined
        terminal.setBusy(false)
        process.stdout.write("\x07")
        terminal.setThinking(false)
        terminal.setTranscript([...entriesToTranscript(input.store.getActivePath(sessionId)), { role: "assistant", content: formatError(error) }])
      })
    },
  })
  applyBaseAutocompleteItems(slashAutocompleteItems(skillCatalog.skills, customCommands))
  void modelListCache.promise.then((models) => {
    const match = models.find((model) => model.id === input.config.model)
    if (match) terminal.setModel(input.config.model, input.config.modelSettings, match.name)
  })

  // Non-blocking startup update check
  void checkForUpdate().then((notice) => {
    if (notice) showTransientStatus(notice, 6000)
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

    if (command.name === "/exit" || command.name === "/quit") {
      activeAbortController?.abort()
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
    if (command.name === "/clear") {
      terminal.clearTranscriptDisplay()
      return
    }
    if (command.name === "/image") {
      await handleImageCommand(command.argument)
      return
    }
    if (isSkillCommand(command.name)) {
      if (running) {
        showTransientStatus(`${command.name} is available after the current turn finishes.`)
        return
      }
      await runSkillCommand(command.name, command.argument)
      return
    }
    if (running && prompt.startsWith("/")) {
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
    if (running) {
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
      sessionId = next.id
      terminal.clearTranscriptDisplay()
      refreshCurrentSession()
      flushPendingBackgroundPrompts()
      return
    }
    if (command.name === "/permissions") {
      openPermissionsPanel()
      return
    }
    if (command.name === "/settings" || command.name === "/prefs") {
      const currentPrefs: import("./preferences.js").FurnacePreferences = {
        sidebarEnabled: input.config.sidebarEnabled,
        inputMode: input.config.inputMode,
        notifications: input.config.notifications,
        model: input.config.model,
        theme: input.config.theme,
        modelSettings: input.config.modelSettings,
      }
      terminal.showSettings(currentPrefs, async (updated) => {
        Object.assign(input.config, {
          sidebarEnabled: updated.sidebarEnabled !== false,
          inputMode: updated.inputMode ?? input.config.inputMode,
          notifications: updated.notifications === true,
        })
        await saveGlobalPreferences(updated).catch(() => {})
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
    if (command.name === "/model") {
      if (command.argument) {
        await setModelByArgument(command.argument)
        return
      }
      showTransientStatus(`Current model: ${input.config.model}. Type /model <name> to change.`)
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
      if (running) { showTransientStatus("Editor is available after the current turn finishes."); return }
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
      if (running) {
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
      terminal.setStatusNotice(undefined)
    }, ttlMs)
    transientStatusTimer.unref?.()
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
    terminal.setTasks(taskManager.status(sessionId).tasks)
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

  function modelAutocompleteItems(models: OpenRouterModel[]): PromptAutocompleteItem[] {
    return models.map((model) => ({
      browsable: true,
      description: model.contextLength ? `${formatTokenCount(model.contextLength)} context` : undefined,
      label: model.name || model.id,
      value: `/model ${model.id}`,
    }))
  }

  function resumeAutocompleteItems(sessions: ReturnType<SessionStore["listSessions"]>): PromptAutocompleteItem[] {
    return sessions.map((session, index) => ({
      browsable: true,
      description: formatRelativeTime(session.updatedAt),
      label: session.title,
      value: `/resume ${index + 1}`,
    }))
  }

  function showHistoryHint(): void {
    const sessions = input.store.listSessions(input.cwd)
    if (sessions.length === 0) {
      showTransientStatus("No saved conversations yet.")
      return
    }
    const lines = sessions.slice(0, 10).map((session, index) => `${index + 1}. ${session.title} (${formatRelativeTime(session.updatedAt)})`)
    showTransientStatus(`Type /resume <number> to switch, or type /resume and browse with the arrow keys.\n${lines.join("\n")}`)
  }

  function resumeSessionByToken(argument: string): void {
    const sessions = input.store.listSessions(input.cwd)
    const index = Number.parseInt(argument.trim(), 10)
    const target = Number.isInteger(index) ? sessions[index - 1] : undefined
    if (!target) {
      showTransientStatus(`Unknown conversation: ${argument}`)
      return
    }
    sessionId = target.id
    refreshCurrentSession()
    flushPendingBackgroundPrompts()
  }

  async function setModelByArgument(argument: string): Promise<void> {
    const isGlobal = argument.trimStart().startsWith("--global ")
    const trimmed = (isGlobal ? argument.trimStart().slice("--global ".length) : argument).trim()
    const models = await modelListCache.promise
    const match =
      models.find((model) => model.id.toLowerCase() === trimmed.toLowerCase()) || models.find((model) => model.name.toLowerCase() === trimmed.toLowerCase())
    if (!match) {
      showTransientStatus(`Unknown model: ${trimmed}`)
      return
    }
    const settings: ModelSettings = {}
    input.config.model = match.id
    input.config.modelSettings = settings
    terminal.setModel(match.id, settings, match.name)
    if (isGlobal) {
      await saveGlobalPreferences({ model: match.id, modelSettings: settings }).catch((error) => {
        terminal.setTranscript([{ role: "assistant", content: `Failed to save global model preference: ${formatError(error)}` }])
      })
      showTransientStatus(`Model set globally to ${match.name}.`)
    } else {
      await saveModelPreferences(input.cwd, { model: match.id, modelSettings: settings }).catch((error) => {
        terminal.setTranscript([{ role: "assistant", content: `Failed to save model preference: ${formatError(error)}` }])
      })
    }
    refreshCurrentSession()
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
    const current = currentPlanModeState(input.store.getActivePath(sessionId))
    const planPath = mode === "plan" ? current.planPath || createPlanPath(input.cwd, options.seed || input.store.getSession(sessionId).title) : undefined
    input.store.appendEntry<PlanModeEntryData>(sessionId, "custom", null, {
      kind: "mode_change",
      mode,
      planPath,
      reason: options.reason,
    })
    permissions.setSessionMode(sessionId, mode, planPath)
    terminal.setMode(mode, planPath)
    if (mode === "agent") terminal.clearPlanActions()
    showTransientStatus(mode === "plan" ? `Plan mode active. Plan artifact: ${planPath}` : "Agent mode active.")
  }

  function inheritPlanMode(parentSessionId: string, childSessionId: string): void {
    const state = currentPlanModeState(input.store.getActivePath(parentSessionId))
    if (state.mode !== "plan") return
    input.store.appendEntry<PlanModeEntryData>(childSessionId, "custom", null, {
      kind: "mode_change",
      mode: "plan",
      planPath: state.planPath,
      reason: "inherited",
    })
    permissions.setSessionMode(childSessionId, "plan", state.planPath)
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
        sessionId,
        store: input.store,
        systemPrompt,
        tools: toolDefinitions,
      })
      terminal.setThinking(false)
      refreshCurrentSession()
      { const u = estimateContextUsage(); terminal.setContextUsage(u.tokens, u.window) }
      const message = result.entry
        ? `Compacted context: ${formatTokenCount(result.tokensBefore)} -> ${formatTokenCount(result.tokensAfter || result.tokensBefore)} tokens. File-read state cleared.`
        : `Compaction skipped: ${formatCompactionSkip(result.skipped)}.`
      showTransientStatus(message, 6000)
    } catch (error) {
      terminal.setThinking(false)
      showTransientStatus(`Compaction failed: ${formatError(error)}`, 6000)
    }
  }

  function clearTransientStatus(): void {
    transientStatusToken += 1
    terminal.setStatusNotice(undefined)
    if (!transientStatusTimer) return
    clearTimeout(transientStatusTimer)
    transientStatusTimer = undefined
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
    type UsageData = { promptTokens?: number; completionTokens?: number; costUsd?: number | null }
    // Resolve pricing for cost computation
    const models = await modelListCache.promise.catch(() => [])
    const modelEntry = models.find((m) => m.id === input.config.model)
    const pricing = modelEntry?.pricing

    const sumEntries = (entries: ReturnType<typeof input.store.getActivePath>): { prompt: number; completion: number; cost: number; unknown: number } => {
      let prompt = 0; let completion = 0; let cost = 0; let unknown = 0
      for (const e of entries.filter((e) => e.type === "message" && e.role === "assistant")) {
        const u = (e.data as { usage?: UsageData }).usage
        if (!u) { unknown++; continue }
        prompt += u.promptTokens ?? 0
        completion += u.completionTokens ?? 0
        // Recompute cost with current pricing if costUsd was saved as null
        if (u.costUsd !== null && u.costUsd !== undefined) {
          cost += u.costUsd
        } else if (pricing) {
          cost += (u.promptTokens ?? 0) * pricing.prompt + (u.completionTokens ?? 0) * pricing.completion
        }
      }
      return { prompt, completion, cost, unknown }
    }

    const session = sumEntries(activePath)
    const allSessions = input.store.listSessions(input.cwd)
    const lifetime = { prompt: 0, completion: 0, cost: 0, unknown: 0 }
    for (const sess of allSessions) {
      const s = sumEntries(input.store.getActivePath(sess.id))
      lifetime.prompt += s.prompt; lifetime.completion += s.completion; lifetime.cost += s.cost; lifetime.unknown += s.unknown
    }
    const fmt = (n: number): string => `$${n.toFixed(4)}`
    const hasPricing = Boolean(pricing)
    const fmtTokens = (p: number, c: number): string => `${formatTokenCompact(p)} prompt + ${formatTokenCompact(c)} completion = ${formatTokenCompact(p + c)} tokens`
    const lines = [
      `Session:  ${fmtTokens(session.prompt, session.completion)}, ~${hasPricing ? fmt(session.cost) : "?"} USD${session.unknown > 0 ? ` (${session.unknown} turns with unknown cost)` : ""}`,
      `Lifetime: ${fmtTokens(lifetime.prompt, lifetime.completion)}, ~${hasPricing ? fmt(lifetime.cost) : "?"} USD${lifetime.unknown > 0 ? ` (${lifetime.unknown} turns with unknown cost)` : ""}`,
    ]
    terminal.setTranscript([...entriesToTranscript(activePath), { role: "assistant", content: lines.join("\n") }])
  }

  function enqueuePrompt(text: string, options: { hidden?: boolean; source?: string } = {}): void {
    queuedPrompts.push({
      createdAt: Date.now(),
      hidden: options.hidden,
      id: `queue-${Date.now()}-${queueCounter++}`,
      source: options.hidden ? options.source || "hidden_prompt" : undefined,
      text,
    })
    syncQueuedPrompts()
  }

  function removeQueuedPrompt(id: string): QueuedPrompt | undefined {
    const index = queuedPrompts.findIndex((prompt) => prompt.id === id)
    if (index < 0) return undefined
    const [removed] = queuedPrompts.splice(index, 1)
    syncQueuedPrompts()
    return removed
  }

  function promoteQueuedPrompt(id: string): void {
    const prompt = removeQueuedPrompt(id)
    if (!prompt) return
    queuedPrompts.unshift(prompt)
    syncQueuedPrompts()
    activeAbortController?.abort()
  }

  function syncQueuedPrompts(): void {
    terminal.setQueuedPrompts(queuedPrompts.filter((prompt) => !prompt.hidden))
  }

  function refreshCurrentSession(): void {
    refreshInteractive(terminal, input.store, sessionId)
    const state = currentPlanModeState(input.store.getActivePath(sessionId))
    permissions.setSessionMode(sessionId, state.mode, state.planPath)
    terminal.setMode(state.mode, state.planPath)
    if (state.mode !== "plan") terminal.clearPlanActions()
    terminal.setTasks(taskManager.status(sessionId).tasks)
    const usage = estimateContextUsage()
    terminal.setContextUsage(usage.tokens, usage.window)
  }

  function estimateContextUsage(): { tokens: number; window: number } {
    const systemPrompt = appendPlanModeGuidance(appendSkillGuidance(input.config.systemPrompt, skillCatalog.skills), currentPlanModeState(input.store.getActivePath(sessionId)))
    const messages = entriesToModelMessages(systemPrompt, input.store.getActivePath(sessionId), { cwd: input.cwd })
    const tokens = estimateRequestTokens(messages, toolDefinitions)
    const settings = resolveCompactionSettings(input.config)
    return { tokens, window: settings.contextWindow }

  }

  async function enqueueOrRunSyntheticPrompt(text: string): Promise<void> {
    if (running) {
      enqueuePrompt(text, { hidden: true, source: "background_subagent_completion" })
      return
    }
    await runPromptQueue({ hidden: true, source: "background_subagent_completion", text })
  }

  function flushPendingBackgroundPrompts(): void {
    const prompts = pendingBackgroundPrompts.get(sessionId)
    if (!prompts || prompts.length === 0) return
    pendingBackgroundPrompts.delete(sessionId)
    for (const prompt of prompts) enqueuePrompt(prompt, { hidden: true, source: "background_subagent_completion" })
    if (!running && queuedPrompts.length > 0) {
      const next = queuedPrompts.shift()
      syncQueuedPrompts()
      if (next) void runPromptQueue(next).catch((error) => {
        terminal.setTranscript([...entriesToTranscript(input.store.getActivePath(sessionId)), { role: "assistant", content: formatError(error) }])
      })
    }
  }

  async function runPromptQueue(firstPrompt: string | { hidden?: boolean; images?: ImageAttachment[]; source?: string; text: string }, submittedImages?: ImageAttachment[]): Promise<void> {
    const promptText = typeof firstPrompt === "string" ? firstPrompt : firstPrompt.text
    const hidden = typeof firstPrompt === "string" ? false : Boolean(firstPrompt.hidden)
    const source = typeof firstPrompt === "string" ? undefined : firstPrompt.source
    const images = typeof firstPrompt === "string" ? submittedImages : firstPrompt.images
    queuedPrompts.unshift({
      createdAt: Date.now(),
      hidden,
      id: `active-${Date.now()}-${queueCounter++}`,
      images,
      source,
      text: promptText,
    })
    if (running) return

    running = true
    terminal.setBusy(true)
    try {
      let isFirstTurn = true
      while (queuedPrompts.length > 0) {
        if (!isFirstTurn) await terminal.waitForInputFocus()
        const next = queuedPrompts.shift()
        syncQueuedPrompts()
        if (!next) continue
        const controller = new AbortController()
        activeAbortController = controller
        try {
          await runSingleTurn({
            config: input.config,
            cwd: input.cwd,
            hiddenUserMessage: next.hidden,
            hiddenUserMessageSource: next.hidden ? next.source || "hidden_prompt" : undefined,
            images: next.images,
            permissions,
            prompt: next.text,
            sessionId,
            signal: controller.signal,
            onPlanReady: (planPath) => {
              terminal.showPlanActions(planPath, (action) => {
                void handlePlanAction(action, planPath).catch((error) => showTransientStatus(formatError(error)))
              })
            },
            store: input.store,
            taskRunner: taskManager,
            terminal,
          })
        } catch (error) {
          if (!isAbortError(error)) throw error
          input.store.appendMessage(sessionId, "assistant", "Interrupted by queued prompt.", input.config.model)
          terminal.setThinking(false)
          terminal.setTranscript(entriesToTranscript(input.store.getActivePath(sessionId)))
        } finally {
          if (activeAbortController === controller) activeAbortController = undefined
          const usage = estimateContextUsage()
          terminal.setContextUsage(usage.tokens, usage.window)
        }
        isFirstTurn = false
      }
    } finally {
      running = false
      activeAbortController = undefined
      terminal.setBusy(false)
      process.stdout.write("\x07")
      syncQueuedPrompts()
    }
  }
}

function refreshInteractive(terminal: FurnaceTerminal, store: SessionStore, sessionId: string): void {
  const session = store.getSession(sessionId)
  const activePath = store.getActivePath(sessionId)
  const transcript = entriesToTranscript(activePath)
  terminal.setTitle(session.title)
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

async function runPiped(input: {
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
      const state = currentPlanModeState(input.store.getActivePath(sessionId))
      const planPath = state.planPath || createPlanPath(process.cwd(), command.argument || input.store.getSession(sessionId).title)
      input.store.appendEntry<PlanModeEntryData>(sessionId, "custom", null, { kind: "mode_change", mode: "plan", planPath, reason: "user" })
      permissions.setSessionMode(sessionId, "plan", planPath)
      process.stdout.write(`Plan mode active. Plan artifact: ${planPath}\n`)
      if (command.argument) {
        await runSingleTurn({ config: input.config, cwd: process.cwd(), permissions, prompt: command.argument, sessionId, store: input.store })
      }
      continue
    }
    if (command.name === "/agent") {
      input.store.appendEntry<PlanModeEntryData>(sessionId, "custom", null, { kind: "mode_change", mode: "agent", reason: "user" })
      permissions.setSessionMode(sessionId, "agent")
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
        input.store.appendEntry<PlanModeEntryData>(sessionId, "custom", null, { kind: "mode_change", mode: "agent", reason: "user" })
        permissions.setSessionMode(sessionId, "agent")
        process.stdout.write("Agent mode active.\n")
        continue
      }
      if (requested === "plan") {
        const state = currentPlanModeState(input.store.getActivePath(sessionId))
        const planPath = state.planPath || createPlanPath(process.cwd(), input.store.getSession(sessionId).title)
        input.store.appendEntry<PlanModeEntryData>(sessionId, "custom", null, { kind: "mode_change", mode: "plan", planPath, reason: "user" })
        permissions.setSessionMode(sessionId, "plan", planPath)
        process.stdout.write(`Plan mode active. Plan artifact: ${planPath}\n`)
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
      for (const [index, session] of input.store.listSessions(process.cwd()).entries()) {
        process.stdout.write(`${index + 1}. ${session.title} (${formatRelativeTime(session.updatedAt)})\n`)
      }
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
    if (command.name === "/settings" || command.name === "/prefs") {
      process.stdout.write(`sidebar=${input.config.sidebarEnabled}\ninputMode=${input.config.inputMode}\nnotifications=${input.config.notifications}\n`)
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

async function runSingleTurn(input: {
  config: Awaited<ReturnType<typeof loadConfig>>
  cwd: string
  hiddenUserMessage?: boolean
  hiddenUserMessageSource?: string
  images?: ImageAttachment[]
  outputFormat?: "text" | "json"
  permissions?: SessionPermissionStore
  prompt: string
  sessionId: string
  signal?: AbortSignal
  onPlanReady?: (planPath: string) => void
  store: SessionStore
  taskRunner?: TaskManager
  terminal?: FurnaceTerminal
}): Promise<void> {
  const permissions = input.permissions || new SessionPermissionStore()
  const taskRunner: TaskManager =
    input.taskRunner ||
    new TaskManager({
      createChildTask: ({ description, parentSessionId, prompt }) => {
        const child = input.store.createSession({ cwd: input.cwd, parentSessionId, title: `${description} (subagent)` })
        permissions.inheritSession(child.id, parentSessionId)
        const parentPlanState = currentPlanModeState(input.store.getActivePath(parentSessionId))
        if (parentPlanState.mode === "plan") {
          input.store.appendEntry<PlanModeEntryData>(child.id, "custom", null, {
            kind: "mode_change",
            mode: "plan",
            planPath: parentPlanState.planPath,
            reason: "inherited",
          })
          permissions.setSessionMode(child.id, "plan", parentPlanState.planPath)
        }
        return {
          background: false,
          childSessionId: child.id,
          description,
          id: makeTaskId("task"),
          parentSessionId,
          prompt,
          startedAt: Date.now(),
          status: "running",
        } satisfies TaskRecord
      },
      executeChildTask: (record, signal) => runSubagentTask({ config: input.config, cwd: input.cwd, permissions, record, signal, store: input.store, taskManager: taskRunner, terminal: input.terminal }),
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
  if (!input.hiddenUserMessage) await maybeTitleSession(input.store, input.sessionId, input.config, input.prompt)
  input.terminal?.setTitle(input.store.getSession(input.sessionId).title)

  const activePath = input.store.getActivePath(input.sessionId)
  const transcript = entriesToTranscript(activePath)
  const planState = currentPlanModeState(activePath)
  permissions.setSessionMode(input.sessionId, planState.mode, planState.planPath)
  const skillCatalog = await loadSkills(input.cwd, { extraPaths: input.config.skillPaths })
  const systemPrompt = appendPlanModeGuidance(appendSkillGuidance(input.config.systemPrompt, skillCatalog.skills), planState)
  const messages: OpenRouterMessage[] = entriesToModelMessages(systemPrompt, activePath, { cwd: input.cwd })
  updateTerminalContextUsage(input.terminal, input.config, messages, toolDefinitions)

  if (input.terminal) input.terminal.setTranscript(transcript)
  else renderAssistantStart(transcript)

  const toolActivities: ToolActivity[] = []
  const terminal = input.terminal
  let streamingText = ""
  terminal?.setStreamingContent("")
  let agentResult
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
      updateTerminalContextUsage(input.terminal, input.config, transformed.messages, activeTools)
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
      const narrationBefore = streamingText
      streamingText = ""
      terminal?.setStreamingContent("")
      const fileSnapshot = captureFileSnapshot(call.name, call.arguments, input.cwd)
      input.store.appendToolCall(input.sessionId, {
        arguments: call.arguments,
        fileSnapshot,
        name: call.name,
        toolCallId: call.id,
      })
      toolActivities.push({ args: call.arguments, id: call.id, name: call.name, narrationBefore, status: "running" })
      input.terminal?.setToolActivities([...toolActivities])
      input.terminal?.setThinking(true, `Running ${call.name}`)
    },
    onToolResult: (call, content) => {
      input.store.appendToolResult(input.sessionId, {
        content,
        name: call.name,
        toolCallId: call.id,
      })
      const index = toolActivities.findIndex((activity) => activity.id === call.id)
      const status = content.startsWith(`Tool ${call.name} failed:`) || content.startsWith(`Tool ${call.name} denied:`) ? "failed" : "done"
      const activity = { args: call.arguments, id: call.id, name: call.name, narrationBefore: toolActivities[index]?.narrationBefore, result: content, status } satisfies ToolActivity
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

  const turnUsage = agentResult.usage
    ? { promptTokens: agentResult.usage.promptTokens, completionTokens: agentResult.usage.completionTokens, costUsd: null as number | null }
    : undefined

  input.store.appendMessage(input.sessionId, "assistant", assistantText, { model: input.config.model })
  if (input.terminal) {
    input.terminal.setThinking(false)
    input.terminal.setTranscript(entriesToTranscript(input.store.getActivePath(input.sessionId)))
    if (planState.mode === "plan" && planState.planPath) {
      input.onPlanReady?.(planState.planPath)
    }
  } else if (input.outputFormat === "json") {
    const output = {
      content: agentResult.content,
      model: input.config.model,
      sessionId: input.sessionId,
      promptTokens: agentResult.usage?.promptTokens ?? null,
      completionTokens: agentResult.usage?.completionTokens ?? null,
    }
    process.stdout.write(JSON.stringify(output, null, 2) + "\n")
  } else {
    renderConversation(entriesToTranscript(input.store.getActivePath(input.sessionId)))
    renderDone()
  }
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

  const result = await runAgentTurn({
    config: input.config,
    cwd: input.cwd,
    fileReadStore: input.store,
    messages,
    onPermissionRequest: terminal
      ? async (request) => {
          terminal.setThinking(true, `Waiting for subagent ${request.toolName} approval`)
          const decision = await terminal.requestApproval(request)
          terminal.setThinking(true, "Thinking")
          return decision
        }
      : undefined,
    onQuestionRequest: terminal
      ? async (request) => {
          terminal.setThinking(true, "Waiting for your subagent answer")
          const response = await terminal.requestQuestions(request)
          terminal.setThinking(true, "Thinking")
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
        terminal,
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
      terminal,
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
    onToolResult: (call, content) => {
      input.store.appendToolResult(input.record.childSessionId, {
        content,
        name: call.name,
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

function slashAutocompleteItems(skills: Skill[], customCmds: CustomCommand[] = []): PromptAutocompleteItem[] {
  return [
    ...slashCommandDefinitions.map((command) => ({
      description: command.description,
      insertText: command.insertText,
      label: command.usage || command.name,
      value: command.name,
    })),
    ...customCmds.map((cmd) => ({
      description: cmd.description || `Custom command (${cmd.provenance})`,
      insertText: `/${cmd.name} `,
      label: `/${cmd.name}`,
      value: `/${cmd.name}`,
    })),
    ...skills.flatMap((skill) => [
      {
        description: skill.description,
        insertText: `/skill:${skill.name} `,
        label: `/${skill.name}`,
        value: `/${skill.name}`,
      },
      {
        description: skill.description,
        insertText: `/skill:${skill.name} `,
        label: `/skill:${skill.name}`,
        value: `/skill:${skill.name}`,
      },
    ]),
  ]
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

function isSkillCommand(commandName: string): boolean {
  return commandName.startsWith("/skill:") && commandName.length > "/skill:".length
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
): void {
  terminal?.setContextUsage(estimateRequestTokens(messages, tools), config.modelSettings.contextLength ?? 200000)
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
    const { createRequire } = await import("node:module")
    const req = createRequire(import.meta.url)
    const pkg = req("../package.json") as { version?: string; name?: string }
    const currentVersion = pkg.version || "0.0.0"
    const pkgName = pkg.name || "furnace"
    const res = await fetch(`https://registry.npmjs.org/${pkgName}/latest`, { signal: AbortSignal.timeout(2000) })
    if (!res.ok) return undefined
    const data = (await res.json()) as { version?: string }
    const latest = data.version
    if (!latest || latest === currentVersion) return undefined
    if (semverGt(latest, currentVersion)) return `Furnace ${latest} available — run npm i -g ${pkgName} to upgrade.`
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
