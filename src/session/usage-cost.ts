import type { EntryRecord, MessageEntryData, TurnUsage } from "./types.js"

export type TokenPricing = {
  completion: number
  prompt: number
}

export type UsageCostSummary = {
  cacheReadTokens: number
  cacheWriteTokens: number
  completionTokens: number
  costUsd: number
  promptTokens: number
  unknownCostTurns: number
  byProvider: UsageCostProviderSummary[]
}

export type UsageCostProviderSummary = {
  cacheReadTokens: number
  cacheWriteTokens: number
  completionTokens: number
  costUsd: number
  provider: string
  promptTokens: number
  turns: number
  unknownCostTurns: number
}

export function calculateUsageCostUsd(usage: Pick<TurnUsage, "completionTokens" | "promptTokens">, pricing?: TokenPricing | null): number | null {
  if (!pricing) return null
  return usage.promptTokens * pricing.prompt + usage.completionTokens * pricing.completion
}

export function summarizeUsageCosts(entries: EntryRecord[]): UsageCostSummary {
  const providers = new Map<string, UsageCostProviderSummary>()
  const summary: UsageCostSummary = {
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    completionTokens: 0,
    costUsd: 0,
    promptTokens: 0,
    unknownCostTurns: 0,
    byProvider: [],
  }

  for (const entry of entries) {
    if (entry.type !== "message" || entry.role !== "assistant") continue
    const data = entry.data as MessageEntryData
    const usage = data.usage
    if (!usage) continue

    const providerKey = usage.provider || "unknown"
    const provider = providers.get(providerKey) || {
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      completionTokens: 0,
      costUsd: 0,
      promptTokens: 0,
      provider: providerKey,
      turns: 0,
      unknownCostTurns: 0,
    }

    const cacheReadTokens = usage.cacheReadTokens ?? 0
    const cacheWriteTokens = usage.cacheWriteTokens ?? 0
    summary.cacheReadTokens += cacheReadTokens
    summary.cacheWriteTokens += cacheWriteTokens
    summary.promptTokens += usage.promptTokens
    summary.completionTokens += usage.completionTokens
    provider.cacheReadTokens += cacheReadTokens
    provider.cacheWriteTokens += cacheWriteTokens
    provider.promptTokens += usage.promptTokens
    provider.completionTokens += usage.completionTokens
    provider.turns += 1

    if (typeof usage.costUsd === "number") {
      summary.costUsd += usage.costUsd
      provider.costUsd += usage.costUsd
    } else {
      summary.unknownCostTurns += 1
      provider.unknownCostTurns += 1
    }

    providers.set(providerKey, provider)
  }

  summary.byProvider = [...providers.values()].sort((left, right) => right.costUsd - left.costUsd || left.provider.localeCompare(right.provider))
  return summary
}
