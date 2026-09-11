import type { ChatEntry, SubagentStatus } from "./types";

export type LiveSubagent = {
  id: string;
  name: string;
  role?: string;
  status: SubagentStatus;
  preview: string;
  tools?: number;
  durationMs?: number;
  at?: number;
};

const LIVE: SubagentStatus[] = ["spawned", "running", "waiting"];

export function collectLiveSubagents(entries: ChatEntry[]): LiveSubagent[] {
  const map = new Map<string, LiveSubagent>();
  for (const e of entries) {
    if (e.type === "subagent_status") {
      map.set(e.subagentId, {
        id: e.subagentId,
        name: e.agent,
        role: e.role,
        status: e.status,
        preview: e.summary,
        tools: e.tools,
        durationMs: e.durationMs,
        at: e.at,
      });
      continue;
    }
    if (e.actor.kind !== "subagent") continue;
    let targetId: string | undefined;
    for (const [id, cur] of map) {
      if (cur.name === e.actor.name) targetId = id;
    }
    if (!targetId) continue;
    const cur = map.get(targetId);
    if (!cur) continue;
    if (e.type === "harness") cur.preview = firstLine(e.text);
    else if (e.type === "text") cur.preview = firstLine(e.text);
    else if (e.type === "tool_call") cur.preview = `used ${e.tool}`;
    else if (e.type === "thinking") cur.preview = firstLine(e.text);
    cur.at = e.at;
    map.set(targetId, cur);
  }
  return [...map.values()].filter((s) => LIVE.includes(s.status));
}

function firstLine(text: string) {
  return text.split("\n")[0] ?? text;
}
