import { test } from "node:test"
import assert from "node:assert/strict"
import { join } from "node:path"
import { homedir } from "node:os"
import { mkdir, rm, writeFile, stat } from "node:fs/promises"

const tmpHome = join(homedir(), ".furnace-test-providers-" + Date.now())

test("providers", async (t) => {
  process.env.HOME = tmpHome

  await t.test("loadCustomProviders returns empty array when file does not exist", async () => {
    const { loadCustomProviders } = await import("../dist/providers/custom.js")
    const result = await loadCustomProviders()
    assert.deepEqual(result, [])
  })

  await t.test("loadCustomProviders returns empty array on malformed JSON", async () => {
    const { mkdir } = await import("node:fs/promises")
    const { join } = await import("node:path")
    const { homedir } = await import("node:os")
    const { writeFile } = await import("node:fs/promises")
    const path = join(homedir(), ".furnace", "providers.json")
    await mkdir(join(homedir(), ".furnace"), { recursive: true })
    await writeFile(path, "not-json", "utf8")
    const { loadCustomProviders } = await import("../dist/providers/custom.js")
    const result = await loadCustomProviders()
    assert.deepEqual(result, [])
  })

  await t.test("saveCustomProviders writes file with mode 0600", async () => {
    const { saveCustomProviders } = await import("../dist/providers/custom.js")
    await saveCustomProviders([
      {
        id: "my-local-llm",
        displayName: "Local LLM",
        baseUrl: "http://localhost:11434/v1",
        protocol: "openai-compatible",
        apiKey: "test-key",
        models: [{ id: "llama-3.3-70b", displayName: "Llama 3.3 70B", contextLength: 131072 }],
      },
    ])
    const providersPath = join(tmpHome, ".furnace", "providers.json")
    const info = await stat(providersPath)
    assert.equal(info.mode & 0o777, 0o600)
  })

  await t.test("loadCustomProviders reads back saved providers", async () => {
    const { loadCustomProviders } = await import("../dist/providers/custom.js")
    const result = await loadCustomProviders()
    assert.equal(result.length, 1)
    assert.equal(result[0].id, "my-local-llm")
    assert.equal(result[0].baseUrl, "http://localhost:11434/v1")
    assert.equal(result[0].models?.length, 1)
  })

  await t.test("resolveProvider finds built-in provider", async () => {
    const { resolveProvider } = await import("../dist/providers/registry.js")
    const result = resolveProvider("openrouter", [])
    assert.ok(result)
    assert.equal(result.id, "openrouter")
    assert.equal(result.protocol, "openai-compatible")
  })

  await t.test("resolveProvider finds custom provider", async () => {
    const { resolveProvider } = await import("../dist/providers/registry.js")
    const custom = [
      { id: "my-custom", displayName: "Custom", baseUrl: "http://localhost:8080", protocol: "openai-compatible" },
    ]
    const result = resolveProvider("my-custom", custom)
    assert.ok(result)
    assert.equal(result.id, "my-custom")
    assert.equal(result.baseUrl, "http://localhost:8080")
  })

  await t.test("resolveProvider returns undefined for unknown provider", async () => {
    const { resolveProvider } = await import("../dist/providers/registry.js")
    const result = resolveProvider("nonexistent", [])
    assert.equal(result, undefined)
  })

  await t.test("resolveProvider strips apiKey from custom provider definition", async () => {
    const { resolveProvider } = await import("../dist/providers/registry.js")
    const custom = [
      { id: "my-custom", displayName: "Custom", baseUrl: "http://localhost:8080", protocol: "openai-compatible", apiKey: "secret-key" },
    ]
    const result = resolveProvider("my-custom", custom)
    assert.ok(result)
    assert.equal("apiKey" in result, false)
  })

  await t.test("BUILTIN_PROVIDERS includes all expected providers", async () => {
    const { BUILTIN_PROVIDERS } = await import("../dist/providers/registry.js")
    const ids = BUILTIN_PROVIDERS.map((p) => p.id)
    assert.ok(ids.includes("openrouter"))
    assert.ok(ids.includes("openai"))
    assert.ok(ids.includes("anthropic"))
    assert.ok(ids.includes("deepseek"))
    assert.ok(ids.includes("glm"))
  })

  await t.test("BUILTIN_PROVIDERS anthropic uses anthropic protocol", async () => {
    const { BUILTIN_PROVIDERS } = await import("../dist/providers/registry.js")
    const anthropic = BUILTIN_PROVIDERS.find((p) => p.id === "anthropic")
    assert.ok(anthropic)
    assert.equal(anthropic.protocol, "anthropic")
  })

  await rm(tmpHome, { recursive: true, force: true })
})
