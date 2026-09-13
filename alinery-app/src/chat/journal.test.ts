import { describe, expect, it } from "vitest";
import { formatComposerStats, formatContextUsage, formatDuration } from "./format";
import { explodeAssistantParts } from "./journal";
import { collectLiveSubagents } from "./subagents";
import { ACTOR, type ChatEntry, subagent } from "./types";

describe("formatDuration", () => {
  it("uses ms then seconds", () => {
    expect(formatDuration(82)).toBe("82ms");
    expect(formatDuration(1180)).toBe("1.2s");
    expect(formatDuration(14600)).toBe("15s");
  });
});

describe("formatContextUsage", () => {
  it("renders used/window in thousands", () => {
    expect(formatContextUsage(19200, 128000)).toBe("19.2k/128k");
    expect(formatContextUsage(undefined, 128000)).toBe("");
  });
});

describe("formatComposerStats", () => {
  it("formats the draft as a locale char count", () => {
    expect(formatComposerStats(128)).toBe("128 chars");
    expect(formatComposerStats(0)).toBe("0 chars");
  });
});

describe("explodeAssistantParts", () => {
  it("keeps thinking, text, and toolCall as sibling rows", () => {
    const rows = explodeAssistantParts(
      [
        { type: "thinking", thinking: "plan", streaming: true },
        { type: "text", text: "323" },
        { type: "toolCall", id: "t1", name: "read", args: { path: "a.ts" } },
      ],
      (key) => key,
      1,
      false,
    );
    expect(rows.map((r) => r.type)).toEqual(["thinking", "text", "tool_call"]);
    expect(rows[0]).toMatchObject({ type: "thinking", text: "plan", streaming: true });
    expect(rows[1]).toMatchObject({ type: "text", text: "323" });
    expect(rows[2]).toMatchObject({ type: "tool_call", tool: "read", target: "a.ts", status: "ok" });
  });

  it("reuses ids so a later snapshot patches in place", () => {
    const first = explodeAssistantParts([{ type: "thinking", thinking: "a", streaming: true }], (key) => key, 1, false);
    const second = explodeAssistantParts([{ type: "thinking", thinking: "ab" }], (key) => key, 1, true);
    expect(first[0].id).toBe(second[0].id);
    expect(second[0]).toMatchObject({ type: "thinking", text: "ab", aborted: true });
  });
});

describe("collectLiveSubagents", () => {
  it("keeps spawned/running/waiting and drops completed", () => {
    const entries: ChatEntry[] = [
      {
        id: "1",
        actor: subagent("plan"),
        type: "subagent_status",
        subagentId: "sa-plan",
        agent: "plan",
        role: "architect",
        status: "running",
        summary: "drafting",
      },
      {
        id: "2",
        actor: subagent("explore"),
        type: "subagent_status",
        subagentId: "sa-explore",
        agent: "explore",
        status: "completed",
        summary: "done",
      },

      {
        id: "3",
        actor: ACTOR.agent,
        type: "text",
        text: "ok",
      },
    ];
    expect(collectLiveSubagents(entries).map((s) => s.name)).toEqual(["plan"]);
  });
});
