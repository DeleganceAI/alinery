import { describe, expect, it } from "vitest";
import { emptyTranscript } from "../chatTranscript";
import { applySendPlan, planChatSend } from "./send";
import type { ChatCommand } from "./types";

const catalog: ChatCommand[] = [
  { name: "thinking", source: "builtin" },
  { name: "todo", source: "builtin" },
  { name: "model", aliases: ["models"], source: "builtin" },
  { name: "mcp", source: "builtin" },
  { name: "tools", source: "builtin" },
  { name: "compact", source: "builtin" },
  { name: "deploy", source: "custom" },
  { name: "summarize", source: "mcp_prompt" },
];

describe("planChatSend", () => {
  it("opens /model and never treats it as a prompt row", () => {
    const plan = planChatSend("/model xai/grok-4.6", catalog, false);
    expect(plan.dispatch).toEqual({ kind: "open-providers", tab: "models", args: "xai/grok-4.6" });
    expect(plan.optimisticKind).toBe("slash");
    expect(plan.slash).toEqual({ name: "model", args: "xai/grok-4.6" });
  });

  it("opens /login on Accounts and never prompts", () => {
    const plan = planChatSend("/login", catalog, false);
    expect(plan.dispatch).toEqual({ kind: "open-providers", tab: "accounts", args: "" });
    expect(plan.optimisticKind).toBe("slash");
  });

  it("hatches /logout instead of prompting", () => {
    const plan = planChatSend("/logout", catalog, false);
    expect(plan.dispatch.kind).toBe("hatch");
    expect(plan.notice).toMatch(/Terminal/);
    expect(plan.optimisticKind).toBe("slash");
  });

  it("sends catalog names as slash when idle and follow_up when busy", () => {
    expect(planChatSend("/thinking high", catalog, false).optimisticKind).toBe("slash");
    expect(planChatSend("/thinking high", catalog, true).optimisticKind).toBe("follow_up");
    expect(planChatSend("/thinking high", catalog, true).slash).toBeUndefined();
  });

  it("marks unknown /name as a model turn plus a catalog notice", () => {
    const plan = planChatSend("/not-a-command", catalog, false);
    expect(plan.dispatch.kind).toBe("unknown-prompt");
    expect(plan.optimisticKind).toBe("prompt");
    expect(plan.notice).toContain("not-a-command");
  });

  it("sends a plain body as prompt or follow_up", () => {
    expect(planChatSend("hello", catalog, false)).toEqual({
      dispatch: { kind: "plain", message: "hello" },
      invokesModel: true,
      optimisticKind: "prompt",
    });
    expect(planChatSend("hello", catalog, true).optimisticKind).toBe("follow_up");
  });

  it("guesses a turn on a model send so the next submit steers, without faking Vinculum's own state", () => {
    const sent = applySendPlan(emptyTranscript(), "hello", planChatSend("hello", catalog, false)).state;
    expect(sent.pendingTurn).toBe(true);
    // The guess must stay a guess: `turn_start` still has a marker to emit and a turn to count.
    expect(sent.turnOpen).toBe(false);
    expect(sent.turn).toBe(0);
  });

  it("claims a turn for the catalog entries that reach the agent and no others", () => {
    const claims = (raw: string) => applySendPlan(emptyTranscript(), raw, planChatSend(raw, catalog, false)).state.pendingTurn;
    // Builtins are answered locally (`agentInvoked: false`) — claiming one would steer into nothing.
    expect(claims("/thinking high")).toBe(false);
    expect(claims("/logout")).toBe(false);
    // These do invoke the agent, and were the gap: routeSlash returns `prompt` for all of them.
    expect(claims("/skill:review")).toBe(true);
    expect(claims("/deploy")).toBe(true);
    expect(claims("/summarize")).toBe(true);
  });

  it("appends a hatch notice onto the journal", () => {
    const plan = planChatSend("/logout", catalog, false);
    const next = applySendPlan(emptyTranscript(), "/logout", plan).state;
    expect(next.entries.map((e) => e.type)).toEqual(["slash", "harness"]);
  });
});
