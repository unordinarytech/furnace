# Conversation History And Compaction Report

This report compares how Pi Coding Agent and OpenCode appear to model conversation history, session storage, and compaction. The goal is to decide what shape Furnace should use before adding multi-turn sessions.

## Short Version

Pi and OpenCode both preserve raw history somewhere, but they differ in how much structure they expose.

- Pi is session-log first. It stores append-only JSONL entries as a tree, then derives model context from the active branch.
- OpenCode is message/part first. It stores messages and message parts, and represents compaction as a synthetic user compaction message followed by an assistant summary message.

OpenCode feels simpler for our current stage because it maps directly to the chat model shape: user message, assistant message, special compaction message, summary assistant message. Pi is more powerful for branching and replay, but its tree model is more architecture than we need right now.

## Pi Design

Pi stores sessions as JSONL files. Each line is a typed session entry. Entries have `id` and `parentId`, so a session is a tree rather than a single linear transcript.

This supports:

- Continuing a previous session.
- Forking from any older message.
- Navigating a tree of alternative attempts.
- Preserving full raw history even after compaction.
- Appending crash-safe records instead of rewriting the file.

### Pi Entry Shape

A normal message entry is conceptually like:

```json
{
  "type": "message",
  "id": "msg_003",
  "parentId": "msg_002",
  "timestamp": "2026-06-17T12:00:00.000Z",
  "message": {
    "role": "user",
    "content": "Add a file search tool"
  }
}
```

A compaction entry is a special entry appended into that tree:

```json
{
  "type": "compaction",
  "id": "cmp_001",
  "parentId": "msg_120",
  "timestamp": "2026-06-17T12:30:00.000Z",
  "summary": "The user is building a TypeScript CLI coding harness. It currently has an OpenRouter streaming path and a terminal input panel. Next work is adding multi-turn history.",
  "firstKeptEntryId": "msg_100",
  "tokensBefore": 52000,
  "details": {
    "readFiles": ["src/cli.ts", "src/ui/terminal.ts"]
  }
}
```

The key field is `firstKeptEntryId`.

It means:

- Everything before `firstKeptEntryId` is represented by `summary`.
- Everything from `firstKeptEntryId` onward is kept raw.
- The full original entries are still in the JSONL file.
- Compaction changes model context, not audit history.

### How Pi Builds Model Context

Suppose the raw branch is:

```text
msg_001 user: "Build a CLI harness"
msg_002 assistant: "Let's start with TypeScript"
msg_003 user: "Use OpenRouter"
msg_004 assistant: "Implemented streaming"
msg_005 user: "Fix the input UI"
msg_006 assistant: "Input is now sticky"
cmp_001 summary of msg_001..msg_004, firstKeptEntryId = msg_005
msg_007 user: "Make it multi-turn"
```

Pi does not send all of that to the model after compaction. It sends something closer to:

```text
system prompt
summary: "The user is building a TypeScript CLI harness..."
msg_005 user: "Fix the input UI"
msg_006 assistant: "Input is now sticky"
msg_007 user: "Make it multi-turn"
```

The UI/session tree can still show `msg_001` through `msg_004`, because they were never deleted.

### Repeated Compactions In Pi

Repeated compaction has a trap: messages that were kept raw in the first compaction can later fall outside the recent window. Pi handles this by using the previous compaction's `firstKeptEntryId` as the start of the next summarization range.

Example:

```text
First compaction:
summary A covers msg_001..msg_004
keeps msg_005..msg_008

Later:
msg_005..msg_008 are no longer recent enough
```

The second compaction must summarize:

```text
previous summary A + msg_005..older cutoff
```

If it only summarized entries after the previous compaction entry, it would lose the previously kept messages. Pi explicitly accounts for this.

### Pi Branch Summaries

Pi also has branch summaries. When the user navigates from one branch to another, Pi can summarize the abandoned branch.

Conceptually:

```json
{
  "type": "branch_summary",
  "id": "brs_001",
  "parentId": "msg_050",
  "fromId": "msg_089",
  "timestamp": "2026-06-17T13:00:00.000Z",
  "summary": "On the abandoned branch, we tried React Ink but found cursor control too limited for the desired sticky input panel."
}
```

This is useful, but it is a larger product commitment. It only matters once Furnace supports branching or forking.

### Pi Tradeoffs

Pros:

- Very debuggable.
- Full raw history is preserved.
- Tree structure enables branching and forks.
- Compaction is explicit and inspectable.
- Session log can include non-model entries like labels, model changes, and extension state.

Cons:

- More complex than a simple chat transcript.
- Every context build must walk a branch and transform entries.
- Compaction has tricky boundary logic.
- Branching behavior must be designed early.

## OpenCode Design

OpenCode stores sessions as messages with parts. A message contains metadata, and parts contain the actual content or structured payloads.

Conceptually:

```json
{
  "info": {
    "id": "msg_001",
    "role": "user",
    "sessionID": "ses_001",
    "model": {
      "providerID": "openrouter",
      "modelID": "anthropic/claude-sonnet-4.6"
    }
  },
  "parts": [
    {
      "type": "text",
      "text": "Make the input sticky"
    }
  ]
}
```

