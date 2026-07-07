import { rm } from "node:fs/promises"
import { resolve } from "node:path"

const distPath = resolve("dist")

if (!distPath.endsWith(`${process.cwd()}/dist`)) {
  throw new Error(`Refusing to clean unexpected dist path: ${distPath}`)
}

await rm(distPath, { recursive: true, force: true })
