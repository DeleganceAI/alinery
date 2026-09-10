import { describe, expect, it } from "vitest";
import { ACTOR, type ChatEntry, subagent } from "./types";
import { chatActivityLabel, chatVisibilityFromAppearance, DEFAULT_CHAT_VISIBILITY, visibleChatEntries, workRailDefaultExpanded } from "./visibility";

const thinking: ChatEntry = { id: "1", actor: ACTOR.agent, type: "thinking", text: "plan" };
const tool: ChatEntry = { id: "2", actor: ACTOR.agent, type: "tool_call", tool: "read", status: "ok" };
const text: ChatEntry = { id: "3", actor: ACTOR.agent, type: "text", text: "hi" };
const harness: ChatEntry = { id: "4", actor: ACTOR.omp, type: "harness", event: "model_changed", text: "xai/grok" };
const turn: ChatEntry = { id: "5", actor: ACTOR.omp, type: "turn_marker", turn: 1, phase: "end" };
const subRow: ChatEntry = {
  id: "6",
  actor: subagent("plan"),
  type: "subagent_status",
  agent: "plan",
  status: "running",
  summary: "drafting",
};

const showAll = { ...DEFAULT_CHAT_VISIBILITY, showThinking: true, showTools: true, showTurnMarkers: true, showSubagentRows: true };

describe("visibleChatEntries", () => {
  it("keeps replies and filters thinking/tools by prefs", () => {
    const all = [thinking, tool, text];
    expect(visibleChatEntries(all, DEFAULT_CHAT_VISIBILITY).map((e) => e.type)).toEqual(["text"]);
    expect(visibleChatEntries(all, showAll).map((e) => e.type)).toEqual(["thinking", "tool_call", "text"]);
    expect(visibleChatEntries(all, { ...showAll, showThinking: false }).map((e) => e.type)).toEqual(["tool_call", "text"]);
    expect(visibleChatEntries(all, { ...showAll, showTools: false }).map((e) => e.type)).toEqual(["thinking", "text"]);
  });

  it("filters harness, turn markers, and subagent journal rows", () => {
    const all = [harness, turn, subRow, text];
    expect(visibleChatEntries(all, DEFAULT_CHAT_VISIBILITY).map((e) => e.type)).toEqual(["harness", "text"]);
    expect(visibleChatEntries(all, { ...showAll, showHarness: false }).map((e) => e.type)).toEqual(["turn_marker", "subagent_status", "text"]);
    expect(visibleChatEntries(all, { ...DEFAULT_CHAT_VISIBILITY, showTurnMarkers: true }).map((e) => e.type)).toEqual(["harness", "turn_marker", "text"]);
    expect(visibleChatEntries(all, { ...DEFAULT_CHAT_VISIBILITY, showSubagentRows: true }).map((e) => e.type)).toEqual(["harness", "subagent_status", "text"]);
  });
});

describe("workRailDefaultExpanded", () => {
  it("follows expand prefs per kind", () => {
    expect(workRailDefaultExpanded(thinking, DEFAULT_CHAT_VISIBILITY)).toBe(false);
    expect(workRailDefaultExpanded(thinking, { ...DEFAULT_CHAT_VISIBILITY, expandThinking: true })).toBe(true);
    expect(workRailDefaultExpanded(tool, { ...DEFAULT_CHAT_VISIBILITY, expandTools: true })).toBe(true);
  });
});

describe("chatVisibilityFromAppearance", () => {
  it("defaults journal chrome off and density normal when absent", () => {
    expect(chatVisibilityFromAppearance({})).toEqual(DEFAULT_CHAT_VISIBILITY);
    expect(
      chatVisibilityFromAppearance({
        chat_show_thinking: true,
        chat_expand_thinking: true,
        chat_rail_density: "dense",
        chat_font_size: 18,
        chat_rail_font_size: 14,
        chat_max_width: "600",
        chat_show_date: true,
        chat_show_actor_labels: true,
        chat_show_agent_bubbles: true,
      }),
    ).toEqual({
      ...DEFAULT_CHAT_VISIBILITY,
      showThinking: true,
      expandThinking: true,
      railDensity: "dense",
      fontSize: 18,
      railFontSize: 14,
      maxWidth: "600",
      showDate: true,
      showActorLabels: true,
      showAgentBubbles: true,
    });
  });

  it("uses the default for unsupported density values", () => {
    expect(chatVisibilityFromAppearance({ chat_rail_density: "compact" }).railDensity).toBe("normal");
  });
});

describe("chatActivityLabel", () => {
  it("is null when idle and labels busy states", () => {
    expect(chatActivityLabel("idle", [])).toBeNull();
    expect(chatActivityLabel("waiting_approval", [])).toBe("Waiting for approval…");
    expect(chatActivityLabel("running", [])).toBe("Working…");
    expect(chatActivityLabel("running", [{ id: "1", actor: ACTOR.agent, type: "thinking", text: "plan", streaming: true }])).toBe("Thinking…");
    expect(chatActivityLabel("running", [{ id: "1", actor: ACTOR.agent, type: "tool_call", tool: "read", status: "running" }])).toBe("Working…");
  });
});
