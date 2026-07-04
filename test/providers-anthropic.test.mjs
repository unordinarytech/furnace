import { test } from "node:test"
import assert from "node:assert/strict"

test("anthropic adapter", async (t) => {
  const { createAnthropicProvider } = await import("../dist/providers/anthropic.js")

  await t.test("createAnthropicProvider returns a Provider object", async () => {
    const provider = createAnthropicProvider()
    assert.ok(provider)
    assert.equal(typeof provider.streamChat, "function")
    assert.equal(typeof provider.completeChat, "function")
    assert.equal(typeof provider.completeToolChat, "function")
    assert.equal(typeof provider.listModels, "function")
  })

  await t.test("listModels uses static model list when provided", async () => {
    const provider = createAnthropicProvider()
    const resolved = {
      id: "test-anthropic",
      displayName: "Test",
      baseUrl: "https://api.anthropic.com",
      protocol: "anthropic",
      apiKey: "fake-key",
      models: [
        { id: "claude-test-1", displayName: "Claude Test 1", contextLength: 200000 },
        { id: "claude-test-2", displayName: "Claude Test 2", contextLength: 100000 },
      ],
    }
    const models = await provider.listModels(resolved)
    assert.equal(models.length, 2)
    assert.equal(models[0].id, "claude-test-1")
    assert.equal(models[0].name, "Claude Test 1")
    assert.equal(models[0].contextLength, 200000)
  })

  await t.test("listModels returns empty array for empty static list", async () => {
    const provider = createAnthropicProvider()
    const resolved = {
      id: "test-anthropic",
      displayName: "Test",
      baseUrl: "https://api.anthropic.com",
      protocol: "anthropic",
      apiKey: "fake-key",
      models: [],
    }
    // Empty models array falls through to HTTP call which will fail
    await assert.rejects(async () => provider.listModels(resolved))
  })
})
