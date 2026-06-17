# Design Choices

This file records small product and interface decisions that should stay stable unless we intentionally revisit them.

## History Relative Time Labels

`/history` should show human-friendly recency labels instead of raw session ids.

Rules:

- Show `just now` for sessions updated less than one minute ago.
- Show `N mins ago` for sessions updated less than one hour ago.
- Show `N hours ago` for sessions updated less than one day ago.
- If a session was updated on the previous calendar day, only show `yesterday` when it is also at least 15 hours old.
- If a session was updated on the previous calendar day but is less than 15 hours old, keep showing `N hours ago`.
- Show `N days ago` for older sessions.

Reasoning:

Near-midnight sessions can technically be "yesterday" while still feeling recent. Showing `2 hours ago` is more useful than `yesterday` in that case. The `yesterday` label should be reserved for sessions that feel meaningfully older.

Current implementation:

- Interactive history formatting lives in `src/ui/pi-terminal.ts`.
- Piped `/history` formatting lives in `src/cli.ts`.
