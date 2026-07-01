import { readFile } from "node:fs/promises"
import { test } from "node:test"
import assert from "node:assert/strict"

test("project exposes the expected phase 0 commands", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))

  assert.equal(packageJson.bin.furnace, "./dist/cli.js")
  assert.match(packageJson.scripts.build, /\btsc -p tsconfig\.json\b/)
  assert.match(packageJson.scripts.build, /\besbuild src\/cli\.ts\b/)
  assert.match(packageJson.scripts.build, /--outfile=dist\/cli\.js/)
  assert.equal(packageJson.scripts.typecheck, "tsc -p tsconfig.json --noEmit")
})

test("local secrets are ignored", async () => {
  const gitignore = await readFile(new URL("../.gitignore", import.meta.url), "utf8")

  assert.match(gitignore, /^\.env$/m)
  assert.match(gitignore, /^\.env\.\*$/m)
  assert.match(gitignore, /^!\.env\.example$/m)
  assert.match(gitignore, /^\.furnace\/$/m)
})

test("termcn theme registry exposes all bundled themes", async () => {
  const { resolveTheme, themeChoices } = await import("../dist/ui/terminal-themes/index.js")
  const names = themeChoices.map((theme) => theme.name)

  assert.deepEqual(names, ["flexoki", "default", "dracula", "catppuccin", "tokyo-night", "nord", "rosepine", "gruvbox"])
  for (const name of names) {
    assert.equal(resolveTheme(name).name, name)
  }
  assert.equal(resolveTheme("tokyo night").name, "tokyo-night")

  const displayLabels = Object.fromEntries(themeChoices.map((theme) => [theme.name, theme.displayLabel]))
  assert.deepEqual(displayLabels, {
    flexoki: "Flexoki",
    default: "Default",
    dracula: "Dracula",
    catppuccin: "Catppuccin",
    "tokyo-night": "Tokyo Night",
    nord: "Nord",
    rosepine: "Rosé Pine",
    gruvbox: "Gruvbox",
  })
})

test("assistant markdown inline formatting is parsed for terminal rendering", async () => {
  const { parseInlineMarkdown } = await import("../dist/ui/ink-terminal.js")

  assert.deepEqual(parseInlineMarkdown("**File operations:** `read` and *search*"), [
    { kind: "bold", text: "File operations:" },
    { kind: "text", text: " " },
    { kind: "code", text: "read" },
    { kind: "text", text: " and " },
    { kind: "italic", text: "search" },
  ])
})

test("edit tool activity renders as a diff preview", async () => {
  const { formatToolActivity } = await import("../dist/ui/ink-terminal.js")
  const lines = formatToolActivity(
    {
      id: "call-1",
      name: "edit",
      status: "done",
      args: JSON.stringify({
        patch: `*** Begin Patch
*** Update File: docs/design-choices.md
@@
-old line
+new line
 context line
*** End Patch`,
      }),
      result: "Updated docs/design-choices.md (1 hunks)",
    },
    80,
  )

  assert.deepEqual(lines.map((line) => line.tone), ["summary", "meta", "meta", "deletion", "addition", "context"])
  assert.match(lines[0].text, /✓ Edited docs\/design-choices\.md/)
  assert.equal(lines[3].text.trim(), "-old line")
  assert.equal(lines[4].text.trim(), "+new line")
})

test("saved plan preview renders as a bordered block", async () => {
  const { planPreviewBoxLines } = await import("../dist/ui/ink-terminal.js")
  const lines = planPreviewBoxLines(".furnace/plans/example.md", "# Plan\n\n- Step one", 52)

  assert.equal(lines[0].tone, "border")
  assert.match(lines[0].text, /^\+ Saved Plan -+\+$/)
  assert.equal(lines[1].text, "Path: .furnace/plans/example.md")
  assert.equal(lines.some((line) => line.text.includes("# Plan") && line.tone === "content"), true)
  assert.equal(lines.at(-1).tone, "border")
})

