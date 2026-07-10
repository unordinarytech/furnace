import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

test("repo index offer is based on git repo and .furnace/repo-index.md existence", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "furnace-repo-index-"))
  try {
    const { repoIndexPath, shouldOfferRepoIndex } = await import("../dist/repo-index.js")

    assert.equal(await shouldOfferRepoIndex(cwd), false)

    await mkdir(join(cwd, ".git"), { recursive: true })
    assert.equal(await shouldOfferRepoIndex(cwd), true)

    await mkdir(join(cwd, ".furnace"), { recursive: true })
    await writeFile(repoIndexPath(cwd), "# Existing index\n", "utf8")
    assert.equal(await shouldOfferRepoIndex(cwd), false)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test("repo index staleness uses simple sidecar metadata", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "furnace-repo-index-meta-"))
  try {
    const { getRepoIndexStaleness, repoIndexMetaPath, repoIndexPath } = await import("../dist/repo-index.js")

    await mkdir(join(cwd, ".git"), { recursive: true })
    await mkdir(join(cwd, ".furnace"), { recursive: true })
    await writeFile(join(cwd, ".git", "HEAD"), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n", "utf8")
    await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "demo" }), "utf8")
    await writeFile(repoIndexPath(cwd), "# Existing index\n", "utf8")

    assert.deepEqual(await getRepoIndexStaleness(cwd), { reason: "metadata missing", stale: true })

    await writeFile(repoIndexMetaPath(cwd), `${JSON.stringify({
      fileCount: 1,
      generatedAt: "2026-07-10T00:00:00.000Z",
      gitHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      packageName: "demo",
    })}\n`, "utf8")
    assert.deepEqual(await getRepoIndexStaleness(cwd), { stale: false })

    await writeFile(join(cwd, ".git", "HEAD"), "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n", "utf8")
    assert.deepEqual(await getRepoIndexStaleness(cwd), { reason: "git commit changed", stale: true })
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test("repo index snapshot skips noisy dirs and secret-like files", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "furnace-repo-index-snapshot-"))
  try {
    await mkdir(join(cwd, ".git"), { recursive: true })
    await mkdir(join(cwd, "src"), { recursive: true })
    await mkdir(join(cwd, "node_modules", "pkg"), { recursive: true })
    await writeFile(join(cwd, "README.md"), "# Demo\n", "utf8")
    await writeFile(join(cwd, "src", "cli.ts"), "export {}\n", "utf8")
    await writeFile(join(cwd, ".env"), "TOKEN=secret\n", "utf8")
    await writeFile(join(cwd, "node_modules", "pkg", "index.js"), "module.exports = {}\n", "utf8")

    const { collectRepoIndexSnapshot } = await import("../dist/repo-index.js")
    const snapshot = await collectRepoIndexSnapshot(cwd)

    assert(snapshot.files.includes("README.md"))
    assert(snapshot.files.includes("src/cli.ts"))
    assert(!snapshot.files.includes(".env"))
    assert(!snapshot.files.some((file) => file.startsWith("node_modules/")))
    assert.equal(snapshot.snippets[0].path, "README.md")
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test("repo index model selector prefers fast provider-compatible models", async () => {
  const { selectRepoIndexModel } = await import("../dist/repo-index.js")
  const baseConfig = {
    model: "anthropic/claude-sonnet-4.6",
    provider: "openrouter",
    providerConfig: { defaultModel: "anthropic/claude-sonnet-4.6" },
    titleModel: "openai/gpt-4o-mini",
  }

  assert.equal(
    selectRepoIndexModel(baseConfig, [
      { id: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet" },
      { id: "anthropic/claude-haiku-4.5", name: "Claude Haiku 4.5" },
    ]),
    "anthropic/claude-haiku-4.5",
  )

  assert.equal(
    selectRepoIndexModel({ ...baseConfig, provider: "anthropic", providerConfig: { defaultModel: "claude-sonnet-4-6" } }, [
      { id: "claude-sonnet-4-6", name: "Claude Sonnet" },
      { id: "claude-haiku-4-5", name: "Claude Haiku" },
    ]),
    "claude-haiku-4-5",
  )

  assert.equal(
    selectRepoIndexModel({ ...baseConfig, provider: "openai", providerConfig: { defaultModel: "gpt-4.1" } }, [
      { id: "gpt-4.1", name: "GPT 4.1" },
      { id: "gpt-4o-mini", name: "GPT 4o mini" },
    ]),
    "gpt-4o-mini",
  )
})