Assistant messages can contain text parts, tool parts, error state, token counts, cost, path metadata, and a `summary` marker.

### OpenCode Compaction Shape

OpenCode represents compaction as normal-ish messages:

1. Create a synthetic user message.
2. Add a `compaction` part to that user message.
3. Generate an assistant response in compaction mode.
4. Mark that assistant message as `summary: true`.

Conceptually:

```json
{
  "info": {
    "id": "msg_200",
    "role": "user",
    "sessionID": "ses_001"
  },
  "parts": [
    {
      "type": "compaction",
      "auto": true,
      "overflow": false,
      "tail_start_id": "msg_180"
    }
  ]
}
```

Then the assistant summary:

```json
{
  "info": {
    "id": "msg_201",
    "role": "assistant",
    "parentID": "msg_200",
    "sessionID": "ses_001",
    "mode": "compaction",
    "summary": true
  },
  "parts": [
    {
      "type": "text",
      "text": "## Goal\n- Build Furnace, a TypeScript terminal coding harness.\n\n## Constraints & Preferences\n- Keep runtime separate from UI.\n- Do not pretend tools exist before implementing them.\n\n## Progress\n### Done\n- Added OpenRouter streaming.\n- Added sticky terminal input.\n\n### In Progress\n- Designing multi-turn history.\n\n### Blocked\n- None.\n\n## Next Steps\n- Add in-memory messages array.\n- Decide persistence shape."
    }
  ]
}
```

So instead of a separate `CompactionEntry` with a `summary` field, OpenCode puts the summary in an assistant message's text part and marks the message as summary metadata.

### How OpenCode Finds Completed Compactions

OpenCode can scan messages for:

- A user message with a `compaction` part.
- A child assistant message with `summary: true`.
- The assistant text parts become the summary.

That makes compaction fit the same message stream as normal chat.

### OpenCode Summary Prompt

OpenCode uses a structured handoff style. The summary is not just prose. It keeps sections such as:

```md
## Goal
- [single-sentence task summary]

## Constraints & Preferences
- [user constraints, preferences, specs, or "(none)"]

## Progress
### Done
- [completed work or "(none)"]

### In Progress
- [current work or "(none)"]

### Blocked
- [blockers or "(none)"]

## Key Decisions
- [decision and why, or "(none)"]

## Next Steps
- [ordered next actions or "(none)"]

## Critical Context
- [important technical facts, errors, open questions, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
```

This is a good design choice. It makes the summary more like a handoff note than a vague memory.

### OpenCode Tail Preservation

OpenCode preserves recent turns raw. It appears to default around the last two user turns, with a token budget for recent context.

The model context after compaction is conceptually:

```text
system prompt
summary assistant message
recent user/assistant turns
current user message
```

This keeps the latest interaction exact while compressing older history.

### OpenCode Tool Output Pruning

Before full compaction, OpenCode can prune older tool outputs.

The idea:

- Recent tool output stays intact.
- Important protected tool output can stay intact.
- Older large tool output is marked compacted/truncated.
- If pruning is not enough, then LLM summary compaction happens.

This matters later for Furnace once tools exist. For now, without tools, we do not need pruning.

### OpenCode Tradeoffs

Pros:

- Simpler mental model for a chat-based app.
- Compaction is represented as messages, not a separate log concept.
- Easy to render in UI: compaction is just another special message.
- Summary can carry standard assistant metadata.
- Works naturally with tool parts later.

Cons:

- Full branching/forking is less obvious than Pi's tree log.
- Requires careful filtering so synthetic compaction messages are not treated like normal user requests.
- Message parts add complexity once many part types exist.
- Without an append-only event log, debugging exact runtime events can be harder unless separately recorded.

## Direct Comparison

### Storage Model

Pi:

```text
append-only JSONL entries
entry tree via id and parentId
message entries + compaction entries + branch summary entries
```

OpenCode:

```text
session messages
each message has metadata and parts
compaction is a synthetic user message plus assistant summary message
```

### Summary Location

Pi:

```json
{
  "type": "compaction",
  "summary": "..."
}
```

OpenCode:

```json
{
  "role": "assistant",
  "summary": true,
  "parts": [{ "type": "text", "text": "..." }]
}
```

### Kept Recent Context

Pi:

```json
{
  "firstKeptEntryId": "msg_100"
}
```

OpenCode:

```json
{
  "type": "compaction",
  "tail_start_id": "msg_180"
}
```

Both represent the same idea: everything after this point stays raw.

### Full History Preservation

Pi:

- Strong guarantee by design.
- Raw entries remain in JSONL.
- Compaction only affects context building.

OpenCode:

- Raw messages remain unless storage cleanup/pruning modifies parts.
- Tool output may be pruned/truncated.
- Compaction summary is part of message history.

### Best Fit

Pi is better if Furnace wants:

- Branching from day one.
- Full auditability.
- Append-only session log.
- Strong crash recovery.
- Session tree navigation.

OpenCode is better if Furnace wants:

