export type PermissionAction = "allow" | "ask" | "deny"

export type PermissionDecision = "allow_once" | "allow_tool_session" | "allow_all_session" | "deny"

export type PermissionRule = {
  action: PermissionAction
  permission: string
  pattern: string
  sessionId?: string
}

export type PermissionRequest = {
  args: string
  callId: string
  description: string
  pattern: string
  permission: string
  sessionId?: string
  toolName: string
}

export type PermissionPrompt = (request: PermissionRequest) => Promise<PermissionDecision>

export class SessionPermissionStore {
  private readonly inheritedSessionIds = new Map<string, string>()
  private readonly rules: PermissionRule[] = []
  private readonly allowAllSessionIds = new Set<string>()

  constructor(initialRules: PermissionRule[] = []) {
    this.rules.push(...initialRules)
  }

  inheritSession(childSessionId: string, parentSessionId: string): void {
    if (childSessionId !== parentSessionId) this.inheritedSessionIds.set(childSessionId, parentSessionId)
  }

  async authorize(request: PermissionRequest, prompt?: PermissionPrompt): Promise<PermissionDecision> {
    const action = this.evaluate(request)
    if (action === "allow") return "allow_once"
    if (action === "deny") return "deny"
    if (!prompt) return "deny"

    const decision = await prompt(request)
    this.applyDecision(request, decision)
    return decision
  }

  applyDecision(request: PermissionRequest, decision: PermissionDecision): void {
    if (decision === "allow_all_session" && request.sessionId) {
      this.allowAllSessionIds.add(request.sessionId)
      return
    }
    if (decision === "allow_tool_session" && request.sessionId) {
      this.rules.push({
        action: "allow",
        permission: request.permission,
        pattern: "*",
        sessionId: request.sessionId,
      })
    }
  }

  clearSession(sessionId: string): number {
    let removed = 0
    if (this.inheritedSessionIds.delete(sessionId)) removed += 1
    if (this.allowAllSessionIds.delete(sessionId)) removed += 1
    for (let index = this.rules.length - 1; index >= 0; index -= 1) {
      if (this.rules[index].sessionId !== sessionId) continue
      this.rules.splice(index, 1)
      removed += 1
    }
    return removed
  }

  evaluate(request: PermissionRequest): PermissionAction {
    const sessionIds = permissionSessionLineage(request.sessionId, this.inheritedSessionIds)
    if (sessionIds.some((sessionId) => this.allowAllSessionIds.has(sessionId))) return "allow"

    for (let index = this.rules.length - 1; index >= 0; index -= 1) {
      const rule = this.rules[index]
      if (rule.sessionId && !sessionIds.includes(rule.sessionId)) continue
      if (!wildcardMatch(rule.permission, request.permission)) continue
      if (!wildcardMatch(rule.pattern, request.pattern)) continue
      return rule.action
    }

    return defaultPermissionAction(request.permission)
  }
}

export function createToolPermissionRequest(input: {
  args: string
  callId: string
  cwd: string
  sessionId?: string
  toolName: string
}): PermissionRequest {
  const pattern = permissionPattern(input.toolName, input.args)
  return {
    args: input.args,
    callId: input.callId,
    description: permissionDescription(input.toolName, pattern),
    pattern,
    permission: permissionName(input.toolName),
    sessionId: input.sessionId,
    toolName: input.toolName,
  }
}

export function defaultPermissionAction(permission: string): PermissionAction {
  if (["read", "ls", "find", "glob", "grep", "ask_question", "task", "task_status", "websearch", "webfetch"].includes(permission)) return "allow"
  if (["write", "edit", "bash"].includes(permission)) return "ask"
  return "ask"
}

function permissionSessionLineage(sessionId: string | undefined, inheritedSessionIds: Map<string, string>): string[] {
  if (!sessionId) return []
  const lineage = [sessionId]
  const seen = new Set(lineage)
  let current = sessionId
  while (true) {
    const parent = inheritedSessionIds.get(current)
    if (!parent || seen.has(parent)) return lineage
    lineage.push(parent)
    seen.add(parent)
    current = parent
  }
}

function permissionName(toolName: string): string {
  if (toolName === "write" || toolName === "edit") return toolName
  return toolName
}

function permissionPattern(toolName: string, args: string): string {
  const parsed = parseArgs(args)
  if (toolName === "bash") return stringArg(parsed, "command") || "*"
  if (toolName === "webfetch") return stringArg(parsed, "url") || "*"
  if (toolName === "websearch") return stringArg(parsed, "query") || "*"
  if (toolName === "edit") return summarizePatchTargets(stringArg(parsed, "patch") || "") || "*"
  return stringArg(parsed, "path") || stringArg(parsed, "pattern") || "*"
}

function permissionDescription(toolName: string, pattern: string): string {
  if (toolName === "bash") return `Run shell command: ${pattern}`
  if (toolName === "edit") return `Modify files: ${pattern}`
  if (toolName === "write") return `Write file: ${pattern}`
  if (toolName === "webfetch") return `Fetch URL: ${pattern}`
  if (toolName === "websearch") return `Search web: ${pattern}`
  return `Use ${toolName}: ${pattern}`
}

function parseArgs(args: string): Record<string, unknown> {
  try {
    const parsed = args.trim() ? JSON.parse(args) : {}
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function summarizePatchTargets(patch: string): string {
  const targets = patch
    .replace(/\r\n/g, "\n")
    .split("\n")
    .flatMap((line) => {
      if (line.startsWith("*** Add File: ")) return [line.slice("*** Add File: ".length).trim()]
      if (line.startsWith("*** Update File: ")) return [line.slice("*** Update File: ".length).trim()]
      if (line.startsWith("*** Delete File: ")) return [line.slice("*** Delete File: ".length).trim()]
      return []
    })
    .filter(Boolean)
  return targets.join(", ")
}

function wildcardMatch(pattern: string, value: string): boolean {
  if (pattern === "*") return true
  let source = "^"
  for (const char of pattern) {
    if (char === "*") source += ".*"
    else if (char === "?") source += "."
    else source += escapeRegExp(char)
  }
  source += "$"
  return new RegExp(source).test(value)
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&")
}
