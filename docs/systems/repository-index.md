# Repository Index

> The repository index gives the agent a compact orientation map without replacing source-code inspection.

## Overview

Furnace can create `.furnace/repo-index.md` when it first opens a git worktree. The index summarizes project shape, important directories, and representative files so a new session can navigate faster.

The index is local runtime context, not committed project documentation and never a source of truth. Sidecar metadata in `.furnace/repo-index.meta.json` records onboarding and staleness state.

## How It Works

1. Onboarding checks for a git worktree, a configured provider key, and an unanswered index decision.
2. Snapshot collection skips noisy directories and secret-like files.
3. A low-cost compatible model turns the bounded snapshot into a fixed-shape guide.
4. Index and metadata files are written atomically.
5. `/init` forces regeneration.
6. The reindex preference either leaves maintenance to the agent or watches tracked upstream changes and refreshes in the background.

Declining onboarding is remembered. Cancelling or interrupting generation is not treated as a decline.

## Key Paths

| Path | Responsibility |
| --- | --- |
| `src/repo-index/core.ts` | Root detection, snapshots, generation, metadata, and model selection |
| `src/repo-index/service.ts` | Background polling, coalescing, and refresh policy |
| `src/interactive-session-controller.ts` | Onboarding prompts, commands, and status integration |
| `src/preferences.ts` | Repository reindex policy |
| `src/prompts/base-system.md` | Agent guidance for using and maintaining the index |
| `src/git-exclude.ts` | Keeps `.furnace/` state out of git status |
| `test/repo-index/core.test.mjs` | Snapshot, metadata, onboarding, and generation behavior |
| `test/repo-index/service.test.mjs` | Background refresh behavior |

## Invariants

- Treat the index as orientation only; verify claims against source.
- Exclude secret-like files and noisy generated directories.
- Keep snapshots and generated output bounded.
- Write the index and metadata atomically.
- Background refresh must not block prompt input.
- Coalesce overlapping refresh requests.
- Preserve an explicit onboarding decline across launches.

## Changing This Area

- Test nested worktrees, missing git metadata, and provider failure.
- Keep index structure stable enough for agent guidance to remain useful.
- Test both manual and upstream-triggered regeneration.
- Verify ignored local state does not appear in `git status`.
- Run both repository-index test suites and `npm run verify`.
