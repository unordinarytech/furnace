import { test } from "node:test"
import assert from "node:assert/strict"

const {
  getPiMarkdownTheme,
  getPiEditorTheme,
  getPiSelectListTheme,
  getPiSettingsListTheme,
} = await import("../../dist/ui/pi-themes.js")

const { resolveTheme, themeChoices } = await import("../../dist/ui/terminal-themes/index.js")

test("every shipped theme converts to a valid Pi markdown theme", () => {
  for (const choice of themeChoices) {
    const theme = resolveTheme(choice.name).theme
    const pi = getPiMarkdownTheme(theme)
    assert.ok(pi.heading("x").length > 0, `${choice.name}: heading missing`)
    assert.ok(pi.link("x").length > 0, `${choice.name}: link missing`)
    assert.ok(pi.code("x").length > 0, `${choice.name}: code missing`)
    assert.ok(pi.codeBlock("x").length > 0, `${choice.name}: codeBlock missing`)
    assert.ok(pi.quote("x").length > 0, `${choice.name}: quote missing`)
    assert.ok(pi.listBullet("x").length > 0, `${choice.name}: listBullet missing`)
    assert.ok(pi.bold("x").length > 0, `${choice.name}: bold missing`)
    assert.ok(pi.italic("x").length > 0, `${choice.name}: italic missing`)
    assert.ok(pi.hr("x").length > 0, `${choice.name}: hr missing`)
  }
})

test("select list theme has all required functions", () => {
  const theme = resolveTheme("default").theme
  const pi = getPiSelectListTheme(theme)
  assert.equal(typeof pi.selectedPrefix("x"), "string")
  assert.equal(typeof pi.selectedText("x"), "string")
  assert.equal(typeof pi.description("x"), "string")
  assert.equal(typeof pi.scrollInfo("x"), "string")
  assert.equal(typeof pi.noMatch("x"), "string")
})

test("editor theme has border color and select list", () => {
  const theme = resolveTheme("default").theme
  const pi = getPiEditorTheme(theme)
  assert.equal(typeof pi.borderColor("x"), "string")
  assert.equal(typeof pi.selectList.selectedText("x"), "string")
})

test("settings list theme has all required functions", () => {
  const theme = resolveTheme("default").theme
  const pi = getPiSettingsListTheme(theme)
  assert.equal(typeof pi.label("x", false), "string")
  assert.equal(typeof pi.label("x", true), "string")
  assert.equal(typeof pi.value("x", false), "string")
  assert.equal(typeof pi.description("x"), "string")
  assert.equal(typeof pi.hint("x"), "string")
  assert.equal(typeof pi.cursor, "string")
})
