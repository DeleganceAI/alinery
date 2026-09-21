import { describe, expect, it } from "vitest";
import type { HostToolCall } from "../types";
import { AGENT_MIN_WIDTH, atBottom, canSend, gateKind, parseHostToolCall, resizeAgentPane, statusLabel, summarizeHostTool } from "./orbitron-agent";

describe("statusLabel", () => {
  it("uses the product words", () => {
    expect(statusLabel("idle")).toBe("Idle");
    // No ellipsis: the label is the static half of an orb pair, not the animation itself.
    expect(statusLabel("thinking")).toBe("Thinking");
    expect(statusLabel("updatingBoard")).toBe("Updating board");
    expect(statusLabel("compacting")).toBe("Compacting");
  });
});

describe("resizeAgentPane", () => {
  it("widens freely and clamps at 60% of the viewport", () => {
    expect(resizeAgentPane(520, 1600).width).toBe(520);
    expect(resizeAgentPane(1400, 1600).width).toBe(960);
  });
  it("never renders narrower than the width it shipped at", () => {
    expect(resizeAgentPane(120, 1600).width).toBe(AGENT_MIN_WIDTH);
  });
  it("a small overshoot clamps instead of closing", () => {
    expect(resizeAgentPane(AGENT_MIN_WIDTH - 40, 1600).close).toBe(false);
  });
  it("dragging well past the minimum is a close", () => {
    expect(resizeAgentPane(200, 1600).close).toBe(true);
  });
  it("a window too narrow for 60% still gets the minimum, not half a pane", () => {
    expect(resizeAgentPane(400, 500).width).toBe(AGENT_MIN_WIDTH);
  });
});

describe("atBottom", () => {
  it("is true at the bottom and within the slack above it", () => {
    expect(atBottom({ scrollTop: 400, clientHeight: 200, scrollHeight: 600 })).toBe(true);
    expect(atBottom({ scrollTop: 390, clientHeight: 200, scrollHeight: 600 })).toBe(true);
  });
  it("is false once the reader has scrolled back through the transcript", () => {
    expect(atBottom({ scrollTop: 0, clientHeight: 200, scrollHeight: 600 })).toBe(false);
  });
});

describe("canSend", () => {
  it("compacting is false", () => {
    expect(canSend({ status: "compacting", gate: null })).toBe(false);
  });
  it("thinking is true", () => {
    expect(canSend({ status: "thinking", gate: null })).toBe(true);
  });
  it("idle is true", () => {
    expect(canSend({ status: "idle", gate: null })).toBe(true);
  });
  it("updatingBoard is true", () => {
    expect(canSend({ status: "updatingBoard", gate: null })).toBe(true);
  });
  it("is false while a gate is showing", () => {
    expect(canSend({ status: "idle", gate: "omp" })).toBe(false);
    expect(canSend({ status: "idle", gate: "key" })).toBe(false);
  });
});

describe("gateKind", () => {
  it("prefers omp over key over ready", () => {
    expect(gateKind({ ompFound: false, keyPresent: false })).toBe("omp");
    expect(gateKind({ ompFound: true, keyPresent: false })).toBe("key");
    expect(gateKind({ ompFound: true, keyPresent: true })).toBe(null);
  });
});

describe("summarizeHostTool", () => {
  it("names the write", () => {
    expect(summarizeHostTool({ toolName: "concept_create", arguments: { name: "Auth" } })).toBe('Create concept "Auth"');
    expect(summarizeHostTool({ toolName: "relation_upsert", arguments: { a: "a", b: "b", kind: "blocks" } })).toBe("Relate a → b (blocks)");
    expect(summarizeHostTool({ toolName: "board_arrange", arguments: {} })).toBe("Arrange board");
  });
});

describe("parseHostToolCall", () => {
  it("unknown host tool name is a product error", () => {
    expect(parseHostToolCall("rm_rf", {})).toBeNull();
  });
  it("keeps a known write", () => {
    const call: HostToolCall = { toolName: "board_get", arguments: {} };
    expect(parseHostToolCall("board_get", {})).toEqual(call);
  });
});
