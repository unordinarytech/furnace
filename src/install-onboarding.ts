import readline from "node:readline"
import chalk from "chalk"
import type { ManagedInstallResult } from "./managed-install.js"

export const CLEAR_INSTALLER_OUTPUT = "\x1b[2J\x1b[3J\x1b[H"

export function renderInstallCompletion(result: ManagedInstallResult): string {
  const lines = [
    `${chalk.bold.green(`Furnace ${result.version} installed.`)} ${chalk.dim("The persistent command is")} ${chalk.bold.cyan("furnace")}`,
    `${chalk.bold.magenta("Tip:")} Idle tips can be turned off in ${chalk.cyan("/settings")} or with ${chalk.cyan("/tips")}.`,
  ]
  if (result.pathChanged) {
    lines.push(chalk.yellow("PATH was updated. Restart your terminal once before running `furnace` next time."))
  }
  return lines.join("\n")
}

export async function waitForInstallContinue(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): Promise<boolean> {
  if (!input.isTTY || !output.isTTY) return false
  const prompt = `${chalk.bold.cyan("Tap Enter to start Furnace now…")}`
  const interface_ = readline.createInterface({ input, output, terminal: true })
  try {
    await new Promise<void>((resolve) => interface_.question(`\n${prompt}`, () => resolve()))
  } finally {
    interface_.close()
  }
  output.write(CLEAR_INSTALLER_OUTPUT)
  return true
}
