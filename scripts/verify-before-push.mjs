import { spawnSync } from "node:child_process"

const npm = process.platform === "win32" ? "npm.cmd" : "npm"

const steps = [
  ["Node version", [npm, ["run", "check-node"]]],
  ["Typecheck", [npm, ["run", "typecheck"]]],
  ["Tests", [npm, ["test"]]],
  ["Package dry run", [npm, ["run", "pack:dry-run"]]],
]

console.log("Running Furnace pre-push verification...\n")

for (const [label, [command, args]] of steps) {
  console.log(`> ${label}`)
  const result = spawnSync(command, args, { stdio: "inherit" })
  if (result.status !== 0) {
    const status = typeof result.status === "number" ? result.status : 1
    console.error(`\n[fail] ${label}`)
    process.exit(status)
  }
  console.log(`[ok] ${label}\n`)
}

console.log("All pre-push checks passed.")
