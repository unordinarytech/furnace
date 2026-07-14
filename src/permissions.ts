import { resolve } from "node:path"
import type { AgentMode, PlanModeState } from "./plan-mode.js"
import { parsePatchEnvelope, summarizePatchTargets } from "./tools/patch.js"

export type PermissionAction = "allow" | "ask" | "deny"

export type PermissionDecision = "allow_once" | "allow_tool_session" | "allow_all_session" | "deny"

export type PermissionRule = {
  action: PermissionAction
  permission: string
  pattern: string
  sessionId?: string
}

export type PermissionGrantSummary = { kind: "allow_all" } | { index: number; kind: "rule"; rule: PermissionRule }

export type PermissionRequest = {
  args: string
  callId: string
  cwd: string
  description: string
  pattern: string
  permission: string
  sessionId?: string
  toolName: string
}

export type PermissionPrompt = (request: PermissionRequest) => Promise<PermissionDecision>

export class SessionPermissionStore {
  private readonly inheritedSessionIds = new Map<string, string>()
  private readonly modes = new Map<string, PlanModeState>()
  private readonly rules: PermissionRule[] = []
  private readonly allowAllSessionIds = new Set<string>()

  constructor(initialRules: PermissionRule[] = []) {
    this.rules.push(...initialRules)
  }

  inheritSession(childSessionId: string, parentSessionId: string): void {
    if (childSessionId !== parentSessionId) this.inheritedSessionIds.set(childSessionId, parentSessionId)
  }

