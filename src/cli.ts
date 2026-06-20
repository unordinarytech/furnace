#!/usr/bin/env node

import { Command } from "commander"
import readline from "node:readline"
import { runAgentTurn } from "./agent/loop.js"
import { loadConfig } from "./config.js"
import { listOpenRouterModels, type OpenRouterMessage } from "./openrouter.js"
import { SessionPermissionStore } from "./permissions.js"
import { saveModelPreferences, saveThemePreference } from "./preferences.js"
import { entriesToModelMessages, entriesToTranscript } from "./session/context.js"
import { fallbackTitle, generateSessionTitle } from "./session/title.js"
import type { SessionStore } from "./session/store.js"
import { createFurnaceTerminal, type FurnaceTerminal, type QueuedPrompt, type ToolActivity } from "./ui/ink-terminal.js"
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
  const queuedPrompts: QueuedPrompt[] = []
  let queueCounter = 0
  let running = false
  let activeAbortController: AbortController | undefined
  const initialSession = input.store.getSession(sessionId)
  const terminal = createFurnaceTerminal({
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

  refreshInteractive(terminal, input.store, sessionId)
  await terminal.run()

  async function handleInteractiveSubmit(prompt: string): Promise<void> {
    const command = parseSlashCommand(prompt)

    if (command.name === "/exit" || command.name === "/quit") {
      activeAbortController?.abort()
      terminal.stop()
      return
    }
    if (running) {
      enqueuePrompt(prompt)
      return
    }
    if (command.name === "/new") {
      const session = input.store.getSession(sessionId)
      const next = session.activeLeafId ? input.store.createSession({ cwd: input.cwd, title: "New Chat" }) : session
      sessionId = next.id
      refreshInteractive(terminal, input.store, sessionId)
      return
    }
    if (command.name === "/reset-perms") {
      const removed = permissions.clearSession(sessionId)
      terminal.setTranscript([
        ...entriesToTranscript(input.store.getActivePath(sessionId)),
        { role: "assistant", content: removed > 0 ? `Reset ${removed} permission grant${removed === 1 ? "" : "s"} for this conversation.` : "No permission grants to reset for this conversation." },
      ])
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
          refreshInteractive(terminal, input.store, sessionId)
        },
        () => refreshInteractive(terminal, input.store, sessionId),
      )
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
          if (done) refreshInteractive(terminal, input.store, sessionId)
        },
        () => refreshInteractive(terminal, input.store, sessionId),
      )
      return
    }
    if (command.name === "/theme") {
      if (command.argument) {
        const choice = findTheme(command.argument)
        if (!choice) {
          terminal.setTranscript([{ role: "assistant", content: `Unknown theme: ${command.argument}\nAvailable themes: ${themeChoices.map((theme) => theme.name).join(", ")}` }])
          return
        }
        input.config.theme = choice.name
        terminal.setTheme(choice.name)
        await saveThemePreference(input.cwd, choice.name)
        terminal.setTranscript([{ role: "assistant", content: `Theme set to ${choice.name}.` }])
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
          if (done) refreshInteractive(terminal, input.store, sessionId)
        },
        () => refreshInteractive(terminal, input.store, sessionId),
      )
      return
    }

    await runPromptQueue(prompt)
  }

  function enqueuePrompt(text: string): void {
    queuedPrompts.push({
      createdAt: Date.now(),
      id: `queue-${Date.now()}-${queueCounter++}`,
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
    terminal.setQueuedPrompts([...queuedPrompts])
  }

  async function runPromptQueue(firstPrompt: string): Promise<void> {
    queuedPrompts.unshift({
      createdAt: Date.now(),
      id: `active-${Date.now()}-${queueCounter++}`,
      text: firstPrompt,
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
          await runSingleTurn({ config: input.config, cwd: input.cwd, permissions, prompt: next.text, sessionId, signal: controller.signal, store: input.store, terminal })
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
    await runSingleTurn({ config: input.config, cwd: process.cwd(), permissions, prompt, sessionId, store: input.store })
  }
}

async function runSingleTurn(input: {
  config: Awaited<ReturnType<typeof loadConfig>>
  cwd: string
  permissions?: SessionPermissionStore
  prompt: string
  sessionId: string
  signal?: AbortSignal
  store: SessionStore
  terminal?: FurnaceTerminal
}): Promise<void> {
  input.store.appendMessage(input.sessionId, "user", input.prompt)
  if (input.terminal) {
    input.terminal.clearToolActivities()
    input.terminal.setTranscript(entriesToTranscript(input.store.getActivePath(input.sessionId)))
    input.terminal.setThinking(true, "thinking")
  }
  await maybeTitleSession(input.store, input.sessionId, input.config, input.prompt)
  input.terminal?.setTitle(input.store.getSession(input.sessionId).title)

  const activePath = input.store.getActivePath(input.sessionId)
  const transcript = entriesToTranscript(activePath)
  const messages: OpenRouterMessage[] = entriesToModelMessages(input.config.systemPrompt, activePath, { cwd: input.cwd })

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
    permissions: input.permissions || new SessionPermissionStore(),
    sessionId: input.sessionId,
    signal: input.signal,
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

type ParsedPrompt = {
  argument: string
  name: string
}

function parseSlashCommand(prompt: string): ParsedPrompt {
  if (!prompt.startsWith("/")) return { argument: "", name: prompt }
  const [name = "", ...rest] = prompt.slice(1).trim().split(/\s+/)
  return { argument: rest.join(" ").trim(), name: `/${name.toLowerCase()}` }
}

function isHistoryCommand(command: string): boolean {
  return command === "/history" || command === "/historu"
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
