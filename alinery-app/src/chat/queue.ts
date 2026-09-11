import type { ChatEntry } from "./types";

export function reconcileQueuedFollowUps(local: string[], count: number | undefined): { texts: string[]; unmatchedCount: number } {
  if (count === undefined) return { texts: local, unmatchedCount: 0 };
  if (count === 0) return { texts: [], unmatchedCount: 0 };
  if (count < local.length) return { texts: local.slice(local.length - count), unmatchedCount: 0 };
  if (count > local.length) return { texts: local, unmatchedCount: count - local.length };
  return { texts: local, unmatchedCount: 0 };
}

export function dropConsumedFollowUp(local: string[], text: string): string[] {
  const index = local.indexOf(text);
  if (index < 0) return local;
  return [...local.slice(0, index), ...local.slice(index + 1)];
}

export function latestQueuedFollowUp(local: string[]): string | undefined {
  return local.length === 0 ? undefined : local[local.length - 1];
}

export function queuedTextsNotInEntries(texts: string[], entries: ChatEntry[]): string[] {
  const present = new Set(entries.flatMap((entry) => (entry.type === "prompt" || entry.type === "follow_up" ? [entry.text] : [])));
  return texts.filter((text) => !present.has(text));
}
