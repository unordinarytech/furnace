export type PatchTarget = {
  operation: "add" | "delete" | "update"
  path: string
}

export type PatchOperation =
  | (PatchTarget & { operation: "add"; contentLines: string[] })
  | (PatchTarget & { operation: "delete" })
  | (PatchTarget & { operation: "update"; hunks: Array<{ newLines: string[]; oldLines: string[] }> })

export type ParsedPatch = {
  operations: PatchOperation[]
  targets: PatchTarget[]
}

export function parsePatchEnvelope(patch: string): ParsedPatch {
  const lines = patch.replace(/\r\n/g, "\n").split("\n")
  if (lines[0] !== "*** Begin Patch") throw new Error("Patch must start with *** Begin Patch")
  if (!lines.some((line) => line === "*** End Patch")) throw new Error("Patch must end with *** End Patch")
  if (lines.some((line) => line.startsWith("--- ") || line.startsWith("+++ "))) {
    throw new Error("Unified diff syntax is not supported. Use Furnace patch envelope syntax: *** Begin Patch, *** Update File: <path>, @@, context/removal/addition lines, *** End Patch.")
  }

  const operations: PatchOperation[] = []
  let index = 1
  while (index < lines.length) {
    const line = lines[index]
    if (line === "*** End Patch") break
    if (!line) {
      index += 1
      continue
    }

    const addPath = operationPath(line, "*** Add File: ")
    if (addPath !== undefined) {
      const contentLines: string[] = []
      index += 1
      while (index < lines.length && !lines[index].startsWith("*** ") && !lines[index].startsWith("@@")) {
        const current = lines[index]
        if (!current.startsWith("+")) throw new Error(`Add file lines must start with + near ${addPath}`)
        contentLines.push(current.slice(1))
        index += 1
      }
      operations.push({ contentLines, operation: "add", path: addPath })
      continue
    }

    const updatePath = operationPath(line, "*** Update File: ")
    if (updatePath !== undefined) {
      const hunks: Array<{ newLines: string[]; oldLines: string[] }> = []
      index += 1
      while (index < lines.length && !lines[index].startsWith("*** ")) {
        if (!lines[index].startsWith("@@")) throw new Error(`Expected hunk header in ${updatePath}`)
        index += 1
        const oldLines: string[] = []
        const newLines: string[] = []
        while (index < lines.length && !lines[index].startsWith("@@") && !lines[index].startsWith("*** ")) {
          const current = lines[index]
          if (current === "*** End of File") {
            index += 1
            continue
          }
          const marker = current[0]
          const text = current.slice(1)
          if (marker === " ") {
            oldLines.push(text)
            newLines.push(text)
          } else if (marker === "-") {
            oldLines.push(text)
          } else if (marker === "+") {
            newLines.push(text)
          } else if (current === "") {
            oldLines.push("")
            newLines.push("")
          } else {
            throw new Error(`Invalid hunk line in ${updatePath}: ${current}`)
          }
          index += 1
        }
        hunks.push({ newLines, oldLines })
      }
      operations.push({ hunks, operation: "update", path: updatePath })
      continue
    }

    const deletePath = operationPath(line, "*** Delete File: ")
    if (deletePath !== undefined) {
      operations.push({ operation: "delete", path: deletePath })
      index += 1
      continue
    }

    throw new Error(`Unknown patch operation: ${line}. Expected *** Add File:, *** Update File:, *** Delete File:, or *** End Patch.`)
  }

  return {
    operations,
    targets: operations.map(({ operation, path }) => ({ operation, path })),
  }
}

export function summarizePatchTargets(patch: string): string {
  try {
    return parsePatchEnvelope(patch).targets.map((target) => target.path).join(", ")
  } catch {
    return ""
  }
}

function operationPath(line: string, prefix: string): string | undefined {
  if (!line.startsWith(prefix)) return undefined
  const path = line.slice(prefix.length).trim()
  if (!path) throw new Error(`${prefix.trim()} requires a path`)
  return path
}
