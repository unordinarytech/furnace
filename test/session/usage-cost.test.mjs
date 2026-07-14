import assert from "node:assert/strict"
import { test } from "node:test"

test("calculateUsageCostUsd computes provider pricing from token usage", async () => {
  const { calculateUsageCostUsd } = await import("../../dist/session/usage-cost.js")

  assert.equal(
    calculateUsageCostUsd(
      { promptTokens: 1000, completionTokens: 200 },
      { prompt: 0.000001, completion: 0.000002 },
    ),
    0.0014,
  )
  assert.equal(calculateUsageCostUsd({ promptTokens: 1000, completionTokens: 200 }, undefined), null)
})

test("summarizeUsageCosts totals cost and groups by provider", async () => {
  const { summarizeUsageCosts } = await import("../../dist/session/usage-cost.js")

  const summary = summarizeUsageCosts([
    {
      id: "entry-1",
      sessionId: "session-1",
      parentEntryId: null,
      type: "message",
      role: "assistant",
      createdAt: 1,
      data: {
        content: "first",
        usage: {
          cacheReadTokens: 50,
          cacheWriteTokens: 10,
          completionTokens: 20,
          costUsd: 0.001,
          promptTokens: 100,
          provider: "openrouter",
        },
      },
    },
    {
      id: "entry-2",
      sessionId: "session-1",
      parentEntryId: "entry-1",
      type: "message",
      role: "assistant",
      createdAt: 2,
      data: {
        content: "second",
        usage: {
          completionTokens: 5,
          costUsd: null,
          promptTokens: 30,
          provider: "anthropic",
        },
      },
    },
  ])

  assert.equal(summary.costUsd, 0.001)
  assert.equal(summary.unknownCostTurns, 1)
  assert.equal(summary.promptTokens, 130)
  assert.equal(summary.completionTokens, 25)
  assert.equal(summary.cacheReadTokens, 50)
  assert.deepEqual(summary.byProvider.map((provider) => provider.provider), ["openrouter", "anthropic"])
  assert.equal(summary.byProvider.find((provider) => provider.provider === "anthropic").unknownCostTurns, 1)
})