test("ask_question tool activity renders questions and answers", async () => {
  const { formatToolActivity } = await import("../dist/ui/ink-terminal.js")
  const lines = formatToolActivity(
    {
      id: "call-question",
      name: "ask_question",
      status: "done",
      args: JSON.stringify({
        questions: [
          {
            id: "app_name",
            prompt: "What should the app be called?",
            options: [
              { id: "default", label: "damn-bro-whatever" },
              { id: "custom", label: "Custom" },
            ],
          },
        ],
      }),
      result: 'User answered the questions:\napp_name: user selected "damn-bro-whatever"',
    },
    100,
  )

  assert.deepEqual(lines.map((line) => line.tone), ["summary", "meta", "context", "addition"])
  assert.equal(lines[0].text, "✓ Asked 1 question")
  assert.match(lines[1].text, /What should the app be called/)
  assert.match(lines[2].text, /damn-bro-whatever/)
  assert.match(lines[3].text, /selected "damn-bro-whatever"/)
})

test("chat viewport reserves space above fixed input chrome", async () => {
  const { chatViewportRows } = await import("../dist/ui/ink-terminal.js")

  assert.equal(chatViewportRows(24), 13)
  assert.equal(chatViewportRows(24, 8), 5)
  assert.equal(chatViewportRows(8), 3)
})

test("approval prompt exposes scoped permission choices", async () => {
  const { approvalChoiceItems } = await import("../dist/ui/ink-terminal.js")
  const choices = approvalChoiceItems("bash")

  assert.deepEqual(
    choices.map((choice) => choice.value),
    ["allow_once", "allow_tool_session", "allow_all_session", "deny"],
  )
  assert.equal(choices[1].label, "Allow bash for conversation")
  assert.equal(choices[2].label, "Allow all tools for conversation")
})

test("question prompt exposes option, custom, and refusal choices", async () => {
  const { questionChoiceItems } = await import("../dist/ui/ink-terminal.js")
  const choices = questionChoiceItems({
    id: "scope",
    prompt: "Which scope?",
    allowCustom: true,
    allowMultiple: false,
    options: [{ id: "minimal", label: "Minimal", description: "smallest useful version" }],
  })

  assert.deepEqual(
    choices.map((choice) => choice.value),
    ["option:0", "custom", "refuse"],
  )
  assert.equal(choices[0].description, "smallest useful version")
})

test("multi-select question prompt exposes a guarded continue choice", async () => {
  const { questionChoiceItems } = await import("../dist/ui/ink-terminal.js")
  const unanswered = questionChoiceItems({
    id: "powers",
    prompt: "Which powers?",
    allowCustom: true,
    allowMultiple: true,
    options: [{ id: "flight", label: "Flying" }],
  })

  assert.deepEqual(
    unanswered.map((choice) => choice.value),
    ["option:0", "custom", "continue", "refuse"],
  )
  assert.equal(unanswered[2].disabled, true)
  assert.equal(unanswered[2].description, "Select at least one")

  const answered = questionChoiceItems(
    {
      id: "powers",
      prompt: "Which powers?",
      allowCustom: true,
      allowMultiple: true,
      options: [{ id: "flight", label: "Flying" }],
    },
    [{ questionId: "powers", kind: "option", optionId: "flight", answer: "Flying" }],
  )

  assert.equal(answered[2].disabled, false)
  assert.equal(answered[2].description, "Next question")
})

test("queued prompt previews truncate and track selected item", async () => {
  const { formatQueuedPromptPreview, queuedPromptPreviewItems } = await import("../dist/ui/ink-terminal.js")

  assert.equal(formatQueuedPromptPreview("one\n\n two   three", 20), "one two three")
  assert.equal(formatQueuedPromptPreview("a".repeat(80), 10), "aaaaaaaaa…")

  const previews = queuedPromptPreviewItems(
    [
      { id: "one", text: "first prompt", createdAt: 1 },
      { id: "two", text: "second prompt", createdAt: 2 },
      { id: "three", text: "third prompt", createdAt: 3 },
      { id: "four", text: "fourth prompt", createdAt: 4 },
    ],
    3,
    3,
  )
  assert.deepEqual(previews.map((item) => [item.id, item.selected]), [
    ["two", false],
    ["three", false],
    ["four", true],
  ])
})

