import { test } from "node:test"
import assert from "node:assert/strict"
import { storeContextArtifact } from "../dist/compression/artifacts.js"
import { applyHeadroomLiteRequestTransforms } from "../dist/compression/request-transform.js"
import { compressToolOutput, detectContentKind } from "../dist/compression/router.js"
import { withTemporaryWorkspace } from "./helpers/workspace.mjs"

const withWorkspace = (fn) => withTemporaryWorkspace("furnace-compression-", fn)

test("content router detects common tool output shapes", () => {
  assert.equal(detectContentKind('[{"status":"error","message":"failed"}]'), "json")
  assert.equal(detectContentKind("diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new"), "diff")
  assert.equal(detectContentKind(Array.from({ length: 40 }, (_, i) => `src/a.ts:${i + 1}:match`).join("\n")), "search")
  assert.equal(detectContentKind("FAIL test\nError: expected true\n    at src/a.ts:1:1"), "log")
})

test("specialized compression enforces final body byte limits", async () => {
  await withWorkspace(async (cwd) => {
    const content = `FAIL\nError: ${"x".repeat(20_000)}`
    const artifact = await storeContextArtifact({ cwd, content })
    const result = compressToolOutput({ artifact, content, maxBytes: 512, maxLines: 10 })
    const body = result.content.split("\n\n").slice(1).join("\n\n")

    assert.ok(Buffer.byteLength(body, "utf8") <= 512)
    assert.match(result.content, new RegExp(artifact.id))
  })
})

test("json compression preserves error-like items and artifact retrieval hint", async () => {
  await withWorkspace(async (cwd) => {
    const content = JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ id: index, status: index === 88 ? "error" : "ok", message: index === 88 ? "payment failed" : "fine" })))
    const artifact = await storeContextArtifact({ cwd, content })
    const result = compressToolOutput({ artifact, content, maxBytes: 50_000, maxLines: 1000 })
    assert.equal(result.kind, "json")
    assert.match(result.content, /JSON array summary/)
    assert.match(result.content, /payment failed/)
    assert.ok(result.content.includes(`context_retrieve({"id":"${artifact.id}"})`))
  })
})

test("request transform compresses oversized historical tool messages only once", async () => {
  await withWorkspace(async (cwd) => {
    const huge = Array.from({ length: 1200 }, (_, index) => `ERROR repeated failure at file-${index}.ts:${index}:1`).join("\n")
    const messages = [
      { role: "system", content: "system" },
      { role: "tool", name: "bash", tool_call_id: "call_1", content: huge },
    ]
    const first = await applyHeadroomLiteRequestTransforms({ cwd, messages })
    assert.equal(first.stats.compressedToolResults, 1)
    assert.match(first.messages[1].content, /Tool output compressed \(Headroom-lite\)/)
    const second = await applyHeadroomLiteRequestTransforms({ cwd, messages: first.messages })
    assert.equal(second.stats.compressedToolResults, 0)
    assert.equal(second.messages[1].content, first.messages[1].content)
  })
})

test("request transform matures quiet read results into retrievable artifacts", async () => {
  await withWorkspace(async (cwd) => {
    const fullRead = Array.from({ length: 320 }, (_, index) => `${index + 1}|line ${index + 1}`).join("\n")
    const messages = [
      { role: "system", content: "system" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_read", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "src/large.ts" }) } }] },
      { role: "tool", name: "read", tool_call_id: "call_read", content: fullRead },
      { role: "user", content: "ok" },
      { role: "assistant", content: "noted" },
      { role: "user", content: "next" },
      { role: "assistant", content: "sure" },
      { role: "user", content: "continue" },
      { role: "assistant", content: "done" },
    ]

    const transformed = await applyHeadroomLiteRequestTransforms({ cwd, messages })

    assert.equal(transformed.stats.maturedReadResults, 1)
    assert.match(transformed.messages[2].content, /Read result matured \(Headroom-lite\)/)
    assert.match(transformed.messages[2].content, /Path: src\/large\.ts/)
    assert.match(transformed.messages[2].content, /Full read artifact: ctx_[a-f0-9]{24}/)
    assert.match(transformed.messages[2].content, /context_retrieve/)
  })
})
