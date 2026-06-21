#!/usr/bin/env node

import { Command } from "commander"
import readline from "node:readline"
import { runAgentTurn } from "./agent/loop.js"
import { isHistoryCommand, isKnownSlashCommand, parseSlashCommand, slashCommandDefinitions } from "./commands.js"
import { loadConfig } from "./config.js"
import { LofiPlayer } from "./lofi.js"
import { listOpenRouterModels, type OpenRouterMessage } from "./openrouter.js"
import { SessionPermissionStore } from "./permissions.js"
import { saveModelPreferences, saveThemePreference } from "./preferences.js"
import { entriesToModelMessages, entriesToTranscript } from "./session/context.js"
import { fallbackTitle, generateSessionTitle } from "./session/title.js"
import type { SessionStore } from "./session/store.js"
import { appendSkillGuidance, renderSkillInvocationMessage } from "./skills/context.js"
import { loadSkillByName, loadSkills } from "./skills/loader.js"
import type { Skill } from "./skills/types.js"
import { TaskManager, makeTaskId } from "./tasks/manager.js"
import type { TaskRecord } from "./tasks/types.js"
import { childToolDefinitions } from "./tools/registry.js"
import { createFurnaceTerminal, type FurnaceTerminal, type QueuedPrompt, type ToolActivity } from "./ui/ink-terminal.js"
import type { PromptAutocompleteItem } from "./ui/components/prompt-input.js"
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
  .version("0.0.0")
  .action(async (promptParts: string[], options: { print?: string; continue?: boolean; newSession?: boolean; clear: boolean }) => {
    try {
      const config = await loadConfig()
      const cwd = process.cwd()
      const { SessionStore } = await import("./session/store.js")
      const store = SessionStore.open(cwd)
      store.deleteEmptySessions(cwd)
      const session = options.continue ? store.getOrCreateLatestSession(cwd) : store.createSession({ cwd, title: "New Chat" })
      const prompt = options.print || promptParts.join(" ")

      try {
        if (prompt.trim()) {
          await runSingleTurn({ config, cwd, prompt, sessionId: session.id, store })
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
  let skillCatalog = await loadSkills(input.cwd, { extraPaths: input.config.skillPaths })
  let queueCounter = 0
  let running = false
  let activeAbortController: AbortController | undefined
  let transientStatusTimer: ReturnType<typeof setTimeout> | undefined
  let transientStatusToken = 0
  const initialSession = input.store.getSession(sessionId)
  let terminal!: FurnaceTerminal
  const taskManager = new TaskManager({
    createChildTask: ({ description, parentSessionId, prompt }) => {
      const child = input.store.createSession({ cwd: input.cwd, parentSessionId, title: `${description} (subagent)` })
      permissions.inheritSession(child.id, parentSessionId)
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
    executeChildTask: (record, signal) => runSubagentTask({ config: input.config, cwd: input.cwd, permissions, record, signal, store: input.store, terminal }),
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
    onTaskBackground: () => {
      const promoted = taskManager.promoteActiveGroup(sessionId)
      showTransientStatus(promoted ? "Subagents moved to background. Furnace will continue once the task tool returns." : "No active foreground subagents to background.")
    },
    themeName: input.config.theme,
    title: initialSession.title,
    onSubmit: (prompt) => {
      void handleInteractiveSubmit(prompt).catch((error) => {
        running = false
        activeAbortController = undefined
        terminal.setBusy(false)
        terminal.setThinking(false)
        terminal.setTranscript([...entriesToTranscript(input.store.getActivePath(sessionId)), { role: "assistant", content: formatError(error) }])
      })
    },
  })
  terminal.setSlashCommandItems(slashAutocompleteItems(skillCatalog.skills))

  refreshCurrentSession()
  try {
    await terminal.run()
  } finally {
    clearTransientStatus()
    lofi.stop()
  }

  async function handleInteractiveSubmit(prompt: string): Promise<void> {
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
      if (command.name === "/reset-perms") {
        resetCurrentSessionPermissions()
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
    if (command.name === "/new") {
      clearTransientStatus()
      const session = input.store.getSession(sessionId)
      const next = session.activeLeafId ? input.store.createSession({ cwd: input.cwd, title: "New Chat" }) : session
      sessionId = next.id
      refreshCurrentSession()
      flushPendingBackgroundPrompts()
      return
    }
    if (command.name === "/reset-perms") {
      resetCurrentSessionPermissions()
      return
    }
    if (isHistoryCommand(command.name)) {
      const historyChoices = input.store.listSessions(input.cwd)
      if (historyChoices.length === 0) {
        terminal.setTitle("History")
        terminal.setTranscript([{ role: "assistant", content: "No saved conversations yet." }])
        return
      }
      terminal.showHistory(
        historyChoices,
        sessionId,
        (selectedSessionId) => {
          sessionId = selectedSessionId
          refreshCurrentSession()
          flushPendingBackgroundPrompts()
        },
        () => refreshCurrentSession(),
      )
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
    if (command.name === "/model") {
      terminal.setTitle("Model")
      terminal.setTranscript([{ role: "assistant", content: "Loading OpenRouter models..." }])
      const models = await listOpenRouterModels(input.config)
      terminal.showModelPicker(
        models,
        input.config.model,
        input.config.modelSettings,
        (model, settings, done) => {
          input.config.model = model
          input.config.modelSettings = settings
          terminal.setModel(model, settings)
          void saveModelPreferences(input.cwd, { model, modelSettings: settings }).catch((error) => {
            terminal.setTranscript([{ role: "assistant", content: `Failed to save model preference: ${formatError(error)}` }])
          })
          if (done) refreshCurrentSession()
        },
        () => refreshCurrentSession(),
      )
      return
    }
    if (command.name === "/theme") {
      if (command.argument) {
        await setThemeByName(command.argument)
        return
      }

      terminal.showThemePicker(
        themeChoices,
        resolveTheme(input.config.theme).name,
        (theme, done) => {
          input.config.theme = theme
          terminal.setTheme(theme)
          void saveThemePreference(input.cwd, theme).catch((error) => {
            terminal.setTranscript([{ role: "assistant", content: `Failed to save theme preference: ${formatError(error)}` }])
          })
          if (done) refreshCurrentSession()
        },
        () => refreshCurrentSession(),
      )
      return
    }

    clearTransientStatus()
    await runPromptQueue(prompt)
  }

  function showTransientStatus(content: string, ttlMs = 3000): void {
    clearTransientStatus()
    const token = ++transientStatusToken
    terminal.setTranscript([...entriesToTranscript(input.store.getActivePath(sessionId)), { role: "assistant", content }])
    transientStatusTimer = setTimeout(() => {
      if (token !== transientStatusToken) return
      transientStatusTimer = undefined
      terminal.setTranscript(entriesToTranscript(input.store.getActivePath(sessionId)))
    }, ttlMs)
    transientStatusTimer.unref?.()
  }

  function resetCurrentSessionPermissions(): void {
    const removed = permissions.clearSession(sessionId)
    showTransientStatus(removed > 0 ? `Reset ${removed} permission grant${removed === 1 ? "" : "s"} for this conversation.` : "No permission grants to reset for this conversation.")
  }

  function showTaskStatus(): void {
    const status = formatTaskStatusForUser(taskManager.status(sessionId).tasks)
    terminal.setTranscript([...entriesToTranscript(input.store.getActivePath(sessionId)), { role: "assistant", content: status }])
    terminal.setTasks(taskManager.status(sessionId).tasks)
  }

  async function setThemeByName(name: string): Promise<void> {
    const choice = findTheme(name)
    if (!choice) {
      terminal.setTranscript([{ role: "assistant", content: `Unknown theme: ${name}\nAvailable themes: ${themeChoices.map((theme) => theme.name).join(", ")}` }])
      return
    }
    input.config.theme = choice.name
    terminal.setTheme(choice.name)
    await saveThemePreference(input.cwd, choice.name)
    showTransientStatus(`Theme set to ${choice.name}.`)
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
    terminal.setSlashCommandItems(slashAutocompleteItems(skillCatalog.skills))
  }

  function clearTransientStatus(): void {
    transientStatusToken += 1
    if (!transientStatusTimer) return
    clearTimeout(transientStatusTimer)
    transientStatusTimer = undefined
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
    terminal.setTasks(taskManager.status(sessionId).tasks)
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

  async function runPromptQueue(firstPrompt: string | { hidden?: boolean; source?: string; text: string }): Promise<void> {
    const promptText = typeof firstPrompt === "string" ? firstPrompt : firstPrompt.text
    const hidden = typeof firstPrompt === "string" ? false : Boolean(firstPrompt.hidden)
    const source = typeof firstPrompt === "string" ? undefined : firstPrompt.source
    queuedPrompts.unshift({
      createdAt: Date.now(),
      hidden,
      id: `active-${Date.now()}-${queueCounter++}`,
      source,
      text: promptText,
    })
    if (running) return

    running = true
    terminal.setBusy(true)
    try {
      let firstPrompt = true
      while (queuedPrompts.length > 0) {
        if (!firstPrompt) await terminal.waitForInputFocus()
        firstPrompt = false
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
            permissions,
            prompt: next.text,
            sessionId,
            signal: controller.signal,
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
        }
      }
    } finally {
      running = false
      activeAbortController = undefined
      terminal.setBusy(false)
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
    if (command.name === "/reset-perms") {
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
  permissions?: SessionPermissionStore
  prompt: string
  sessionId: string
  signal?: AbortSignal
  store: SessionStore
  taskRunner?: TaskManager
  terminal?: FurnaceTerminal
}): Promise<void> {
  const permissions = input.permissions || new SessionPermissionStore()
  const taskRunner =
    input.taskRunner ||
    new TaskManager({
      createChildTask: ({ description, parentSessionId, prompt }) => {
        const child = input.store.createSession({ cwd: input.cwd, parentSessionId, title: `${description} (subagent)` })
        permissions.inheritSession(child.id, parentSessionId)
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
      executeChildTask: (record, signal) => runSubagentTask({ config: input.config, cwd: input.cwd, permissions, record, signal, store: input.store, terminal: input.terminal }),
    })

  input.store.appendMessage(input.sessionId, "user", input.prompt, input.hiddenUserMessage ? { hidden: true, source: input.hiddenUserMessageSource || "hidden_prompt" } : undefined)
  if (input.terminal) {
    input.terminal.clearToolActivities()
    input.terminal.setTranscript(entriesToTranscript(input.store.getActivePath(input.sessionId)))
    input.terminal.setThinking(true, "thinking")
  }
  if (!input.hiddenUserMessage) await maybeTitleSession(input.store, input.sessionId, input.config, input.prompt)
  input.terminal?.setTitle(input.store.getSession(input.sessionId).title)

  const activePath = input.store.getActivePath(input.sessionId)
  const transcript = entriesToTranscript(activePath)
  const skillCatalog = await loadSkills(input.cwd, { extraPaths: input.config.skillPaths })
  const messages: OpenRouterMessage[] = entriesToModelMessages(appendSkillGuidance(input.config.systemPrompt, skillCatalog.skills), activePath, { cwd: input.cwd })

  if (input.terminal) input.terminal.setTranscript(transcript)
  else renderAssistantStart(transcript)

  const toolActivities: ToolActivity[] = []
  const terminal = input.terminal
  const result = await runAgentTurn({
    config: input.config,
    cwd: input.cwd,
    fileReadStore: input.store,
    messages,
    onPermissionRequest: terminal
      ? async (request) => {
          terminal.setThinking(true, `waiting for ${request.toolName} approval`)
          const decision = await terminal.requestApproval(request)
          terminal.setThinking(true, "thinking")
          return decision
        }
      : undefined,
    onQuestionRequest: terminal
      ? async (request) => {
          terminal.setThinking(true, "waiting for your answer")
          const response = await terminal.requestQuestions(request)
          terminal.setThinking(true, "thinking")
          return response
        }
      : undefined,
    permissions,
    sessionId: input.sessionId,
    signal: input.signal,
    taskRunner,
    onToolStart: (call) => {
      input.store.appendToolCall(input.sessionId, {
        arguments: call.arguments,
        name: call.name,
        toolCallId: call.id,
      })
      toolActivities.push({ args: call.arguments, id: call.id, name: call.name, status: "running" })
      input.terminal?.setToolActivities([...toolActivities])
      input.terminal?.setThinking(true, `running ${call.name}`)
    },
    onToolResult: (call, content) => {
      input.store.appendToolResult(input.sessionId, {
        content,
        name: call.name,
        toolCallId: call.id,
      })
      const index = toolActivities.findIndex((activity) => activity.id === call.id)
      const status = content.startsWith(`Tool ${call.name} failed:`) || content.startsWith(`Tool ${call.name} denied:`) ? "failed" : "done"
      const activity = { args: call.arguments, id: call.id, name: call.name, result: content, status } satisfies ToolActivity
      if (index >= 0) toolActivities[index] = activity
      else toolActivities.push(activity)
      input.terminal?.setToolActivities([...toolActivities])
      input.terminal?.setThinking(true, "thinking")
    },
  })
  const assistantText = result.content

  input.store.appendMessage(input.sessionId, "assistant", assistantText, input.config.model)
  if (input.terminal) {
    input.terminal.setThinking(false)
    input.terminal.setTranscript(entriesToTranscript(input.store.getActivePath(input.sessionId)))
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
  terminal?: FurnaceTerminal
}): Promise<string> {
  const prompt = formatSubagentPrompt(input.record)
  input.store.appendMessage(input.record.childSessionId, "user", prompt)
  const skillCatalog = await loadSkills(input.cwd, { extraPaths: input.config.skillPaths })
  const messages: OpenRouterMessage[] = entriesToModelMessages(appendSkillGuidance(input.config.subagentSystemPrompt, skillCatalog.skills), input.store.getActivePath(input.record.childSessionId), { cwd: input.cwd })
  const terminal = input.terminal

  const result = await runAgentTurn({
    config: input.config,
    cwd: input.cwd,
    fileReadStore: input.store,
    messages,
    onPermissionRequest: terminal
      ? async (request) => {
          terminal.setThinking(true, `waiting for subagent ${request.toolName} approval`)
          const decision = await terminal.requestApproval(request)
          terminal.setThinking(true, "thinking")
          return decision
        }
      : undefined,
    onQuestionRequest: terminal
      ? async (request) => {
          terminal.setThinking(true, "waiting for your subagent answer")
          const response = await terminal.requestQuestions(request)
          terminal.setThinking(true, "thinking")
          return response
        }
      : undefined,
    permissions: input.permissions,
    sessionId: input.record.childSessionId,
    signal: input.signal,
    tools: childToolDefinitions,
    onToolStart: (call) => {
      input.store.appendToolCall(input.record.childSessionId, {
        arguments: call.arguments,
        name: call.name,
        toolCallId: call.id,
      })
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

function slashAutocompleteItems(skills: Skill[]): PromptAutocompleteItem[] {
  return [
    ...slashCommandDefinitions.map((command) => ({
      description: command.description,
      insertText: command.insertText,
      label: command.usage || command.name,
      value: command.name,
    })),
    ...skills.map((skill) => ({
      description: skill.description,
      insertText: `/skill:${skill.name} `,
      label: `/skill:${skill.name}`,
      value: `/skill:${skill.name}`,
    })),
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
