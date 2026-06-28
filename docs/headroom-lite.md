# Headroom-lite Context Compression

Furnace adapts a small, local-first subset of [Headroom](https://github.com/chopratejas/headroom)'s context-compression design. The goal is not to clone Headroom's Python/Rust proxy, ML compressors, or provider-specific wrapper stack. The goal is to keep Furnace's coding-agent context smaller by compressing the tool outputs that most often explode a session: logs, search results, diffs, JSON, and large generic text.

## Why this exists

Coding agents spend context on tool results. A failed test run, `grep` across a repo, large JSON response, or long web page can be thousands of lines. Plain head/tail truncation often loses the exact failure or anomaly the model needed.

Headroom's useful lesson for Furnace is:

1. classify content before shrinking it;
2. preserve the important/anomalous parts;
3. cache the original locally;
4. give the model a retrieval handle if it needs more.

Furnace implements that as **Headroom-lite**.

## What Furnace adopted

### ContentRouter-lite

`src/compression/router.ts` detects broad content shapes and chooses a deterministic compressor:

- `json`: summarizes top-level shape, common keys, samples, and error-like items.
- `log`: preserves error/warning/failure/stack lines and summarizes repeated noise.
- `search`: summarizes match counts, top files, important-looking matches, and a preview.
- `diff`: summarizes touched files, additions/deletions, hunks, and preview.
- `generic`: bounded head/tail preview.

This intentionally avoids Headroom's heavier ML, Magika, tree-sitter, and SmartCrusher parity paths.

### CCR-lite

Headroom's CCR means compress/cache/retrieve. Furnace's lighter version stores full original oversized outputs under:

```txt
.furnace/context-store/ctx_<sha>.txt
```

The model receives a compressed result containing:

```txt
Full output artifact: ctx_<sha> (.furnace/context-store/ctx_<sha>.txt)
Retrieve with: context_retrieve({"id":"ctx_<sha>"})
```

The `context_retrieve` tool returns the original artifact, optionally by line range.

### Tool-output compression

`src/tools/registry.ts` routes oversized tool outputs through Headroom-lite instead of returning a generic truncation marker. The original output is stored first, then the compressed preview is returned to the model.

This keeps existing safety behavior: small outputs pass through unchanged; large outputs are bounded before entering model context.

### Request transforms

`src/compression/request-transform.ts` runs before model requests through `src/cli.ts`'s `onBeforeModelRequest` hook. It compresses oversized tool messages that predate the current tool execution path, such as old session entries or future integrations that replay large tool results.

This transform is request-local: it changes the model-facing message projection, not the saved transcript.

## How it differs from full Headroom

Furnace does **not** port:

- Headroom's Python/FastAPI proxy;
- Rust SmartCrusher parity;
- Kompress ML text compression;
- provider-specific proxy handlers;
- wrapper commands for other agents;
- Headroom's MCP server and memory stack.

Those remain better as optional sidecar integrations later. Furnace's built-in version is deterministic TypeScript and optimized for the local harness runtime.

## Current implementation

- `src/compression/artifacts.ts`: content artifact storage and range retrieval.
- `src/compression/router.ts`: content detection and compression.
- `src/compression/request-transform.ts`: pre-model request compression pass.
- `src/tools/registry.ts`: `context_retrieve` tool and oversized tool-output integration.
- `test/compression.test.mjs`: router and request-transform coverage.
- `test/tools.test.mjs`: end-to-end artifact creation and retrieval coverage.

## Design constraints

- Never use compression as a substitute for permission checks.
- Keep full originals local under `.furnace/`.
- Keep the model-facing compressed output explicit about what was omitted.
- Preserve tool-call/tool-result protocol boundaries.
- Prefer deterministic heuristics over hidden model summaries for live tool output.
