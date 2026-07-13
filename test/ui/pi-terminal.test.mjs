import { test } from "node:test"
import assert from "node:assert/strict"

const { createFurnaceTerminal } = await import("../../dist/ui/pi-terminal.js")
const { FooterComponent, formatContextDisplay } = await import("../../dist/ui/pi/components/footer.js")
const { LAYOUT_OPTIONS, LayoutHeaderComponent, LayoutTranscriptSurface } = await import("../../dist/ui/pi/layouts.js")
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
    "setLayout",
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

test("all terminal layouts have distinct structural headers", () => {
  initTheme("default")
  assert.deepEqual(LAYOUT_OPTIONS.map((option) => option.value), [
    "classic",
    "notebook",
    "console",
  ])

  let layout = "classic"
  const header = new LayoutHeaderComponent(() => ({
    cwd: "/tmp/furnace",
    layout,
    mode: "agent",
    model: "anthropic/claude",
    themeName: "Default",
    title: "Test Session",
    version: "0.1.9",
  }))
  const signatures = new Set()
  for (const option of LAYOUT_OPTIONS) {
    layout = option.value
    signatures.add(header.render(120).map(stripAnsi).join("\n"))
  }
  assert.equal(signatures.size, LAYOUT_OPTIONS.length)
})

test("all terminal layouts provide distinct empty-session guidance", () => {
  initTheme("default")
  let layout = "classic"
  const emptyTranscript = { invalidate: () => {}, render: () => [] }
  const surface = new LayoutTranscriptSurface(emptyTranscript, () => ({
    cwd: "/tmp/furnace",
    layout,
    mode: "agent",
    model: "anthropic/claude",
    themeName: "Default",
    title: "Test Session",
    version: "0.1.9",
  }))
  const signatures = new Set()
  for (const option of LAYOUT_OPTIONS) {
    layout = option.value
    const rendered = surface.render(100).map(stripAnsi).join("\n")
    assert.notEqual(rendered.trim(), "")
    signatures.add(rendered)
  }
  assert.equal(signatures.size, LAYOUT_OPTIONS.length)
})

test("terminal layouts can switch live without rebuilding terminal state", () => {
  const terminal = createFurnaceTerminal({
    cwd: "/tmp",
    layout: "classic",
    model: "openai/gpt-4o",
    modelSettings: {},
    onSubmit: () => {},
    terminal: createMockTerminal(),
    themeName: "default",
    title: "Test",
  })
  terminal.setTranscript([
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi there" },
  ])
  for (const option of LAYOUT_OPTIONS) {
    assert.doesNotThrow(() => terminal.setLayout(option.value))
  }
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
