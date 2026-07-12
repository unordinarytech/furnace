# Compaction

Furnace compaction keeps long sessions usable by summarizing older conversation history while preserving the recent suffix verbatim. The full session remains in SQLite; compaction changes only the model-facing context projection.

## TLDR

- Manual trigger: `/compact [focus]`.
- Automatic trigger: before every model request, Furnace estimates the full request and compacts if it is near the selected context limit.
- Overflow trigger: if OpenRouter rejects a request for context length, Furnace compacts and retries once.
- After successful compaction, Furnace clears persisted file-read state for that session so summarized reads do not suppress future `read` tool output.
- Headroom-style tool-output compression is intentionally not the first layer. Furnace first compacts session history, then can later add reversible compression for huge tool results.

## Harness Provenance

Furnace combines the strongest parts of the inspected systems:

- Pi: durable `compaction` session entries with a `firstKeptEntryId` boundary. This matches Furnace's parent-linked entry tree and keeps full history append-only.
- OpenCode: request preflight and one-shot overflow recovery. Furnace checks before model calls and retries once after provider context overflow.
- Hermes Agent: hardened summary behavior. Furnace summaries are reference-only, preserve exact operational facts, redact secrets, protect the latest user intent, and use a deterministic fallback when LLM summarization fails.
- Headroom: later context-bloat direction. Headroom is best treated as a future live-zone/tool-output compression layer, not as the primary session compactor.

## Storage Model

Compaction appends a normal session entry:

```ts
type CompactionEntryData = {
  kind: "context_compaction"
  reason: "manual" | "threshold" | "overflow"
  summary: string
  firstKeptEntryId: string
  tokensBefore: number
  tokensAfter?: number
  model: string
  focus?: string
}
```

The original messages, tool calls, and tool results remain in the entry chain. Furnace does not rotate session ids or delete old entries.

## Model Projection

When building model messages:

1. If there is no compaction entry, Furnace replays the active path normally.
2. If there is a compaction entry, Furnace finds the latest one.
3. It sends one reference-only summary message.
4. It sends the verbatim suffix starting at `firstKeptEntryId`.
5. It skips compaction marker entries themselves.

This gives the model the old facts it needs plus exact recent turns, without paying for the full transcript every time.

## Trigger Thresholds

Furnace estimates tokens as roughly `characters / 4`, including:

- base system prompt,
- runtime context,
- session messages/tool calls/tool results after projection,
- tool definitions.

Defaults:

- Context window: selected model context length from preferences, or `200_000` tokens if unknown.
- Normal reserve: `16_000` tokens.
- Normal recent suffix: `20_000` tokens.
- Small-context reserve: `8_000` tokens when context is `64_000` tokens or less.
- Small-context recent suffix: `25%` of the context window, with a `4_000` token minimum.

Automatic compaction triggers when:

```text
estimated_request_tokens >= context_window - reserve_tokens
```

Examples:

- `200K` context: compact at about `184K`, keep about `20K` recent tokens.
- `64K` context: compact at about `56K`, keep about `16K` recent tokens.
- `32K` context: compact at about `24K`, keep about `8K` recent tokens.

## Safe Cut Selection

Furnace walks backward from the newest entry until it has enough recent tokens. It also:

- keeps the latest user message in the suffix,
- avoids starting the suffix at a `tool_result`, so tool call/result pairs are not split,
- updates from the latest previous compaction summary instead of duplicating old summaries,
- skips compaction when there is nothing safe or useful to summarize.

## Summary Safety

The summary prompt asks the model to preserve:

- exact file paths,
- commands,
- error strings,
- tests,
- changed files,
- decisions,
- blockers,
- unresolved questions,
- active state.

It also says:

- the summary is reference-only,
- later messages win over the summary,
- do not answer historical questions from the compacted turns,
- do not resume stale historical work unless the newest user asks for it,
- redact secrets as `[REDACTED]`.

If the summary model call fails, Furnace writes a deterministic fallback summary instead of dropping context.

## File Read State

Furnace tracks file reads to avoid returning the same unchanged file/range repeatedly. After compaction, older file contents may now exist only inside the summary, so the previous read receipts are no longer reliable.

On successful compaction, Furnace clears:

- `file_read_ranges` for the session,
- `file_read_files` for the session.

The next `read` call can return full content again and re-establish fresh stale-write tracking.

## Current Implementation

- `src/session/types.ts` defines `CompactionEntryData`.
- `src/session/store.ts` appends compaction entries and clears file-read state.
- `src/session/context.ts` projects latest compaction summary plus kept suffix.
- `src/session/compaction.ts` owns token estimation, cut selection, summary prompting, fallback, and redaction.
- `src/agent/loop.ts` calls preflight and overflow hooks before model requests.
- `src/cli.ts` wires `/compact`, automatic preflight compaction, and overflow retry for parent and subagent turns.
