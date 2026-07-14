import { test } from "node:test"
import assert from "node:assert/strict"

const { createFurnaceTerminal, inputCursorStyleSequence } = await import("../../dist/ui/pi-terminal.js")
const { FooterComponent, formatContextDisplay } = await import("../../dist/ui/pi/components/footer.js")
const { CustomEditor } = await import("../../dist/ui/pi/components/custom-editor.js")
const { KeybindingsManager } = await import("../../dist/ui/pi/keybindings.js")
const { ToolExecutionComponent } = await import("../../dist/ui/pi/components/tool-execution.js")
const { LAYOUT_OPTIONS, LayoutHeaderComponent, LayoutTranscriptSurface } = await import("../../dist/ui/pi/layouts.js")
const { getEditorTheme, initTheme } = await import("../../dist/ui/pi/theme.js")
const { TUI, setKeybindings } = await import("@earendil-works/pi-tui")

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
    "setRepoIndexStatus",
    "setSlashCommandItems",
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

test("typing indicator preferences map to the user input cursor", () => {
  assert.equal(inputCursorStyleSequence("block", true), "\x1b[1 q")
  assert.equal(inputCursorStyleSequence("block", false), "\x1b[2 q")
  assert.equal(inputCursorStyleSequence("underscore", true), "\x1b[3 q")
  assert.equal(inputCursorStyleSequence("underscore", false), "\x1b[4 q")
  assert.equal(inputCursorStyleSequence("bar", true), "\x1b[5 q")
  assert.equal(inputCursorStyleSequence("bar", false), "\x1b[6 q")
})

test("disabled prompt input ignores edits until it is enabled again", () => {
  initTheme("default")
  const keybindings = KeybindingsManager.create()
  setKeybindings(keybindings)
  const editor = new CustomEditor(
    new TUI(createMockTerminal(), true),
    getEditorTheme(),
    keybindings,
  )

  editor.setInputDisabled(true)
  editor.handleInput("blocked")
  assert.equal(editor.getText(), "")

  editor.setInputDisabled(false)
  editor.handleInput("allowed")
  assert.equal(editor.getText(), "allowed")
})

test("escape interrupts a disabled prompt input", () => {
  initTheme("default")
  const keybindings = KeybindingsManager.create()
  setKeybindings(keybindings)
  const editor = new CustomEditor(
    new TUI(createMockTerminal(), true),
    getEditorTheme(),
    keybindings,
  )
  let interrupted = false
  editor.onEscape = () => {
    interrupted = true
  }

  editor.setInputDisabled(true)
  editor.handleInput("\x1b")

  assert.equal(interrupted, true)
})

test("backspace on a large paste offers expansion or whole-paste deletion", () => {
  initTheme("default")
  const keybindings = KeybindingsManager.create()
  setKeybindings(keybindings)
  const createEditor = () => new CustomEditor(
    new TUI(createMockTerminal(), true),
    getEditorTheme(),
    keybindings,
  )
  const pastedText = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n")

  const editEditor = createEditor()
  let editActions
  editEditor.onPasteMarkerBackspace = (actions) => {
    editActions = actions
  }
  editEditor.handleInput(`\x1b[200~${pastedText}\x1b[201~`)
  assert.match(editEditor.getText(), /^\[paste #1 \+12 lines\]$/)
  editEditor.handleInput("\x7f")
  assert.match(editEditor.getText(), /^\[paste #1 \+12 lines\]$/)
  editActions.editPaste()
  assert.equal(editEditor.getText(), pastedText)

  const deleteEditor = createEditor()
  let deleteActions
  deleteEditor.onPasteMarkerBackspace = (actions) => {
    deleteActions = actions
  }
  deleteEditor.handleInput(`\x1b[200~${pastedText}\x1b[201~`)
  deleteEditor.handleInput("\x7f")
  deleteActions.deletePaste()
  assert.equal(deleteEditor.getText(), "")
})

test("answered question cards keep the selected choices visible", () => {
  initTheme("default")
  const component = new ToolExecutionComponent(
    "ask_question",
    "call_question",
    { questions: [{ id: "color", prompt: "Which colors?", options: ["Red", "Blue"] }] },
    {},
    undefined,
    { requestRender: () => {} },
    "/tmp",
  )
  component.setArgsComplete()
  component.markExecutionStarted()
  component.updateResult({
    content: [{ type: "text", text: 'User answered the questions:\ncolor: user selected "Red"' }],
    isError: false,
  })

  const rendered = stripAnsi(component.render(100).join("\n"))
  assert.match(rendered, /✓ Asked 1 question/)
  assert.match(rendered, /Which colors\?/)
  assert.match(rendered, /\[x\] Red/)
  assert.match(rendered, /\[ \] Blue/)
})

test("edit tool calls render a diff from Furnace patch arguments", () => {
  initTheme("default")
  const component = new ToolExecutionComponent(
    "edit",
    "call_edit",
    {
      patch: `*** Begin Patch
*** Update File: src/example.ts
@@
-const status = "old"
+const status = "new"
*** Add File: src/new-file.ts
+export const ready = true
*** End Patch`,
    },
    {},
    undefined,
    { requestRender: () => {} },
    "/tmp",
  )

  component.setArgsComplete()
  component.markExecutionStarted()
  component.updateResult({
    content: [{ type: "text", text: "Updated src/example.ts (1 hunks)\nAdded src/new-file.ts" }],
    isError: false,
  })

  const rendered = stripAnsi(component.render(100).join("\n"))
  assert.match(rendered, /edit src\/example\.ts, src\/new-file\.ts/)
  assert.match(rendered, /-  const status = "old"/)
  assert.match(rendered, /\+  const status = "new"/)
  assert.match(rendered, /\+  export const ready = true/)
})

test("tool call summaries use Furnace argument names", () => {
  initTheme("default")
  const ui = { requestRender: () => {} }
  const find = new ToolExecutionComponent(
    "find",
    "call_find",
    { query: "session", path: "src", maxResults: 25 },
    {},
    undefined,
    ui,
    "/tmp",
  )
  const grep = new ToolExecutionComponent(
    "grep",
    "call_grep",
    { pattern: "TODO", path: "src", regex: false, maxResults: 10 },
    {},
    undefined,
    ui,
    "/tmp",
  )
  const bash = new ToolExecutionComponent(
    "bash",
    "call_bash",
    { command: "npm test", timeoutMs: 1500 },
    {},
    undefined,
    ui,
    "/tmp",
  )

  assert.match(stripAnsi(find.render(100).join("\n")), /find session in src \(limit 25\)/)
  assert.match(stripAnsi(grep.render(100).join("\n")), /grep TODO in src limit 10/)
  assert.match(stripAnsi(bash.render(100).join("\n")), /\$ npm test \(timeout 1\.5s\)/)
})

test("all terminal layouts have distinct structural headers", () => {
  initTheme("default")
  assert.deepEqual(LAYOUT_OPTIONS.map((option) => option.value), [
    "classic",
    "notebook",
    "console",
    "asteroid",
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
    const rendered = header.render(160).map(stripAnsi).join("\n")
    assert.match(rendered, /EARLY STAGES · OPEN AN ISSUE IF SOMETHING FEELS OFF/)
    assert.match(rendered, /https:\/\/github\.com\/amoreX\/furnace\/issues/)
    signatures.add(rendered)
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
