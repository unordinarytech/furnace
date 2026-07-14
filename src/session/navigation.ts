import type { SessionStore } from "./store.js"
import type { MessageEntryData } from "./types.js"

export function resolveForkEntryId(store: SessionStore, sessionId: string, token: string): string | undefined {
  const normalized = token.trim().toLowerCase()
  return store.listForkPoints(sessionId).find(({ entry }) => {
    const content = firstLine((entry.data as MessageEntryData).content)
    return entry.id === token
      || shortEntryId(entry.id) === token
      || entry.id.startsWith(token)
      || content.toLowerCase() === normalized
      || content.toLowerCase().startsWith(normalized)
  })?.entry.id
}

function shortEntryId(id: string): string {
  const value = id.startsWith("ent_") ? id.slice(4) : id
  return value.split("-")[0] || value.slice(0, 8)
}

function firstLine(value: string, max = 72): string {
  const line = value.trim().replace(/\s+/g, " ").split("\n")[0] || ""
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}
