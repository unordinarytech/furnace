import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { copyFile, mkdir, realpath, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { withTemporaryHomeWorkspace } from "../helpers/workspace.mjs"

test("published installs resolve an activated managed evolve bundle", async () => {
  const { activateManagedFurnaceRoot, resolveActiveEvolveCli } = await import("../../dist/evolve/activation.js")
  const { packageVersion } = await import("../../dist/version.js")
  await withTemporaryHomeWorkspace("furnace-evolve-activation-", async (workspace) => {
    const installedRoot = join(workspace, "installed")
    const managedRoot = join(workspace, "managed")
    const installedCli = join(installedRoot, "dist", "cli.js")
    const managedCli = join(managedRoot, "dist", "cli.js")
    await mkdir(join(installedRoot, "dist"), { recursive: true })
    await mkdir(join(managedRoot, "dist"), { recursive: true })
    await mkdir(join(installedRoot, "src", "ui", "pi"), { recursive: true })
    await mkdir(join(managedRoot, "src", "evolve"), { recursive: true })
    await copyFile(join(process.cwd(), "dist", "cli.js"), installedCli)
    await writeFile(join(installedRoot, "package.json"), JSON.stringify({ name: "cook-furnace", version: packageVersion }), "utf8")
    await writeFile(join(installedRoot, "src", "ui", "pi", "LICENSE"), "packaged license\n", "utf8")
    await symlink(join(process.cwd(), "node_modules"), join(installedRoot, "node_modules"), "dir")
    await writeFile(join(managedRoot, "src", "cli.ts"), "", "utf8")
    await writeFile(join(managedRoot, "src", "evolve", "orchestrator.ts"), "", "utf8")
    await writeFile(managedCli, 'process.stdout.write("EVOLVED BUNDLE\\n")\n', "utf8")

    activateManagedFurnaceRoot(managedRoot)

    assert.equal(resolveActiveEvolveCli(installedCli), await realpath(managedCli))
    assert.equal(resolveActiveEvolveCli(managedCli), undefined)

    const originalArgv = process.argv
    process.argv = ["node", installedCli, "update"]
    assert.equal(resolveActiveEvolveCli(installedCli), undefined)
    process.argv = ["node", installedCli, "--update"]
    assert.equal(resolveActiveEvolveCli(installedCli), undefined)
    process.argv = originalArgv
    assert.equal(resolveActiveEvolveCli(installedCli), await realpath(managedCli))

    const childEnv = { ...process.env }
    delete childEnv.FURNACE_DISABLE_EVOLVE_RELAUNCH
    const launched = spawnSync(process.execPath, [installedCli, "--version"], {
      encoding: "utf8",
      env: childEnv,
    })
    assert.equal(launched.status, 0, launched.stderr)
    assert.equal(launched.stdout, "EVOLVED BUNDLE\n")
  })
})
