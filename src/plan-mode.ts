import { relative, resolve, sep } from "node:path"
import type { SessionStore } from "./session/store.js"
import type { EntryRecord } from "./session/types.js"

export type AgentMode = "agent" | "plan"

export type PlanModeState = {
  mode: AgentMode
  planPath?: string
}

export type PlanModeEntryData = {
  kind: "mode_change"
  mode: AgentMode
  planPath?: string
  reason?: "user" | "tool" | "resume" | "inherited"
}

export function currentPlanModeState(entries: EntryRecord[]): PlanModeState {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry.type !== "custom") continue
    const data = entry.data as Partial<PlanModeEntryData>
    if (data.kind !== "mode_change") continue
    if (data.mode !== "agent" && data.mode !== "plan") continue
    return data.mode === "plan" ? { mode: "plan", planPath: data.planPath } : { mode: "agent" }
  }
  return { mode: "agent" }
}

export function transitionPlanMode(input: {
  cwd: string
  mode: AgentMode
  planPath?: string
  reason: NonNullable<PlanModeEntryData["reason"]>
  seed?: string
  sessionId: string
  store: SessionStore
}): PlanModeState {
  const current = currentPlanModeState(input.store.getActivePath(input.sessionId))
  const planPath = input.mode === "plan"
    ? input.planPath || current.planPath || createPlanPath(input.cwd, input.seed || input.store.getSession(input.sessionId).title)
    : undefined
  input.store.appendEntry<PlanModeEntryData>(input.sessionId, "custom", null, {
    kind: "mode_change",
    mode: input.mode,
    planPath,
    reason: input.reason,
  })
  return input.mode === "plan" ? { mode: "plan", planPath } : { mode: "agent" }
}

export function createPlanPath(cwd: string, seed: string, now = new Date()): string {
  const timestamp = [
    now.getFullYear(),
    "-",
    String(now.getMonth() + 1).padStart(2, "0"),
    "-",
    String(now.getDate()).padStart(2, "0"),
    "_",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("")
  return `.furnace/plans/${timestamp}-${slugify(seed || "plan")}.md`
}

export function appendPlanModeGuidance(systemPrompt: string, state: PlanModeState): string {
  if (state.mode !== "plan") return systemPrompt
  const planPath = state.planPath || ".furnace/plans/plan.md"
  return [
    systemPrompt,
    "",
    "<plan_mode>",
    "Plan mode is active. The user wants research and planning before implementation.",
    "",
    "Hard rules:",
    "- Do not implement code or modify project files.",
    `- The only writable artifact is the plan file: ${planPath}`,
    "- Do not run mutating shell commands, install dependencies, commit, push, or change configuration.",
    "- Use read/search/web/question/subagent exploration to understand the work.",
    "- If the task is ambiguous, ask focused clarification questions.",
    "",
    "Plan quality:",
    "- Keep the plan concrete, concise, and actionable.",
    "- Include exact file paths likely to change.",
    "- Include commands/tests/verification steps.",
    "- Include risks, tradeoffs, and open questions when relevant.",
    "- Prefer bite-sized steps that can be executed one at a time.",
    "",
    "Plan artifact:",
    `- Write or update ${planPath} with the final recommended approach.`,
    "- After saving the plan, reply briefly with the saved path and any remaining blocker. Furnace will render the saved artifact for review.",
    "</plan_mode>",
  ].join("\n")
}

export function renderPlanExecutionPrompt(planPath: string): string {
  return [
    `The user approved the plan at ${planPath}.`,
    "",
    "Read the plan file, then implement it in normal agent mode.",
    "Follow the plan's verification section and mention any deviations in the final response.",
  ].join("\n")
}

export function renderVisiblePlanArtifact(assistantText: string, planPath: string, planContent: string): string {
  const content = planContent.trim()
  if (!content) return assistantText
  const intro = assistantText.trim() || "Plan created."
  return [
    intro,
    "",
    "## Saved Plan",
    "",
    `Path: \`${planPath}\``,
    "",
    content,
  ].join("\n")
}

export function displayPath(cwd: string, file: string): string {
  const normalizedCwd = resolve(cwd)
  const normalizedFile = resolve(cwd, file)
  const relativeFile = relative(normalizedCwd, normalizedFile)
  if (relativeFile === "") return "."
  if (!relativeFile.startsWith("..") && !relativeFile.includes(`..${sep}`)) return relativeFile
  return normalizedFile
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
  return slug || "plan"
}
