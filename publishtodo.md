# Public Release Todo

Remaining work before publishing Furnace for public use.

## Blocking

- [ ] Stop hardcoding the CLI version; read it from `package.json` or a generated version module.
- [ ] Add a root `LICENSE` file matching the MIT license in `package.json`.
- [ ] Add a package `files` whitelist so `npm publish` only ships the intended runtime files.
- [ ] Add a `prepack` script that builds `dist` before packing/publishing.
- [ ] Add a `prepublishOnly` script that runs typecheck, tests, and package dry-run checks.
- [ ] Add CI for typecheck, tests, and package dry-run on PRs/pushes.
- [ ] Add public install and update docs for npm users.
- [ ] Add privacy and safety docs explaining provider data flow, local storage, permissions, and no sandbox.
- [ ] Add `CHANGELOG.md`.
- [ ] Add `SECURITY.md`.
- [ ] Add `CONTRIBUTING.md`.

## Strongly Recommended

- [ ] Run a tarball install smoke test from `npm pack` output.
- [ ] Manually test the TUI on macOS.
- [ ] Manually test the TUI on Linux.
- [ ] Improve missing-key onboarding for first-time users without `OPENROUTER_API_KEY`.
- [ ] Document the no-sandbox limitation prominently near install/quickstart.
- [ ] Document local SQLite storage under `.furnace/furnace.sqlite`.
- [ ] Document OpenRouter-only provider support.

## Already Done

- [x] Decided package name: `furnace`.
- [x] Bumped version from `0.0.0` to `0.1.0-alpha.0`.
- [x] Removed accidental `~/Desktop/bfs_dfs.py` from the repo.
- [x] Added `todo.txt` to `.gitignore` for personal notes going forward.
