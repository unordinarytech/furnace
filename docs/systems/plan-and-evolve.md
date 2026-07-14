# Plan and Evolve

> Plan mode restricts an agent to research and one plan artifact; evolve applies verified changes to the Furnace harness itself.

## Overview

Plan mode and evolve both use the normal session runtime, but add stricter control around mutations.

- **Plan mode** records a mode transition, injects planning guidance, and permits writes only to the active `.furnace/plans/*.md` artifact.
- **Evolve** is an interactive, source-checkout-only workflow that snapshots the harness, lets an agent edit source, verifies a temporary build, asks for consent, then swaps the verified build into place.

## How It Works

### Plan Mode

1. A mode-change entry records `agent` or `plan`.
2. Plan guidance is appended to the system prompt.
3. The permission engine allows research tools and safe read-only shell commands.
4. Write and edit are limited to the active plan path.
5. Approval returns to agent mode with a prompt that points at the saved plan.

### Evolve

1. Resolve a Furnace source root and confirm it is a git worktree.
2. Create a recovery point containing source state and the current build.
3. Run an agent edit turn against source only.
4. Typecheck, build to a temporary directory, and launch-smoke the result.
5. Show the actual change summary and verification log for consent.
6. On approval, atomically replace `dist/cli.js` and `dist/prompts/`.
7. On failure or rejection, restore the recovery point.
8. Require a restart and provide `furnace --recover <id>`.

`/reset` restores the earliest evolve baseline and clears later recovery history.

## Key Paths

| Path | Responsibility |
| --- | --- |
| `src/plan-mode.ts` | Mode entries, plan paths, guidance, and execute bridge |
| `src/permissions.ts` | Plan-mode mutation restrictions |
| `src/evolve/root.ts` | Source-root detection and availability |
| `src/evolve/orchestrator.ts` | Evolve ordering and rollback decisions |
| `src/evolve/recovery.ts` | Recovery points, restore, and reset |
| `src/evolve/verify.ts` | Temporary build, smoke test, and atomic swap |
| `src/evolve/types.ts` | Evolve result contracts |
| `src/interactive-session-controller.ts` | Interactive command integration |

## Invariants

- Plan mode must not mutate files outside its active plan artifact.
- Mode changes are appended session entries, not transient UI-only state.
- Evolve never swaps an unverified build into `dist/`.
- Rejection and verification failure both restore source changes.
- The consent step reflects the real post-edit change set.
- Recovery remains available if the newly built CLI fails after restart.
- Evolve is unavailable when the running installation has no source checkout.

## Changing This Area

- Preserve the evolve order: snapshot, edit, verify, consent, swap.
- Test both rollback branches and created-file cleanup.
- Keep build verification independent from the live `dist/`.
- Test plan permissions separately from normal session grants.
- Run all tests under `test/evolve/` plus plan-mode and permissions tests.
