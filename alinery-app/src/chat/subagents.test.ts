import { describe, expect, it } from "vitest";
import { collectLiveSubagents } from "./subagents";
import type { ChatEntry, SubagentStatus } from "./types";
import { subagent } from "./types";

const at = 1;

function statusRow(subagentId: string, agent: string, status: SubagentStatus, summary = ""): ChatEntry {
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
});
