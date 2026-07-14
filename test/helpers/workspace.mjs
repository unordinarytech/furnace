import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export async function withTemporaryWorkspace(prefix, fn) {
  const cwd = await mkdtemp(join(tmpdir(), prefix))
  try {
    return await fn(cwd)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

export async function withTemporaryHomeWorkspace(prefix, fn) {
  const cwd = await mkdtemp(join(tmpdir(), `${prefix}workspace-`))
  const home = await mkdtemp(join(tmpdir(), `${prefix}home-`))
  const previousHome = process.env.HOME
  process.env.HOME = home
  try {
    return await fn(cwd, home)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await Promise.all([
      rm(cwd, { recursive: true, force: true }),
      rm(home, { recursive: true, force: true }),
    ])
  }
}
