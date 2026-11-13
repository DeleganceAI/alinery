import type { ChatEntry } from "./types";

/**
 * The journal as the reader sees it: one row per message, each run of agent work (thinking, tool calls and their results,
 * subagent rows) folded into one strip, and a footer closing each finished turn. `role` says how a message reads:
 * `answer` is agent text with no work after it in its turn, `narration` is agent text the agent kept working past.
 */
export type JournalRole = "you" | "answer" | "narration" | "wait" | "error" | "meta";
export type JournalItem =
  | { kind: "entry"; key: string; entry: ChatEntry; role: JournalRole }
  | { kind: "work"; key: string; entries: ChatEntry[]; live: boolean }
  | { kind: "turn"; key: string; steps: number; durationMs?: number };

export function isWorkEntry(entry: ChatEntry): boolean {
  if (entry.type === "thinking" || entry.type === "redacted_thinking" || entry.type === "tool_call" || entry.type === "tool_result" || entry.type === "subagent_status") {
    return true;
  }
  return entry.actor.kind === "subagent";
}

export function isLiveWork(entry: ChatEntry): boolean {
  if (entry.type === "thinking") return Boolean(entry.streaming) && !entry.aborted;
  if (entry.type === "tool_call") return entry.status === "running";
  if (entry.type === "subagent_status") return entry.status === "running";
  return false;
}

/** A step is a unit of work; a tool's result belongs to its call's step, so it is not counted. */
export const countsAsStep = (entry: ChatEntry) => entry.type !== "tool_result";

function roleOf(entry: ChatEntry): JournalRole {
  if (entry.type === "prompt" || entry.type === "follow_up") return "you";
  if (entry.type === "text") return "answer";
  if (entry.type === "approval") return "wait";
  if (entry.type === "error" || entry.type === "abort") return "error";
  return "meta";
}

/** `running`: the last turn is still going, so it gets no footer and its last text may yet become narration. */
export function journalItems(entries: ChatEntry[], running: boolean): JournalItem[] {
  const items: JournalItem[] = [];
  let turnStart = 0;

  const closeTurn = (final: boolean) => {
    const turn = items.slice(turnStart);
    let lastWork = -1;
    for (const [at, item] of turn.entries()) if (item.kind === "work") lastWork = at;
    for (const [at, item] of turn.entries()) {
      if (item.kind === "entry" && item.role === "answer" && at < lastWork) item.role = "narration";
    }
    const first = turn[0];
    const answered = turn.some((item) => item.kind === "entry" && item.role === "answer");
    if (final && running) return;
    if (first?.kind !== "entry" || first.entry.type !== "prompt" || !answered) return;
    const steps = turn.reduce((n, item) => n + (item.kind === "work" ? item.entries.filter(countsAsStep).length : 0), 0);
    const times = turn.flatMap((item) => (item.kind === "work" ? item.entries : item.kind === "entry" ? [item.entry] : [])).map((e) => e.at ?? Number.NaN);
    const end = Math.max(...times.filter(Number.isFinite));
    const start = first.entry.at;
    items.push({ kind: "turn", key: `turn:${first.entry.id}`, steps, durationMs: start != null && Number.isFinite(end) && end > start ? end - start : undefined });
  };

  for (const entry of entries) {
    if (isWorkEntry(entry)) {
      const last = items[items.length - 1];
      if (last?.kind === "work") {
        last.entries.push(entry);
        last.live ||= isLiveWork(entry);
      } else {
        items.push({ kind: "work", key: entry.id, entries: [entry], live: isLiveWork(entry) });
      }
      continue;
    }
    if (entry.type === "prompt" && items.length > turnStart) {
      closeTurn(false);
      turnStart = items.length;
    }
    items.push({ kind: "entry", key: entry.id, entry, role: roleOf(entry) });
  }
  if (items.length > turnStart) closeTurn(true);
  return items;
}