  setSessionMode(sessionId: string, mode: AgentMode, planPath?: string): void {
    this.modes.set(sessionId, mode === "plan" ? { mode, planPath } : { mode })
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

  listSessionGrants(sessionId: string): PermissionGrantSummary[] {
    const grants: PermissionGrantSummary[] = []
    if (this.allowAllSessionIds.has(sessionId)) grants.push({ kind: "allow_all" })
    this.rules.forEach((rule, index) => {
      if (rule.sessionId === sessionId) grants.push({ index, kind: "rule", rule })
    })
    return grants
  }

  removeGrant(sessionId: string, grant: PermissionGrantSummary): void {
    if (grant.kind === "allow_all") {
      this.allowAllSessionIds.delete(sessionId)
      return
    }
    if (this.rules[grant.index] === grant.rule) this.rules.splice(grant.index, 1)
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
    const planMode = sessionIds.map((sessionId) => this.modes.get(sessionId)).find((mode) => mode?.mode === "plan")
    if (planMode?.mode === "plan") return planModePermissionAction(request, planMode)
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
      cwd: input.cwd,
    description: permissionDescription(input.toolName, pattern),
    pattern,
    permission: input.toolName,
    sessionId: input.sessionId,
    toolName: input.toolName,
  }
}

export function defaultPermissionAction(permission: string): PermissionAction {
  if (["read", "context_retrieve", "ls", "find", "glob", "grep", "ask_question", "skill", "task", "task_status", "todoread", "todowrite", "websearch", "webfetch"].includes(permission)) return "allow"
  if (["write", "edit", "bash", "skill_manage"].includes(permission)) return "ask"
  return "ask"
}

function planModePermissionAction(request: PermissionRequest, mode: PlanModeState): PermissionAction {
  if (["read", "context_retrieve", "ls", "find", "glob", "grep", "ask_question", "skill", "task", "task_status", "todoread", "todowrite", "websearch", "webfetch"].includes(request.permission)) return "allow"
  if (request.permission === "bash") return isPlanModeSafeCommand(stringArg(parseArgs(request.args), "command") || "") ? "allow" : "deny"
  if (request.permission === "write") return isPlanArtifactWrite(request, mode) ? "allow" : "deny"
  if (request.permission === "edit") return isPlanArtifactEdit(request, mode) ? "allow" : "deny"
  return "deny"
}

function isPlanArtifactWrite(request: PermissionRequest, mode: PlanModeState): boolean {
  if (!mode.planPath) return false
  const parsed = parseArgs(request.args)
  const path = stringArg(parsed, "path")
  if (!path) return false
  return sameResolvedPath(resolve(request.cwd, path), resolve(request.cwd, mode.planPath))
}

function isPlanArtifactEdit(request: PermissionRequest, mode: PlanModeState): boolean {
  if (!mode.planPath) return false
  const patch = stringArg(parseArgs(request.args), "patch")
  if (!patch) return false
  let targets
  try {
    targets = parsePatchEnvelope(patch).targets
  } catch {
    return false
  }
  if (targets.length === 0) return false
  return targets.every((target) => target.operation !== "delete" && sameResolvedPath(resolve(request.cwd, target.path), resolve(request.cwd, mode.planPath || "")))
}

function isPlanModeSafeCommand(command: string): boolean {
  if (!command.trim()) return false
  const destructive = [
    /\brm\b/i,
    /\brmdir\b/i,
    /\bmv\b/i,
    /\bcp\b/i,
    /\bmkdir\b/i,
    /\btouch\b/i,
    /\bchmod\b/i,
    /\bchown\b/i,
    /\btee\b/i,
    /\bdd\b/i,
    /(^|[^<])>(?!>)/,
    />>/,
    /\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
    /\byarn\s+(add|remove|install|publish)/i,
    /\bpnpm\s+(add|remove|install|publish)/i,
    /\bpip\s+(install|uninstall)/i,
    /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|stash|cherry-pick|revert|tag|init|clone)/i,
    /\bsudo\b/i,
    /\bkill\b/i,
    /\bpkill\b/i,
    /\bkillall\b/i,
    /\b(vim?|nano|emacs|code)\b/i,
  ]
  if (destructive.some((pattern) => pattern.test(command))) return false
  return [
    /^\s*cat\b/,
    /^\s*head\b/,
    /^\s*tail\b/,
    /^\s*less\b/,
    /^\s*more\b/,
    /^\s*grep\b/,
    /^\s*find\b/,
    /^\s*ls\b/,
    /^\s*pwd\b/,
    /^\s*echo\b/,
    /^\s*printf\b/,
    /^\s*wc\b/,
    /^\s*sort\b/,
    /^\s*uniq\b/,
    /^\s*diff\b/,
    /^\s*file\b/,
    /^\s*stat\b/,
    /^\s*du\b/,
    /^\s*df\b/,
    /^\s*tree\b/,
    /^\s*which\b/,
    /^\s*whereis\b/,
    /^\s*type\b/,
    /^\s*env\b/,
    /^\s*printenv\b/,
    /^\s*uname\b/,
    /^\s*whoami\b/,
    /^\s*id\b/,
    /^\s*date\b/,
    /^\s*ps\b/,
    /^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
    /^\s*git\s+ls-/i,
    /^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
    /^\s*yarn\s+(list|info|why|audit)/i,
    /^\s*node\s+--version/i,
    /^\s*python\s+--version/i,
    /^\s*rg\b/,
    /^\s*fd\b/,
    /^\s*jq\b/,
    /^\s*sed\s+-n/i,
    /^\s*awk\b/,
  ].some((pattern) => pattern.test(command))
}

function sameResolvedPath(left: string, right: string): boolean {
  return resolve(left) === resolve(right)
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

function permissionPattern(toolName: string, args: string): string {
  const parsed = parseArgs(args)
  if (toolName === "bash") return stringArg(parsed, "command") || "*"
  if (toolName === "webfetch") return stringArg(parsed, "url") || "*"
  if (toolName === "websearch") return stringArg(parsed, "query") || "*"
  if (toolName === "skill") return stringArg(parsed, "name") || "*"
  if (toolName === "skill_manage") return stringArg(parsed, "name") || "*"
  if (toolName === "edit") return summarizePatchTargets(stringArg(parsed, "patch") || "") || "*"
  return stringArg(parsed, "path") || stringArg(parsed, "pattern") || "*"
}

function permissionDescription(toolName: string, pattern: string): string {
  if (toolName === "bash") return `Run shell command: ${pattern}`
  if (toolName === "edit") return `Modify files: ${pattern}`
  if (toolName === "write") return `Write file: ${pattern}`
  if (toolName === "webfetch") return `Fetch URL: ${pattern}`
  if (toolName === "websearch") return `Search web: ${pattern}`
  if (toolName === "skill_manage") return `Create or update skill: ${pattern}`
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
