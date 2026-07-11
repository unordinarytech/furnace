import { test } from "node:test"
import assert from "node:assert/strict"

const { createFurnaceTerminal } = await import("../../dist/ui/pi-terminal.js")
const { FooterComponent, formatContextDisplay } = await import("../../dist/ui/pi/components/footer.js")
const { initTheme } = await import("../../dist/ui/pi/theme.js")

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-9;]*m/g, "")
}

function createMockTerminal() {
  return {
    start: () => {},
    stop: () => {},
    drainInput: async () => {},
    write: () => {},
    moveBy: () => {},
    hideCursor: () => {},
    showCursor: () => {},
    clearLine: () => {},
    clearFromCursor: () => {},
    clearScreen: () => {},
    setTitle: () => {},
    setProgress: () => {},
    get columns() { return 80 },
    get rows() { return 24 },
    get kittyProtocolActive() { return false },
  }
}

test("createFurnaceTerminal returns all required FurnaceTerminal methods", () => {
  const terminal = createFurnaceTerminal({
    cwd: "/tmp",
    model: "openai/gpt-4o",
    modelSettings: {},
    onSubmit: () => {},
    terminal: createMockTerminal(),
    themeName: "default",
    title: "Test",
  })

  const required = [
    "clearInteractionPrompts",
    "clearToolActivities",
    "clearPlanActions",
    "requestQuestions",
    "requestApproval",
    "showQuestionPrompt",
    "showApprovalPrompt",
    "run",
    "stop",
    "waitForInputFocus",
    "setBusy",
    "setContextUsage",
    "setCostUsage",
    "setInputDraft",
    "setInputDisabled",
    "setStatusLinePreferences",
    "setSessionMeta",
    "setLofi",
    "setMode",
    "setThinking",
    "setQueuedPrompts",
    "setSlashCommandItems",
    "setTasks",
    "showModelEditor",
    "showPermissions",
    "showPlanActions",
    "showSettings",
    "showApiKeySetup",
    "showProviderSelector",
    "setModel",
    "setTheme",
    "setTitle",
    "setToolActivities",
    "clearTranscriptDisplay",
    "setStreamingContent",
    "setStatusNotice",
    "setTranscript",
    "suspendForEditor",
    "insertImageAttachment",
  ]

  for (const method of required) {
    assert.equal(typeof terminal[method], "function", `missing method: ${method}`)
  }
})

test("setTranscript and setStreamingContent do not throw", () => {
  const terminal = createFurnaceTerminal({
    cwd: "/tmp",
    model: "openai/gpt-4o",
    modelSettings: {},
    onSubmit: () => {},
    terminal: createMockTerminal(),
    themeName: "default",
    title: "Test",
  })

  assert.doesNotThrow(() => {
    terminal.setTranscript([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ])
    terminal.setStreamingContent("streaming...")
  })
})

test("footer context display follows Furnace status mode", () => {
  assert.equal(formatContextDisplay({}, 10_600, 272_000, "3.9"), "10.6K/272K")
  assert.equal(formatContextDisplay({ statusContextMode: "tokens-percent" }, 10_600, 272_000, "3.9"), "10.6K/272K (3.9%)")
  assert.equal(formatContextDisplay({ statusContextMode: "percent" }, 10_600, 272_000, "3.9"), "3.9%")
  assert.equal(formatContextDisplay({ statusContextMode: "off" }, 10_600, 272_000, "3.9"), undefined)
})

function createFooterFixture() {
  initTheme("default")
  const session = {
    state: {
      configuredContextWindow: 128_000,
      fast: true,
      forkParentTitle: "Parent Chat",
      mode: "plan",
      model: { id: "gpt-5.5", name: "GPT-5.5", provider: "openai", contextWindow: 272_000, reasoning: true },
      themeName: "Default",
      thinkingLevel: "off",
    },
    sessionManager: {
      getCwd: () => "/tmp/furnace",
      getEntries: () => [{
        type: "message",
        message: {
          role: "assistant",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1234 } },
        },
      }],
      getSessionName: () => "New Chat",
    },
    modelRegistry: { isUsingOAuth: () => false },
    getContextUsage: () => ({ tokens: 10_600, contextWindow: 272_000, percent: 3.9 }),
  }
  const footerData = {
    getAvailableProviderCount: () => 1,
    getExtensionStatuses: () => new Map([["mode", "plan mode"]]),
    getGitBranch: () => "main",
  }
  return { session, footerData }
}

test("footer status toggles show configured status parts", () => {
  const { session, footerData } = createFooterFixture()
  const footer = new FooterComponent(session, footerData, {})

  const rendered = footer.render(160).map(stripAnsi).join("\n")
  for (const visible of ["Furnace", "/tmp/furnace", "main", "New Chat", "$0.1234", "10.6K/272K", "mode: plan", "window: 128K", "reasoning: none", "fast", "theme: Default", "GPT-5.5", "fork of: Parent Chat"]) {
    assert.equal(rendered.includes(visible), true, `expected footer to show ${visible}`)
  }
})

test("footer status toggles hide configured status parts", () => {
  const { session, footerData } = createFooterFixture()
  const footer = new FooterComponent(session, footerData, {
    statusShowAppName: false,
    statusShowCost: false,
    statusShowCwd: false,
    statusShowFast: false,
    statusShowForkParent: false,
    statusShowMode: false,
    statusShowModel: false,
    statusShowReasoning: false,
    statusShowTheme: false,
    statusShowTitle: false,
    statusShowWindow: false,
  })

  const rendered = footer.render(120).map(stripAnsi).join("\n")
  for (const hidden of ["Furnace", "/tmp/furnace", "main", "New Chat", "$0.1234", "GPT-5.5", "reasoning:", "mode:", "plan mode", "window:", "fast", "theme:", "Parent Chat"]) {
    assert.equal(rendered.includes(hidden), false, `expected footer to hide ${hidden}`)
  }
  assert.equal(rendered.includes("10.6K/272K"), true)
})
