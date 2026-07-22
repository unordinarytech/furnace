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

  await t.test("OpenRouter requests serialize cache-control hints", async () => {
    const { createOpenAICompatibleProvider } = await import("../dist/providers/openai-compatible.js")
    const originalFetch = globalThis.fetch
    let body
    globalThis.fetch = async (_url, init) => {
      body = JSON.parse(init.body)
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 })
    }
    try {
      const provider = createOpenAICompatibleProvider()
      await provider.completeChat(
        {
          id: "openrouter",
          displayName: "OpenRouter",
          baseUrl: "https://openrouter.ai/api/v1",
          protocol: "openai-compatible",
          apiKey: "fake-key",
        },
        "test-model",
        [
          { role: "system", content: "stable system", cacheControl: "ephemeral" },
          { role: "user", content: "cache this latest prompt" },
        ],
        {},
      )
      assert.deepEqual(body.messages[0].content, [{ type: "text", text: "stable system", cache_control: { type: "ephemeral" } }])
      assert.deepEqual(body.messages[1].content, [{ type: "text", text: "cache this latest prompt", cache_control: { type: "ephemeral" } }])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await t.test("OpenRouter prompt cache can be disabled by env var", async () => {
    const { createOpenAICompatibleProvider } = await import("../dist/providers/openai-compatible.js")
    const originalFetch = globalThis.fetch
    const originalDisable = process.env.FURNACE_DISABLE_PROMPT_CACHE
    let body
    globalThis.fetch = async (_url, init) => {
      body = JSON.parse(init.body)
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 })
    }
    process.env.FURNACE_DISABLE_PROMPT_CACHE = "1"
    try {
      const provider = createOpenAICompatibleProvider()
      await provider.completeChat(
        {
          id: "openrouter",
          displayName: "OpenRouter",
          baseUrl: "https://openrouter.ai/api/v1",
          protocol: "openai-compatible",
          apiKey: "fake-key",
        },
        "test-model",
        [
          { role: "system", content: "stable system", cacheControl: "ephemeral" },
          { role: "user", content: "do not cache this prompt" },
        ],
        {},
      )
      assert.deepEqual(body.messages, [
        { role: "system", content: "stable system" },
        { role: "user", content: "do not cache this prompt" },
      ])
    } finally {
      if (originalDisable === undefined) delete process.env.FURNACE_DISABLE_PROMPT_CACHE
      else process.env.FURNACE_DISABLE_PROMPT_CACHE = originalDisable
      globalThis.fetch = originalFetch
    }
  })

  await t.test("non-OpenRouter compatible requests strip cache-control hints", async () => {
    const { createOpenAICompatibleProvider } = await import("../dist/providers/openai-compatible.js")
    const originalFetch = globalThis.fetch
    let body
    globalThis.fetch = async (_url, init) => {
      body = JSON.parse(init.body)
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 })
    }
    try {
      const provider = createOpenAICompatibleProvider()
      await provider.completeChat(
        {
          id: "openai",
          displayName: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          protocol: "openai-compatible",
          apiKey: "fake-key",
        },
        "test-model",
        [
          { role: "system", content: "stable system", cacheControl: "ephemeral" },
          { role: "user", content: "plain user prompt" },
        ],
        {},
      )
      assert.deepEqual(body.messages[0], { role: "system", content: "stable system" })
      assert.deepEqual(body.messages[1], { role: "user", content: "plain user prompt" })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await t.test("DeepSeek replaces unsupported image blocks with text", async () => {
    const { createOpenAICompatibleProvider } = await import("../dist/providers/openai-compatible.js")
    const originalFetch = globalThis.fetch
    let body
    globalThis.fetch = async (_url, init) => {
      body = JSON.parse(init.body)
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 })
    }
    try {
      const provider = createOpenAICompatibleProvider()
      await provider.completeChat(
        {
          id: "deepseek",
          displayName: "DeepSeek",
          baseUrl: "https://api.deepseek.com/v1",
          protocol: "openai-compatible",
          apiKey: "fake-key",
        },
        "deepseek-chat",
        [{
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
            { type: "text", text: "explain this error" },
          ],
        }],
        {},
      )
      assert.deepEqual(body.messages[0].content, [
        { type: "text", text: "[Image omitted: the current provider or model does not support image input]" },
        { type: "text", text: "explain this error" },
      ])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await t.test("other compatible providers retry without images when a model rejects them", async () => {
    const { createOpenAICompatibleProvider } = await import("../dist/providers/openai-compatible.js")
    const originalFetch = globalThis.fetch
    const bodies = []
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(init.body))
      if (bodies.length === 1) {
        return new Response(JSON.stringify({
          error: { message: "unknown variant `image_url`, expected `text`" },
        }), { status: 400 })
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 })
    }
    try {
      const provider = createOpenAICompatibleProvider()
      const response = await provider.completeChat(
        {
          id: "custom-provider",
          displayName: "Custom provider",
          baseUrl: "https://example.test/v1",
          protocol: "openai-compatible",
          apiKey: "fake-key",
        },
        "text-only-model",
        [{
          role: "user",
          content: [
            { type: "text", text: "explain this" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
          ],
        }],
        {},
      )
      assert.equal(response, "ok")
      assert.equal(bodies.length, 2)
      assert.equal(bodies[0].messages[0].content[1].type, "image_url")
      assert.deepEqual(bodies[1].messages[0].content, [
        { type: "text", text: "explain this" },
        { type: "text", text: "[Image omitted: the current provider or model does not support image input]" },
      ])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await t.test("saveCustomProviders uses atomic write and leaves no temp files", async () => {
    const { readdir } = await import("node:fs/promises")
    const { saveCustomProviders } = await import("../dist/providers/custom.js")
    await saveCustomProviders([
      { id: "atomic-test", displayName: "Atomic", baseUrl: "http://localhost:9999", protocol: "openai-compatible" },
    ])
    const dir = join(tmpHome, ".furnace")
    const files = await readdir(dir)
    assert.ok(files.includes("providers.json"))
    assert.equal(files.filter((f) => f.endsWith(".tmp")).length, 0)
  })

  await t.test("concurrent saveCustomProviders calls do not lose data", async () => {
    const { saveCustomProviders, loadCustomProviders } = await import("../dist/providers/custom.js")
    await Promise.all([
      saveCustomProviders([{ id: "concurrent-a", displayName: "A", baseUrl: "http://a", protocol: "openai-compatible" }]),
      saveCustomProviders([{ id: "concurrent-b", displayName: "B", baseUrl: "http://b", protocol: "openai-compatible" }]),
      saveCustomProviders([{ id: "concurrent-c", displayName: "C", baseUrl: "http://c", protocol: "openai-compatible" }]),
    ])
    const result = await loadCustomProviders()
    assert.equal(result.length, 1)
    assert.ok(["concurrent-a", "concurrent-b", "concurrent-c"].includes(result[0].id))
  })

  await rm(tmpHome, { recursive: true, force: true })
})
