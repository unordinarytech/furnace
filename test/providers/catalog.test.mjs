import assert from "node:assert/strict"
import test from "node:test"

const { modelsForProvider } = await import("../../dist/providers/catalog.js")

test("model lists include only the active provider", () => {
  const models = [
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", providerId: "deepseek", providerLabel: "DeepSeek" },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", providerId: "deepseek", providerLabel: "DeepSeek" },
    { id: "anthropic/claude-haiku", name: "Claude Haiku", providerId: "openrouter", providerLabel: "OpenRouter" },
  ]

  assert.deepEqual(
    modelsForProvider(models, "deepseek").map((model) => model.id),
    ["deepseek-v4-flash", "deepseek-v4-pro"],
  )
  assert.deepEqual(modelsForProvider(models, "anthropic"), [])
})