- Simpler multi-turn chat first.
- Message rendering first.
- Compaction visible as part of conversation.
- A clean path to message parts and tools later.

## Initial Recommendation Before User Decision

The initial recommendation was to start with an OpenCode-inspired message/parts model because it is simpler for a first multi-turn chat loop. That would have looked like this:

```ts
type FurnaceMessage = {
  id: string
  role: "user" | "assistant" | "system"
  parts: FurnacePart[]
  summary?: boolean
  synthetic?: boolean
  createdAt: string
}

type FurnacePart =
  | { type: "text"; text: string }
  | { type: "compaction"; auto: boolean; tailStartId?: string }
```

For a first multi-turn implementation, that path would not persist anything yet:

```ts
const messages: FurnaceMessage[] = []
```

When sending to OpenRouter:

```ts
[
  { role: "system", content: baseSystemPrompt },
  ...toModelMessages(messages)
]
```

When the user submits:

```ts
messages.push({
  id: "msg_001",
  role: "user",
  parts: [{ type: "text", text: userInput }],
  createdAt: now
})
```

When the assistant completes:

```ts
messages.push({
  id: "msg_002",
  role: "assistant",
  parts: [{ type: "text", text: assistantText }],
  createdAt: now
})
```

Later, compaction can be represented as:

```ts
messages.push({
  id: "msg_100",
  role: "user",
  synthetic: true,
  parts: [{ type: "compaction", auto: true, tailStartId: "msg_080" }],
  createdAt: now
})

messages.push({
  id: "msg_101",
  role: "assistant",
  summary: true,
  synthetic: true,
  parts: [{ type: "text", text: structuredSummary }],
  createdAt: now
})
```

Then `toModelMessages()` can send:

```text
system prompt
latest summary message
messages from tailStartId onward
current user message
```

This would give OpenCode's simplicity without losing the option to add Pi-style JSONL persistence later.

## User Choice: Proceed With Pi-Style Session History

After reviewing the tradeoffs, the chosen direction for Furnace is to proceed with a Pi-style session history model.

That means Furnace should treat session history as an append-only entry log with tree semantics:

```ts
type SessionEntry = {
  id: string
  parentId: string | null
  type: "message" | "compaction" | "branch_summary" | "model_change" | "custom"
  createdAt: string
}

type SessionState = {
  sessionId: string
  title: string
  leafId: string | null
  entries: SessionEntry[]
}
```

The core rule is:

```text
newEntry.parentId = current leafId
leafId = newEntry.id
```

If the user branches from an older point:

```text
leafId = olderEntryId
```

The next appended entry becomes a new child of that older entry. This gives Furnace branching and forking semantics without changing the basic append-only storage model.

### Chosen Compaction Behavior

Furnace should keep Pi's `firstKeptEntryId` behavior.

Do not simplify compaction to "summarize everything before the compaction node and only replay messages after it." That is easier, but it throws away exact recent context.

Instead, compaction should work like:

```text
A -> B -> C -> D -> E -> F -> CMP -> G
```

Where `CMP` stores:

```json
{
  "type": "compaction",
  "summary": "Summary of older context...",
  "firstKeptEntryId": "E",
  "tokensBefore": 52000
}
```

Then model context should be built as:

```text
system prompt
compaction summary covering A-D
E raw
F raw
G raw
```

`firstKeptEntryId` is not the current active node. It is the oldest raw entry that should survive after compaction. This is needed because recent turns contain high-value exact context: user constraints, file paths, errors, command output, and decisions that summaries often lose.

This behavior should be kept as-is from Pi unless we have a very specific reason to modify it later.

### Guidance For Future History Changes

If future work modifies Furnace history/session behavior, use this choice as the baseline:

- Keep append-only session entries.
- Keep `parentId` tree semantics.
- Keep `leafId` as the active position.
- Keep compaction as a real entry in the tree.
- Keep `firstKeptEntryId` or an equivalent raw-tail pointer.
- Preserve full raw history separately from model context.
- Treat compaction as changing what is sent to the model, not as deleting old history.

Any change to this should explicitly explain why it is better for Furnace's use case than the Pi flow.

## What I Would Not Build Immediately

Even though the chosen direction is Pi-style, do not build every Pi feature at once. Full tree sessions imply:

- Branch navigation UI.
- Fork commands.
- Parent/leaf tracking.
- Branch summaries.
- More complicated compaction boundaries.

For Furnace, the better sequence is:

1. In-memory multi-turn entries with `id` and `parentId`.
2. `leafId` tracking.
3. Build model context by walking root-to-leaf.
4. Append-only JSONL persistence.
5. Compaction entries with `summary` and `firstKeptEntryId`.
6. Branching and fork commands.
7. Branch summaries.

## Proposed Immediate Next Step

Implement multi-turn chat with:

- One running process.
- Sticky input reused after every assistant response.
- In-memory `SessionEntry[]`.
- `parentId` and `leafId` tracking.
- No persistence yet.
- No compaction yet.
- Render user and assistant turns in the scroll area.

This gives us the runtime behavior we need while keeping the history model compatible with future Pi-style persistence, compaction, branching, and forking.
