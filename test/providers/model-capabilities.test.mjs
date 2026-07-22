import assert from "node:assert/strict"
import { test } from "node:test"

const {
  isDeepSeekThinkingModel,
  shouldDisableThinkingForTools,
  shouldOmitToolChoice,
  supportsForcedToolChoice,
  wantsReasoningEffort,
} = await import("../../dist/providers/model-capabilities.js")

test("detects DeepSeek thinking model ids including openrouter prefixes", () => {
  assert.equal(isDeepSeekThinkingModel("deepseek-v4-flash"), true)
  assert.equal(isDeepSeekThinkingModel("deepseek-v4-pro"), true)
  assert.equal(isDeepSeekThinkingModel("deepseek/deepseek-v4-flash"), true)
  assert.equal(isDeepSeekThinkingModel("deepseek-reasoner"), true)
  assert.equal(isDeepSeekThinkingModel("deepseek-chat"), false)
  assert.equal(isDeepSeekThinkingModel("openai/gpt-4o"), false)
})

test("tool turns disable default V4 thinking unless reasoning is opted in", () => {
  assert.equal(shouldDisableThinkingForTools("deepseek-v4-flash", {}), true)
  assert.equal(shouldDisableThinkingForTools("deepseek-v4-flash", { reasoningEffort: "none" }), true)
  assert.equal(shouldDisableThinkingForTools("deepseek-v4-flash", { reasoningEffort: "high" }), false)
  assert.equal(shouldDisableThinkingForTools("gpt-4o", {}), false)
})

test("forced tool_choice is skipped while V4 thinking remains enabled", () => {
  assert.equal(supportsForcedToolChoice("deepseek-v4-flash", {}), true)
  assert.equal(supportsForcedToolChoice("deepseek-v4-flash", { reasoningEffort: "high" }), false)
  assert.equal(shouldOmitToolChoice("deepseek-v4-flash", { reasoningEffort: "high" }), true)
  assert.equal(shouldOmitToolChoice("deepseek-v4-flash", {}), false)
  assert.equal(wantsReasoningEffort({ reasoningEffort: "medium" }), true)
  assert.equal(wantsReasoningEffort({ reasoningEffort: "none" }), false)
})