test("slash autocomplete filters and inserts command text", async () => {
  const { applySlashAutocomplete, autocompleteWindow, slashAutocompleteMatches } = await import("../dist/ui/components/prompt-input.js")
  const { isKnownSlashCommand } = await import("../dist/commands.js")
  const items = [
    { label: "/model", value: "/model", description: "Select model" },
    { label: "/theme [name]", value: "/theme", insertText: "/theme ", description: "Select theme" },
    { label: "/skills reload", value: "/skills reload", description: "Reload skills" },
    { label: "/skills view <name>", value: "/skills view", insertText: "/skills view ", description: "View skill" },
  ]

  const rootMatches = slashAutocompleteMatches("/", 1, items)
  assert.deepEqual(rootMatches.map((item) => item.value), ["/model", "/theme", "/skills reload", "/skills view"])

  const filtered = slashAutocompleteMatches("/th", 3, items)
  assert.deepEqual(filtered.map((item) => [item.value, item.selected]), [["/theme", true]])
  assert.equal(applySlashAutocomplete("/th", 3, filtered[0]), "/theme ")
  assert.deepEqual(slashAutocompleteMatches("/theme", 6, items), [])
  assert.deepEqual(slashAutocompleteMatches("/theme flexoki", 14, items), [])
  const skillsReload = slashAutocompleteMatches("/skills r", 9, items)
  assert.deepEqual(skillsReload.map((item) => item.value), ["/skills reload"])
  assert.equal(applySlashAutocomplete("/skills r", 9, skillsReload[0]), "/skills reload")
  const skillsView = slashAutocompleteMatches("/skills v", 9, items)
  assert.deepEqual(skillsView.map((item) => item.value), ["/skills view"])
  assert.equal(applySlashAutocomplete("/skills v", 9, skillsView[0]), "/skills view ")
  assert.equal(isKnownSlashCommand("/resume"), true)
  assert.equal(isKnownSlashCommand("/history"), true)
  assert.equal(isKnownSlashCommand("/plan"), true)
  assert.equal(isKnownSlashCommand("/agent"), true)
  assert.equal(isKnownSlashCommand("/mode"), true)
  assert.equal(isKnownSlashCommand("/skills"), true)
  assert.equal(isKnownSlashCommand("/quit"), true)
  assert.equal(isKnownSlashCommand("/permissions"), true)
  assert.equal(isKnownSlashCommand("/reset-perms"), false)
  assert.equal(isKnownSlashCommand("/historu"), false)
  assert.equal(isKnownSlashCommand("/not-real"), false)

  const manyItems = Array.from({ length: 12 }, (_, index) => ({
    label: `/command-${index}`,
    value: `/command-${index}`,
    selected: index === 10,
  }))
  const window = autocompleteWindow(manyItems, 8)
  assert.equal(window.hiddenAbove > 0, true)
  assert.equal(window.visible.some((item) => item.value === "/command-10"), true)
  assert.equal(window.hiddenBelow, 0)
})

test("/resume is the primary history command name, with /history kept as an alias", async () => {
  const { isHistoryCommand } = await import("../dist/commands.js")

  assert.equal(isHistoryCommand("/resume"), true)
  assert.equal(isHistoryCommand("/history"), true)
  assert.equal(isHistoryCommand("/historu"), false)
  assert.equal(isHistoryCommand("/model"), false)
})

test("skill_manage tool activity renders proposed SKILL.md", async () => {
  const { formatToolActivity } = await import("../dist/ui/ink-terminal.js")
  const lines = formatToolActivity(
    {
      id: "call-skill-manage",
      name: "skill_manage",
      status: "running",
      args: JSON.stringify({
        name: "terminal-polish",
        description: "Improves terminal interface spacing.",
        body: "# Terminal Polish\n\nKeep panels readable.",
      }),
    },
    100,
  )

  assert.equal(lines[0].text, "◆ Create skill terminal-polish")
  assert.match(lines[1].text, /\.furnace\/skills\/terminal-polish\/SKILL\.md/)
  assert.equal(lines.some((line) => line.text.includes("disable-model-invocation: true") && line.tone === "addition"), true)
})

