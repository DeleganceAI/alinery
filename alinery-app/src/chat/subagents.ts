import type { ChatEntry, SubagentStatus } from "./types";

export type LiveSubagent = {
  id: string;
  name: string;
  status: SubagentStatus;
  preview: string;
  /** Live activity label from the latest progress snapshot; absent until one arrives. */
  activity?: string;
  tools?: number;
  durationMs?: number;
  at?: number;
};

const LIVE: SubagentStatus[] = ["spawned", "running", "waiting"];

export function collectLiveSubagents(entries: ChatEntry[]): LiveSubagent[] {
  const map = new Map<string, LiveSubagent>();
  for (const e of entries) {
    if (e.type !== "subagent_status") continue;
    const prev = map.get(e.subagentId);
    map.set(e.subagentId, {
      id: e.subagentId,
      name: e.agent,
      // Status is last-write-wins: a terminal frame must still settle the card.
      status: e.status,
      // The rest is last-non-empty-wins: a `subagent_event` frame carries no activity and an
      // empty summary (see applySubagent) and must not wipe the progress label.
      preview: e.summary || prev?.preview || "",
      activity: e.activity || prev?.activity,
      tools: e.tools ?? prev?.tools,
      durationMs: e.durationMs ?? prev?.durationMs,
      at: e.at ?? prev?.at,
    });
  }
  return [...map.values()].filter((s) => LIVE.includes(s.status));
}
