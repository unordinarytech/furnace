import { spawnSync, type SpawnSyncOptions } from "node:child_process"

export type RestartInvocation = {
  args: string[]
  command: string
}

export function furnaceRestartInvocation(input: {
  argv?: string[]
  execArgv?: string[]
  execPath?: string
} = {}): RestartInvocation {
  const argv = input.argv ?? process.argv
  const entry = argv[1]
  if (!entry) throw new Error("Cannot restart Furnace because its executable entrypoint is unknown.")
  return {
    command: input.execPath ?? process.execPath,
    args: [...(input.execArgv ?? process.execArgv), entry, ...argv.slice(2)],
  }
}

export function scheduleFurnaceRestart(deps: {
  invocation?: RestartInvocation
  onExit?: (listener: () => void) => void
  spawnProcess?: (command: string, args: string[], options: SpawnSyncOptions) => unknown
} = {}): void {
  const invocation = deps.invocation ?? furnaceRestartInvocation()
  const onExit = deps.onExit ?? ((listener) => process.once("beforeExit", listener))
  const spawnProcess = deps.spawnProcess ?? spawnSync
  onExit(() => {
    spawnProcess(invocation.command, invocation.args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    })
  })
}