test("skill tool activity renders a clean used-skill line", async () => {
  const { formatToolActivity } = await import("../dist/ui/ink-terminal.js")
  const lines = formatToolActivity(
    {
      id: "call-skill",
      name: "skill",
      status: "done",
      args: JSON.stringify({ name: "ce-plan" }),
      result: '<skill_content name="ce-plan">...</skill_content>',
    },
    100,
  )

  assert.equal(lines.length, 1)
  assert.equal(lines[0].text, "✓ Used skill: ce-plan")
  assert.equal(lines[0].tone, "summary")
})

test("markdown tables render with aligned columns and no horizontal rules", async () => {
  const { buildTranscriptLinesForTest } = await import("../dist/ui/ink-terminal.js")
  const content = "Intro line\n\n---\n\n| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |"
  const lines = buildTranscriptLinesForTest([{ role: "assistant", content }], 80)

  assert.equal(lines.some((line) => line.kind === "table" && line.tableTone === "header" && /Name/.test(line.text) && /Age/.test(line.text)), true)
  assert.equal(lines.some((line) => line.kind === "table" && line.tableTone === "divider" && line.text.includes("┼")), true)
  assert.equal(lines.some((line) => line.kind === "table" && line.tableTone === "row" && /Alice/.test(line.text)), true)
  assert.equal(lines.some((line) => /^-{3,}$/.test(line.text.trim())), false)
})

test("fenced code blocks render as distinct lines without inline markdown parsing", async () => {
  const { buildTranscriptLinesForTest } = await import("../dist/ui/ink-terminal.js")
  const content = "Before text\n\n```ts\nconst x = *not italic*\nfunction f() {}\n```\n\nAfter text"
  const lines = buildTranscriptLinesForTest([{ role: "assistant", content }], 80)

  const openFence = lines.find((line) => line.kind === "code-fence" && line.codeFenceOpen)
  const closeFence = lines.find((line) => line.kind === "code-fence" && !line.codeFenceOpen)
  assert.ok(openFence)
  assert.ok(closeFence)
  assert.equal(openFence.text, "ts")

  const codeLines = lines.filter((line) => line.kind === "code")
  assert.equal(codeLines.length, 2)
  assert.equal(codeLines[0].text, "const x = *not italic*")
  assert.equal(codeLines[1].text, "function f() {}")

  assert.equal(lines.some((line) => line.kind === "content" && line.text === "Before text"), true)
  assert.equal(lines.some((line) => line.kind === "content" && line.text === "After text"), true)
})

test("unclosed fenced code blocks still render remaining lines as code", async () => {
  const { buildTranscriptLinesForTest } = await import("../dist/ui/ink-terminal.js")
  const content = "```python\nprint('hi')"
  const lines = buildTranscriptLinesForTest([{ role: "assistant", content }], 80)

  assert.equal(lines.some((line) => line.kind === "code-fence" && line.codeFenceOpen && line.text === "python"), true)
  assert.equal(lines.some((line) => line.kind === "code" && line.text === "print('hi')"), true)
})

test("task previews hide child session ids", async () => {
  const { taskPreviewItems } = await import("../dist/ui/ink-terminal.js")
  const previews = taskPreviewItems([
    {
      background: false,
      childSessionId: "ses_hidden",
      description: "Research quantum computing developments",
      id: "task_1",
      parentSessionId: "parent",
      prompt: "Research quantum computing developments",
      startedAt: 1,
      status: "running",
    },
  ])

  assert.equal(previews[0].text, "Research quantum computing developments")
  assert.doesNotMatch(previews[0].text, /ses_hidden/)
})

test("lofi mode exposes a terminal chibi animation and stream default", async () => {
  const { lofiChibiFrame } = await import("../dist/ui/components/prompt-input.js")
  const { defaultLofiStreamUrl } = await import("../dist/lofi.js")

  assert.notEqual(lofiChibiFrame(0), lofiChibiFrame(1))
  assert.match(lofiChibiFrame(0), /♪/)
  assert.match(defaultLofiStreamUrl, /^https:\/\//)
})
