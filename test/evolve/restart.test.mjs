import test from "node:test"
import assert from "node:assert/strict"

test("restart invocation preserves the current launcher and arguments", async () => {
  const { furnaceRestartInvocation } = await import("../../dist/evolve/restart.js")
  assert.deepEqual(
    furnaceRestartInvocation({
      argv: ["/node", "/furnace/dist/cli.js", "--continue"],
      execArgv: ["--enable-source-maps"],
      execPath: "/node",
    }),
    {
      command: "/node",
      args: ["--enable-source-maps", "/furnace/dist/cli.js", "--continue"],
    },
  )
})

test("scheduled restart launches synchronously during clean shutdown", async () => {
  const { scheduleFurnaceRestart } = await import("../../dist/evolve/restart.js")
  let exitListener
  const launches = []
  scheduleFurnaceRestart({
    invocation: { command: "/node", args: ["/furnace/dist/cli.js"] },
    onExit: (listener) => {
      exitListener = listener
    },
    spawnProcess: (command, args, options) => {
      launches.push({ command, args, options })
    },
  })

  assert.deepEqual(launches, [])
  exitListener()
  assert.equal(launches.length, 1)
  assert.equal(launches[0].command, "/node")
  assert.deepEqual(launches[0].args, ["/furnace/dist/cli.js"])
  assert.equal(launches[0].options.stdio, "inherit")
})
