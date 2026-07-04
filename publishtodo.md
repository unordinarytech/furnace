# Public Release Todo

Remaining work before publishing Furnace for public use.

## Blocking

- [ ] Add a `prepack` script that builds `dist` before packing/publishing.
- [ ] Add a `prepublishOnly` script that runs typecheck, tests, and package dry-run checks.
- [ ] Add CI for typecheck, tests, and package dry-run on PRs/pushes.
- [ ] Add public install and update docs for npm users.



## Strongly Recommended

- [ ] Run a tarball install smoke test from `npm pack` output.
- [ ] Improve missing-key onboarding for first-time users without `OPENROUTER_API_KEY`.
- [ ] Document the no-sandbox limitation prominently near install/quickstart.

## Already Done

- [x] Decided package name: `furnace`.
- [x] Bumped version from `0.0.0` to `0.1.0-alpha.0`.
- [x] Stopped hardcoding the CLI version; it now reads from `package.json` through `src/version.ts`.
- [x] Added a root `LICENSE` file matching the MIT license in `package.json`.
- [x] Added a package `files` whitelist so `npm publish` only ships intended runtime files.
- [x] Added `CHANGELOG.md`.
- [x] Added `SECURITY.md`.
- [x] Added `CONTRIBUTING.md`.
- [x] Documented local SQLite storage under `.furnace/furnace.sqlite`.
- [x] Removed accidental `~/Desktop/bfs_dfs.py` from the repo.
- [x] Added `todo.txt` to `.gitignore` for personal notes going forward.
