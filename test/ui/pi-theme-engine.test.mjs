import { test } from "node:test"
import assert from "node:assert/strict"

const {
  initTheme,
  setTheme,
  getThemeByName,
  getAvailableThemes,
  theme,
  getMarkdownTheme,
  getSelectListTheme,
  getEditorTheme,
  getSettingsListTheme,
} = await import("../../dist/ui/pi/theme.js")

const { themeChoices } = await import("../../dist/ui/themes/index.js")

test("every shipped furnace theme maps into the pi theme engine", () => {
  for (const choice of themeChoices) {
    const loaded = getThemeByName(choice.name)
    assert.ok(loaded, `${choice.name}: theme did not load`)
    assert.ok(loaded.fg("accent", "x").length > 1, `${choice.name}: accent missing`)
    assert.ok(loaded.fg("mdHeading", "x").length > 1, `${choice.name}: mdHeading missing`)
    assert.ok(loaded.fg("syntaxKeyword", "x").length > 1, `${choice.name}: syntaxKeyword missing`)
    assert.ok(loaded.bg("userMessageBg", "x").length > 1, `${choice.name}: userMessageBg missing`)
    assert.ok(loaded.bg("toolPendingBg", "x").length > 1, `${choice.name}: toolPendingBg missing`)
    assert.ok(loaded.getThinkingBorderColor("high")("x").length > 1, `${choice.name}: thinking border missing`)
  }
})

test("global theme proxy resolves after initTheme and switches with setTheme", () => {
  initTheme("pi-dark")
  const dark = theme.fg("accent", "x")
  assert.ok(dark.includes("x"))

  const result = setTheme("dracula")
  assert.equal(result.success, true)
  const dracula = theme.fg("accent", "x")
  assert.ok(dracula.includes("x"))
  assert.notEqual(dark, dracula, "accent color should change between themes")

  assert.equal(setTheme("not-a-theme").success, false)
})

test("markdown, select-list, editor, and settings-list themes are complete", () => {
  initTheme("pi-dark")

  const md = getMarkdownTheme()
  for (const key of ["heading", "link", "linkUrl", "code", "codeBlock", "codeBlockBorder", "quote", "quoteBorder", "hr", "listBullet", "bold", "italic"]) {
    assert.equal(typeof md[key]("x"), "string", `markdown theme missing ${key}`)
  }
  assert.ok(Array.isArray(md.highlightCode("const a = 1", "typescript")))

  const select = getSelectListTheme()
  for (const key of ["selectedPrefix", "selectedText", "description", "scrollInfo", "noMatch"]) {
    assert.equal(typeof select[key]("x"), "string", `select list theme missing ${key}`)
  }

  const editor = getEditorTheme()
  assert.equal(typeof editor.borderColor("x"), "string")
  assert.ok(editor.selectList)

  const settings = getSettingsListTheme()
  assert.equal(typeof settings.label("x", true), "string")
  assert.equal(typeof settings.value("x", false), "string")
  assert.equal(typeof settings.cursor, "string")
})

test("theme registry lists every furnace theme", () => {
  const names = getAvailableThemes()
  assert.ok(names.includes("pi-dark"))
  assert.ok(names.length >= 30)
})
