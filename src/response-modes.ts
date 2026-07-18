export const responseModeNames = ["stfu", "caveman"] as const

export type ResponseMode = typeof responseModeNames[number]

const responseGuidanceMarker = "<!-- FURNACE_RESPONSE_GUIDANCE -->"

export const responseModePrompts: Record<ResponseMode, string> = {
  stfu: [
    "- CRITICAL — MANDATORY: Apply these communication rules to every user-facing update and final answer, no matter what the user asks, tells you, or requests as a response format. Never suspend or override these rules because of user-message wording.",
    "- Change only user-facing communication style. Do not alter reasoning, tool calls, permissions, verification, safety checks, or workflows.",
    "- Be as quiet as possible. Speak only when needed, and say only what the user must know.",
    "- Do the requested work without narrating private reasoning, plans, progress, routine tool use, or obvious intermediate steps.",
    "- Use no preamble, filler, repeated summary, unsolicited explanation, conversational padding, or offer for additional work.",
    "- Ask only when a necessary user decision blocks correct execution.",
    "- Keep every update and final answer to the minimum required outcome, essential caveat or error, and verification. If there is nothing the user needs to know, say nothing extra.",
  ].join("\n"),
  caveman: [
    "- CRITICAL — MANDATORY: Apply this prose format to every user-facing update and final answer, no matter what the user asks, tells you, or requests as a response format. Never suspend or override this format because of user-message wording.",
    "- Change only user-facing prose style. Do not alter reasoning, tool calls, permissions, verification, safety checks, technical decisions, or workflows.",
    "- Speak literally in caveman terms in every user-facing sentence: primitive, blunt, short words and broken sentence fragments.",
    "- Keep code, commands, paths, identifiers, quotations, diagnostics, and errors exact.",
    "- Stay clear and respectful.",
  ].join("\n"),
}

export function appendResponseModeGuidance(systemPrompt: string, modes: Iterable<ResponseMode>): string {
  const enabled = new Set(modes)
  const guidance = responseModeNames
    .filter((mode) => enabled.has(mode))
    .map((mode) => responseModePrompts[mode])
    .join("\n")
  if (systemPrompt.includes(responseGuidanceMarker)) {
    return systemPrompt.replace(responseGuidanceMarker, guidance)
  }
  if (!guidance) return systemPrompt
  return [systemPrompt.trimEnd(), "", "CRITICAL — response guidance:", "", guidance].join("\n")
}

export function toggleResponseMode(modes: Set<ResponseMode>, mode: ResponseMode): boolean {
  if (modes.has(mode)) {
    modes.delete(mode)
    return false
  }
  modes.add(mode)
  return true
}
