import assert from "node:assert/strict"
import { test } from "node:test"
import { runAgentTurn, shouldForceWebSearch } from "../dist/agent/loop.js"

test("current information prompts force websearch", () => {
  assert.equal(shouldForceWebSearch([{ role: "user", content: "latest FIFA news" }]), true)
  assert.equal(shouldForceWebSearch([{ role: "user", content: "what is the current Node.js release?" }]), true)
})

test("local repo prompts do not force websearch", () => {
  assert.equal(shouldForceWebSearch([{ role: "user", content: "latest changes in this repo" }]), false)
  assert.equal(shouldForceWebSearch([{ role: "user", content: "current git status" }]), false)
})

test("agent turn compacts and retries once after context overflow", async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  let recovered = 0

  try {
    globalThis.fetch = async () => {
      calls += 1
      if (calls === 1) {
        return {
          ok: false,
          status: 400,
          statusText: "Bad Request",
          async text() {
            return "maximum context length exceeded"
          },
        }
      }
      const sseData = 'data: {"choices":[{"delta":{"content":"done"},"finish_reason":null}]}\ndata: [DONE]\n'
      let consumed = false
      return {
        ok: true,
        body: {
          getReader() {
            return {
              read() {
                if (consumed) return Promise.resolve({ done: true, value: undefined })
                consumed = true
                return Promise.resolve({ done: false, value: new TextEncoder().encode(sseData) })
              },
              releaseLock() {},
            }
          },
        },
      }
    }

    const result = await runAgentTurn({
      config: fakeConfig(),
      cwd: "/tmp/furnace",
      messages: [{ role: "user", content: "hello" }],
      onContextOverflow: async () => {
        recovered += 1
        return [{ role: "user", content: "compacted hello" }]
      },
      tools: [],
    })

    assert.equal(result.content, "done")
    assert.equal(calls, 2)
    assert.equal(recovered, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

function fakeConfig() {
  return {
    appName: "Furnace Test",
    model: "test-model",
    modelSettings: {},
    provider: "openrouter",
    apiKey: "test-key",
    openRouterApiKey: "test-key",
    providerConfig: {
      id: "openrouter",
      displayName: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      protocol: "openai-compatible",
      apiKey: "test-key",
      siteUrl: "http://localhost",
      appName: "Furnace Test",
    },
    siteUrl: "http://localhost",
    skillPaths: [],
    subagentSystemPrompt: "subagent",
    systemPrompt: "system",
    theme: "flexoki",
    titleModel: "title-model",
    titleSystemPrompt: "title",
  }
}
