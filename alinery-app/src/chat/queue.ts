import type { DraftAttachment } from "./attachments";
import type { ChatEntry } from "./types";

export type QueuedFollowUp = { text: string; attachments: DraftAttachment[]; dispatchId?: string; entryId?: string };

export function latestQueuedFollowUp<T>(local: T[]): T | undefined {
  return local.length === 0 ? undefined : local[local.length - 1];
}

/** Generic chat's count projection must never consume protected dispatch-tagged input. */
export function trimQueuedFollowUps(entries: ChatEntry[], count: number): ChatEntry[] {
  let remaining = entries.filter((entry) => entry.type === "follow_up" && !entry.id.startsWith("dispatch:")).length - count;
  if (remaining <= 0) return entries;
  return entries.filter((entry) => {
    if (remaining > 0 && entry.type === "follow_up" && !entry.id.startsWith("dispatch:")) {
      remaining -= 1;
      return false;
    }
    return true;
  });
}

export function queuedCountFromGetState(value: unknown): number | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    !("type" in value) ||
    value.type !== "response" ||
    !("command" in value) ||
    value.command !== "get_state" ||
    !("success" in value) ||
    value.success !== true ||
    !("data" in value) ||
    !value.data ||
    typeof value.data !== "object" ||
    !("queuedMessageCount" in value.data)
  )
    return undefined;
  const count = value.data.queuedMessageCount;
  return typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : undefined;
}
