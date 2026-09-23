import { describe, expect, it } from "vitest";
import { applyRpcLines } from "../chatTranscript";
import { collectLiveSubagents } from "./subagents";
import type { ChatEntry, SubagentStatus } from "./types";
import { subagent } from "./types";

const at = 1;

function statusRow(subagentId: string, agent: string, status: SubagentStatus, summary = "", activity?: string): ChatEntry {
  // Phase 1 adds subagentId to the variant; the collector must key that field, not agent.
  const row = {
    id: `row-${subagentId}`,
    at,
    actor: subagent(agent),
    type: "subagent_status" as const,
    agent,
    status,
    summary,
    subagentId,
    ...(activity === undefined ? {} : { activity }),
  };
  return row as ChatEntry;
}

describe("collectLiveSubagents", () => {
  it("keeps concurrent same-type subagents as two cards keyed by OMP id", () => {
    const cards = collectLiveSubagents([statusRow("sa-1", "Explore", "running", "one"), statusRow("sa-2", "Explore", "running", "two")]);
    expect(cards).toHaveLength(2);
    const withIds: ReadonlyArray<{ id?: string }> = cards;
    expect(withIds.map((card) => card.id)).toEqual(["sa-1", "sa-2"]);
    expect(cards.map((card) => card.name)).toEqual(["Explore", "Explore"]);
  });

  it("drops completed status from the live drawer", () => {
    expect(collectLiveSubagents([statusRow("sa-1", "Explore", "completed", "done")])).toEqual([]);
  });

  it("does not insert a name-keyed card from actor-only rows", () => {
    const cards = collectLiveSubagents([{ id: "t1", at, actor: subagent("Explore"), type: "text", text: "hello" }]);
    expect(cards).toHaveLength(0);
  });

  // A subagent_event frame carries no progress, so its mapped entry has no activity and an empty
  // summary. Folding last-write-wins would blank the chip and the preview the progress frame just
  // set; the merge must keep the last non-empty value instead.
  it("keeps the last non-empty activity and preview when a later frame carries neither", () => {
    const cards = collectLiveSubagents([statusRow("sa-1", "Explore", "running", "Still searching", "using read"), statusRow("sa-1", "Explore", "running", "")]);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.activity).toBe("using read");
    expect(cards[0]?.preview).toBe("Still searching");
  });

  it("gives two concurrent same-name subagents their own activity", () => {
    const cards = collectLiveSubagents([statusRow("sa-1", "Explore", "running", "one", "using read"), statusRow("sa-2", "Explore", "running", "two", "using grep")]);
    expect(cards.map((card) => card.id)).toEqual(["sa-1", "sa-2"]);
    expect(cards.map((card) => card.activity)).toEqual(["using read", "using grep"]);
  });

  it("flips from using a tool to thinking when the tool ends", () => {
    const state = applyRpcLines([
      { type: "subagent_progress", payload: { agent: "Explore", agentSource: "bundled", progress: { id: "sa-1", status: "running", currentTool: "read" } } },
      { type: "subagent_progress", payload: { agent: "Explore", agentSource: "bundled", progress: { id: "sa-1", status: "running" } } },
    ]);
    expect(collectLiveSubagents(state.entries)[0]?.activity).toBe("thinking");
  });
});
