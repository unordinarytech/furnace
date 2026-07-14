# Context Management

> Furnace reduces model request size without deleting persisted conversation or tool output.

## Overview

Context management has two separate layers:

- **Request compression** shortens large historical tool results for a single provider request.
- **Session compaction** appends a summary entry and changes which historical entries are projected into future requests.

These layers solve different size problems and must remain reversible.

## How It Works

### Request Compression

Before a model request, `applyHeadroomLiteRequestTransforms()` inspects old tool messages. Content-specific compressors keep useful structure while omitting bulk. Full omitted content is stored under `.furnace/context-store/` and can be read with `context_retrieve`.

Stored session entries are not modified.

### Session Compaction

When estimated request tokens approach the model context window, compaction:

1. Finds a safe cut that keeps a recent suffix.
2. Avoids splitting tool-call and tool-result relationships.
3. Generates a summary, with a deterministic fallback.
4. Appends a compaction entry with `firstKeptEntryId`.
5. Projects the summary plus the kept suffix on later requests.
6. Clears stale file-read state because summarized reads are no longer reliable write evidence.

One overflow-triggered retry is allowed per agent turn.

## Key Paths

| Path | Responsibility |
| --- | --- |
| `src/compression/router.ts` | Selects a compressor for tool-output content |
| `src/compression/request-transform.ts` | Applies request-local transforms |
| `src/compression/artifacts.ts` | Stores and retrieves full omitted output |
| `src/session/compaction.ts` | Thresholds, safe cuts, summaries, and compaction entries |
| `src/session/context.ts` | Projects compaction entries for the model |
| `src/tools/file.ts` | Implements `context_retrieve` |

## Invariants

- Never replace persisted tool results with compressed text.
- Every omitted full result must remain locally retrievable.
- Compression must enforce its final output limit.
- Compaction entries supplement history; they do not delete it.
- The kept suffix must begin at a valid message boundary.
- Later messages override conflicting summary text.
- Compaction must clear file-read state.

## Changing This Area

- Test both model-facing output and stored original content.
- Keep compression deterministic for the same input.
- Add content-specific compression only when it preserves more signal than generic truncation.
- Test repeated compactions and small context windows.
- Run compression, compaction, session-context, and agent-loop tests together.
