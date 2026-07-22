import type { ModelSettings } from "../preferences.js"

/**
 * DeepSeek V4 (and reasoner) models default to thinking mode.
 * Thinking mode rejects tool_choice values other than omitting the field /
 * using auto after thinking is disabled — forced function tool_choice 400s with:
 * "Thinking mode does not support this tool_choice".
 */
export function isDeepSeekThinkingModel(model: string): boolean {
  const id = model.toLowerCase()
  return /deepseek-v4-(flash|pro)/.test(id)
    || /(^|\/)deepseek-reasoner(\b|$)/.test(id)
    || /(^|\/)deepseek-r1/.test(id)
}

/** User explicitly opted into a reasoning budget. */
export function wantsReasoningEffort(settings: ModelSettings): boolean {
  return Boolean(settings.reasoningEffort && settings.reasoningEffort !== "none")
}

/**
 * For agent tool turns on DeepSeek thinking models, disable thinking unless the
 * user turned reasoning on. Flash/Pro think by default otherwise, which breaks
 * normal tool use.
 */
export function shouldDisableThinkingForTools(model: string, settings: ModelSettings): boolean {
  return isDeepSeekThinkingModel(model) && !wantsReasoningEffort(settings)
}

/**
 * When thinking stays enabled on DeepSeek V4, omit tool_choice entirely
 * (vendor + Oh My Pi guidance). Forced function tool_choice always fails.
 */
export function shouldOmitToolChoice(model: string, settings: ModelSettings): boolean {
  return isDeepSeekThinkingModel(model) && wantsReasoningEffort(settings)
}

export function supportsForcedToolChoice(model: string, settings: ModelSettings): boolean {
  if (!isDeepSeekThinkingModel(model)) return true
  // With thinking disabled for the tool loop, forced choice is allowed.
  return shouldDisableThinkingForTools(model, settings)
}
