#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { Command } from "commander"
import { argumentScopeFor, isHistoryCommand, isKnownSlashCommand, parseSlashCommand, slashCommandDefinitions } from "./commands.js"
import { loadConfig, type FurnaceConfig } from "./config.js"
import { LofiPlayer } from "./lofi.js"
import { listOpenRouterModels, type OpenRouterMessage, type OpenRouterModel, type OpenRouterToolDefinition } from "./openrouter.js"
import { SessionPermissionStore, type PermissionGrantSummary } from "./permissions.js"
import type { PermissionDecision, PermissionRequest } from "./permissions.js"
import { appendPlanModeGuidance, createPlanPath, currentPlanModeState, renderPlanExecutionPrompt, renderVisiblePlanArtifact, type AgentMode, type PlanModeEntryData } from "./plan-mode.js"
import { saveGlobalPreferences, saveModelPreferences, saveThemePreference, type FurnacePreferences, type ModelSettings, type StatusLinePreferences } from "./preferences.js"
import { compactSessionIfNeeded, estimateRequestTokens, resolveCompactionSettings, type CompactionReason } from "./session/compaction.js"
import { entriesToModelMessages, entriesToTranscript } from "./session/context.js"
import { fallbackTitle, generateSessionTitle } from "./session/title.js"
import type { SessionStore } from "./session/store.js"
import type { MessageEntryData, SessionRecord } from "./session/types.js"
import { loadCustomCommands, renderCustomCommandTemplate } from "./custom-commands/loader.js"
import type { CustomCommand } from "./custom-commands/types.js"
import { appendSkillGuidance, renderSkillInvocationMessage } from "./skills/context.js"
import { loadSkillByName, loadSkills } from "./skills/loader.js"
import type { Skill } from "./skills/types.js"
import { TaskManager, makeTaskId } from "./tasks/manager.js"
import type { TaskRecord } from "./tasks/types.js"
import { childToolDefinitions, toolDefinitions } from "./tools/registry.js"
import { createFurnaceTerminal, type FurnaceTerminal, type PinnedChatSummary, type QueuedPrompt, type ToolActivity } from "./ui/ink-terminal.js"
import type { PromptAutocompleteItem, PromptAutocompleteMatch } from "./ui/components/prompt-input.js"
import type { ImageAttachment } from "./utils/images.js"
import type { AskQuestionRequest, AskQuestionResponse } from "./questions.js"
import { findTheme, resolveTheme, themeChoices } from "./ui/terminal-themes/index.js"
import { renderError } from "./ui/terminal.js"
import { runInteractive, runPiped, runSingleTurn } from "./interactive-session-controller.js"

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
  .version("0.1.0-alpha.0")
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
      })
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

