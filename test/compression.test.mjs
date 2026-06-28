import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import assert from "node:assert/strict"
import { storeContextArtifact } from "../dist/compression/artifacts.js"
import { applyHeadroomLiteRequestTransforms } from "../dist/compression/request-transform.js"
import { compressToolOutput, detectContentKind } from "../dist/compression/router.js"

async function withWorkspace(fn) {
  const dir = await mkdtemp(join(tmpdir(), "furnace-compression-"))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test("content router detects common tool output shapes", () => {
  assert.equal(detectContentKind('[{"status":"error","message":"failed"}]'), "json")
  assert.equal(detectContentKind("diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new"), "diff")
  assert.equal(detectContentKind(Array.from({ length: 40 }, (_, i) => `src/a.ts:${i + 1}:match`).join("\n")), "search")
  assert.equal(detectContentKind("FAIL test\nError: expected true\n    at src/a.ts:1:1"), "log")
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
