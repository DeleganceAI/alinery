import type { ChatEntry } from "./types";

export function reconcileQueuedFollowUps(local: string[], count: number | undefined): { texts: string[]; unmatchedCount: number } {
  if (count === undefined) return { texts: local, unmatchedCount: 0 };
  if (count === 0) return { texts: [], unmatchedCount: 0 };
  if (count < local.length) return { texts: local.slice(local.length - count), unmatchedCount: 0 };
  if (count > local.length) return { texts: local, unmatchedCount: count - local.length };
  return { texts: local, unmatchedCount: 0 };
}

/** `queuedMessageCount` from this line only — sticky sessionMeta must not trim the local queue. */
export function queuedCountFromGetState(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (!("type" in value) || !("success" in value) || !("command" in value) || !("data" in value)) return undefined;
  if (value.type !== "response" || value.success !== true || value.command !== "get_state") return undefined;
  const data = value.data;
  if (typeof data !== "object" || data === null || !("queuedMessageCount" in data)) return undefined;
  const count = data.queuedMessageCount;
  return typeof count === "number" ? count : undefined;
}

export function latestQueuedFollowUp(local: string[]): string | undefined {
  return local.length === 0 ? undefined : local[local.length - 1];
}

export function queuedTextsNotInEntries(texts: string[], entries: ChatEntry[]): string[] {
  const present = new Set(entries.flatMap((entry) => (entry.type === "follow_up" ? [entry.text] : [])));
  return texts.filter((text) => !present.has(text));
}
