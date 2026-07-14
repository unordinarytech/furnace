import type { FurnaceConfig } from "../config.js"
import { loadCustomProviders } from "../providers/custom.js"
import type { ProviderModel } from "../providers/catalog.js"
import { BUILTIN_PROVIDERS } from "../providers/registry.js"
import { createResolvedProvider, resolveProviderKey } from "../providers/resolution.js"
import type { ProviderDefinition } from "../providers/types.js"
import type { RepoIndexPolicy } from "../preferences.js"
import {
  generateRepoIndex,
  probeRepoGit,
  readRepoIndexMeta,
  updateRepoIndexMeta,
  type RepoGitState,
  type RepoIndexMeta,
} from "./core.js"

export type RepoIndexRunReason = "manual" | "onboarding" | "upstream-changed"
export type RepoIndexServiceStatus = {
  message: string
  state: "failed" | "idle" | "running" | "success" | "warning"
}

export type RepoIndexService = {
  request(reason: RepoIndexRunReason): Promise<boolean>
  setPolicy(policy: RepoIndexPolicy): void
  stop(): void
}

type TimerHandle = ReturnType<typeof setInterval>

export function createRepoIndexService(input: {
  config: FurnaceConfig
  cwd: string
  generate?: typeof generateRepoIndex
  getModels(): Promise<ProviderModel[]>
  intervalMs?: number
  onStatus(status: RepoIndexServiceStatus): void
  probeGit?: typeof probeRepoGit
  readMeta?: typeof readRepoIndexMeta
  resolveBackgroundConfig?: typeof resolveBackgroundRepoIndexConfig
  updateMeta?: typeof updateRepoIndexMeta
  setInterval?: typeof setInterval
  clearInterval?: typeof clearInterval
}): RepoIndexService {
  const generate = input.generate ?? generateRepoIndex
  const probeGit = input.probeGit ?? probeRepoGit
  const readMeta = input.readMeta ?? readRepoIndexMeta
  const resolveBackgroundConfig = input.resolveBackgroundConfig ?? resolveBackgroundRepoIndexConfig
  const updateMeta = input.updateMeta ?? updateRepoIndexMeta
  const setIntervalFn = input.setInterval ?? setInterval
  const clearIntervalFn = input.clearInterval ?? clearInterval
  const intervalMs = input.intervalMs ?? 15_000
  let disposed = false
  let policy: RepoIndexPolicy = input.config.repoIndexPolicy
  let timer: TimerHandle | undefined
  let running: Promise<boolean> | undefined

  const emit = (status: RepoIndexServiceStatus): void => {
    if (!disposed) input.onStatus(status)
  }

  const run = async (reason: RepoIndexRunReason): Promise<boolean> => {
    if (disposed) return false
    if (running) {
      if (reason !== "manual") return running
      const active = running
      await active.catch(() => false)
      if (running === active) running = undefined
      if (disposed) return false
      return run(reason)
    }

    const job = (async () => {
      emit({
        message: reason === "upstream-changed"
          ? "Reindexing repository after upstream change…"
          : "Learning about repo will be done shortly.",
        state: "running",
      })
      const models = await input.getModels().catch(() => [] as ProviderModel[])
      const config = reason === "upstream-changed"
        ? await resolveBackgroundConfig(input.config, models)
        : input.config
      if (!config.apiKey) {
        emit({ message: "Repo reindex skipped: no supported provider key is configured.", state: "warning" })
        return false
      }
      try {
        await generate({ config, cwd: input.cwd, models })
        emit({ message: "Repository index updated.", state: "success" })
        return true
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        emit({ message: `Repo reindex failed: ${message}`, state: "failed" })
        return false
      }
    })()
    running = job
    try {
      return await job
    } finally {
      if (running === job) running = undefined
    }
  }

  const checkUpstream = async (): Promise<void> => {
    if (disposed || policy !== "every-git-push") return
    const git = await probeGit(input.cwd)
    if (!git?.upstreamOid) return
    const meta = await readMeta(git.root)
    if (!meta?.indexedUpstreamOid) {
      await updateMeta(git.root, (current) => baselineMeta(current, git))
      return
    }
    if (meta.indexedUpstreamOid !== git.upstreamOid) void run("upstream-changed")
  }

  const stopTimer = (): void => {
    if (!timer) return
    clearIntervalFn(timer)
    timer = undefined
  }

  const setPolicy = (nextPolicy: RepoIndexPolicy): void => {
    policy = nextPolicy
    stopTimer()
    if (disposed || policy !== "every-git-push") return
    void checkUpstream()
    timer = setIntervalFn(() => { void checkUpstream() }, intervalMs)
    timer.unref?.()
  }

  setPolicy(policy)

  return {
    request: run,
    setPolicy,
    stop() {
      disposed = true
      stopTimer()
      emit({ message: "", state: "idle" })
    },
  }
}

export async function resolveBackgroundRepoIndexConfig(
  config: FurnaceConfig,
  models: ProviderModel[],
): Promise<FurnaceConfig> {
  const customProviders = await loadCustomProviders().catch(() => [])
  const preferredIds = config.provider === "anthropic" || config.provider === "openrouter"
    ? [config.provider, config.provider === "anthropic" ? "openrouter" : "anthropic", "openai"]
    : ["anthropic", "openrouter", "openai"]

  for (const providerId of preferredIds) {
    const definition = BUILTIN_PROVIDERS.find((candidate) => candidate.id === providerId)
    if (!definition) continue
    const { apiKey } = await resolveProviderKey(definition, customProviders)
    if (!apiKey) continue
    const model = selectCheapIndexModel(definition, models)
    return {
      ...config,
      apiKey,
      model,
      modelSettings: { fast: true },
      provider: definition.id,
      providerConfig: {
        ...createResolvedProvider(definition, apiKey, config),
        defaultModel: model,
      },
    }
  }
  return { ...config, apiKey: "" }
}

function selectCheapIndexModel(definition: ProviderDefinition, models: ProviderModel[]): string {
  const candidates = models.filter((model) => model.providerId === definition.id)
  const patterns = definition.id === "openai"
    ? [/gpt-4o-mini/i, /gpt-4\.1-mini/i, /\bmini\b/i]
    : definition.id === "anthropic"
      ? [/claude-haiku-4-5/i, /haiku.*4[.-]?5/i, /haiku/i]
      : [/anthropic\/claude-haiku-4\.5/i, /haiku.*4[.-]?5/i, /claude.*haiku/i]
  for (const pattern of patterns) {
    const match = candidates.find((candidate) => pattern.test(`${candidate.id} ${candidate.name}`))
    if (match) return match.id
  }
  if (definition.id === "openai") return "gpt-4o-mini"
  if (definition.id === "anthropic") return "claude-haiku-4-5"
  return "anthropic/claude-haiku-4.5"
}

function baselineMeta(meta: RepoIndexMeta | null, git: RepoGitState): RepoIndexMeta {
  return {
    fileCount: meta?.fileCount ?? 0,
    generatedAt: meta?.generatedAt ?? new Date().toISOString(),
    gitHead: meta?.gitHead ?? git.headOid,
    indexedUpstreamOid: git.upstreamOid,
    indexedUpstreamRef: git.upstreamRef,
    onboardingDecision: meta?.onboardingDecision,
    packageName: meta?.packageName ?? null,
    version: 2,
  }
}
