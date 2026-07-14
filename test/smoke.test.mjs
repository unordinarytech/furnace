import { readFile } from "node:fs/promises"
import { test } from "node:test"
import assert from "node:assert/strict"

test("project exposes the expected phase 0 commands", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))

  assert.equal(packageJson.bin.furnace, "./dist/cli.js")
  assert.match(packageJson.scripts.build, /\btsc -p tsconfig\.json\b/)
  assert.match(packageJson.scripts.build, /\besbuild src\/cli\.ts\b/)
  assert.match(packageJson.scripts.build, /--outfile=dist\/cli\.js/)
  assert.match(packageJson.scripts.typecheck, /tsc -p tsconfig\.json --noEmit/)
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

  // pi-dark is the default (first entry) to match Pi's exact palette
  assert.equal(names[0], "pi-dark")
  assert.equal(resolveTheme(undefined).name, "pi-dark")

  // Core hand-crafted themes must be present
  const core = ["pi-dark", "synthwave-84", "space", "flexoki", "default", "dracula", "catppuccin", "tokyo-night", "nord", "rosepine", "gruvbox"]
  for (const name of core) {
    assert.equal(resolveTheme(name).name, name)
  }
  // Total should include all bundled hand-crafted themes
  assert.ok(themeChoices.length >= 30, `expected 30+ themes, got ${themeChoices.length}`)
  assert.equal(resolveTheme("tokyo night").name, "tokyo-night")
})
