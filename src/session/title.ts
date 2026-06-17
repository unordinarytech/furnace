import type { FurnaceConfig } from "../config.js"
import { completeOpenRouterResponse } from "../openrouter.js"

export async function generateSessionTitle(config: FurnaceConfig, firstUserPrompt: string): Promise<string> {
  const title = await completeOpenRouterResponse(
    config,
    [
      { role: "system", content: config.titleSystemPrompt },
      { role: "user", content: firstUserPrompt },
    ],
    { model: config.titleModel, maxTokens: 24 },
  )

  return sanitizeTitle(title) || fallbackTitle(firstUserPrompt)
}

export function fallbackTitle(prompt: string): string {
  return sanitizeTitle(prompt.split(/\s+/).slice(0, 5).join(" ")) || "New Chat"
}

function sanitizeTitle(title: string): string {
  return title
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
}
