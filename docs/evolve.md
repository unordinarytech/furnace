# Evolve: self-modifying the Furnace harness

`/evolve` lets Furnace change its own source in response to a request, verify the
change, and roll it back if something breaks. It is the Furnace analogue of pi's
"ask the harness to customize itself" — adapted to Furnace's compiled bundle, so
changes require a rebuild and a restart.

## Invoking it

Two ways:

- **Explicit:** `/evolve <what to change>`, e.g. `/evolve add cost usage to the statusline`.
- **Auto-detected:** ask for a harness change in plain language during a normal
  conversation — "add a monochrome green theme", "make the thinking text say
  huzzing", "put cost on the status bar". The agent recognizes harness-modification
  intent and routes it into the evolve flow.

`/evolve` is interactive-only — it needs the diff-review consent step, so it is not
available in piped/headless mode.

## What a run does

1. **Recovery point.** Captures a git snapshot of tracked source (plus any evolve
   -created files it records) and copies the current known-good `dist/` to
   `.furnace/recovery/<id>/dist/`. Each point gets a short id (e.g. `a2983z`).
2. **Edit.** Runs an agent turn against the Furnace source root to implement your
   request, following existing patterns (themes in `src/ui/terminal-themes/`,
   thinking text via `setThinking` in `src/ui/pi-terminal.ts`, the status line in
   the footer, etc.). The edit turn does not build.
3. **Verify.** Runs typecheck, the test suite, and an atomic build to a temp
   location. If any gate fails, the change is reverted and the live `dist/` is left
   untouched.
4. **Consent.** Shows you the actual diff and the verified result and asks you to
   approve. Rejecting reverts the change.
5. **Swap + restart.** On approval, atomically swaps `dist/cli.js` and
   `dist/prompts/` into place and asks you to **restart Furnace**. Themes may also
   be set active so the change is visible on next start.

## Recovery

If a restart lands on a broken harness:

```bash
furnace --recover <id>
```

This restores the previous known-good `dist/` (no rebuild, and it does not run the
possibly-broken new bundle), then reverts the source and removes files the evolve
created. Cross-checkout recovery is refused — an id can only be recovered from the
Furnace root it was created in.

Startup surfaces a hint automatically after a recent evolve: if Furnace crashes on
launch and a recent evolve recovery point exists, it prints the `furnace --recover
<id>` command. The hint is worded as a *possible* cause — an unrelated crash after
a good evolve should not push you into rolling back a fine change.

**Rare case — the bundle will not launch at all.** Because `--recover` runs from
`dist/cli.js`, a change that breaks module load before argument parsing can make
even `--recover` unlaunchable. Rebuild from source in the Furnace checkout:

```bash
npm run build
```

## Requirements and limits

- Evolve requires running Furnace from its own **source checkout** — a git repo
  containing `src/`. An npm-global install without source reports that evolve is
  unavailable.
- Building requires the pinned Node 22 toolchain and installed `node_modules`
  (a contributor environment). Without them, verification fails cleanly and the
  change is reverted.
- The evolve edit turn runs with **broad session permissions** over the Furnace
  root (permissions are session-scoped, not path-scoped) and has shell access. It
  can read `~/.furnace/auth.json` (saved provider keys). The diff-review step is
  your control — inspect the diff before approving.
- Recovery points accumulate git tags under `refs/tags/furnace-recovery/<root-hash>/`.
- Not supported yet: locate-or-clone for installs without source, hot-reload
  without restart, shareable evolve packages, and automatic restart.
