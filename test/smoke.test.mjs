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
  assert.match(lines[0].text, /ok Edited docs\/design-choices\.md/)
  assert.equal(lines[3].text.trim(), "-old line")
  assert.equal(lines[4].text.trim(), "+new line")
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
  assert.equal(lines[0].text, "ok Asked 1 question")
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
  assert.equal(unanswered[2].description, "select at least one")

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
  assert.equal(answered[2].description, "next question")
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
