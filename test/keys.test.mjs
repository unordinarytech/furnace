import { after, before, describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("key storage", async () => {
  let tmpHome
  let originalHome

  before(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "furnace-keys-test-"))
    originalHome = process.env.HOME
    process.env.HOME = tmpHome
  })

  after(async () => {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    await rm(tmpHome, { recursive: true, force: true })
  })

  it("getStoredKey returns undefined when file does not exist", async () => {
    const { getStoredKey } = await import("../dist/keys.js")
    const result = await getStoredKey("openrouter")
    assert.equal(result, undefined)
  })

  it("setStoredKey creates file and round-trips through getStoredKey", async () => {
    const { setStoredKey, getStoredKey } = await import("../dist/keys.js")
    await setStoredKey("openrouter", "sk-test-123")
    const result = await getStoredKey("openrouter")
    assert.equal(result, "sk-test-123")
  })

  it("auth.json is written with mode 0600", async () => {
    const { setStoredKey } = await import("../dist/keys.js")
    await setStoredKey("openrouter", "sk-perm-test")
    const keysPath = join(tmpHome, ".furnace", "auth.json")
    const info = await stat(keysPath)
    assert.equal(info.mode & 0o777, 0o600)
  })

  it("setStoredKey merges rather than replacing existing keys", async () => {
    const { setStoredKey, loadStoredKeys } = await import("../dist/keys.js")
    await setStoredKey("openrouter", "sk-or")
    await setStoredKey("anthropic", "sk-ant")
    const keys = await loadStoredKeys()
    assert.equal(keys.openrouter, "sk-or")
    assert.equal(keys.anthropic, "sk-ant")
  })

  it("concurrent key saves do not overwrite another provider", async () => {
    const { setStoredKey, loadStoredKeys } = await import("../dist/keys.js")
    await Promise.all([
      setStoredKey("openrouter", "sk-or-concurrent"),
      setStoredKey("anthropic", "sk-ant-concurrent"),
      setStoredKey("custom", "sk-custom-concurrent"),
    ])
    const keys = await loadStoredKeys()
    assert.equal(keys.openrouter, "sk-or-concurrent")
    assert.equal(keys.anthropic, "sk-ant-concurrent")
    assert.equal(keys.custom, "sk-custom-concurrent")
  })

  it("removeStoredKey deletes only the selected provider", async () => {
    const { setStoredKey, getStoredKey, removeStoredKey } = await import("../dist/keys.js")
    await setStoredKey("openrouter", "sk-or-delete")
    await setStoredKey("anthropic", "sk-ant-keep")
    assert.equal(await removeStoredKey("openrouter"), true)
    assert.equal(await getStoredKey("openrouter"), undefined)
    assert.equal(await getStoredKey("anthropic"), "sk-ant-keep")
    assert.equal(await removeStoredKey("openrouter"), false)
  })

  it("loadStoredKeys returns empty object on malformed JSON", async () => {
    const { homedir } = await import("node:os")
    const { join } = await import("node:path")
    const { mkdir, writeFile } = await import("node:fs/promises")
    const path = join(homedir(), ".furnace", "auth.json")
    await mkdir(join(homedir(), ".furnace"), { recursive: true })
    await writeFile(path, "not-json", "utf8")
    const { loadStoredKeys } = await import("../dist/keys.js")
    const result = await loadStoredKeys()
    assert.deepEqual(result, {})
  })

  it("resolveKeyValue returns literal string unchanged", async () => {
    const { resolveKeyValue } = await import("../dist/keys.js")
    assert.equal(resolveKeyValue("sk-literal-key"), "sk-literal-key")
  })

  it("resolveKeyValue executes !cmd and returns trimmed stdout", async () => {
    const { resolveKeyValue } = await import("../dist/keys.js")
    const result = resolveKeyValue("!echo sk-from-cmd")
    assert.equal(result, "sk-from-cmd")
  })

  it("resolveKeyValue returns undefined for a failing command", async () => {
    const { resolveKeyValue } = await import("../dist/keys.js")
    const result = resolveKeyValue("!exit 1")
    assert.equal(result, undefined)
  })
})
