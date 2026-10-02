import { describe, expect, it } from "vitest";
import { appendOptimisticUser, emptyTranscript } from "../chatTranscript";
import { abortTurnCommand, applyChatValue, parseChatLine, queueRefreshCommand, sendCommand, sendNowCommand } from "./chatSession";

describe("chatSession", () => {
  it("prompts when idle, queues a follow-up when busy, and aborts-and-prompts on send now", () => {
    expect(sendCommand("hi", false)).toMatchObject({ type: "prompt", message: "hi" });
    expect(sendCommand("again", true)).toMatchObject({ type: "follow_up", message: "again" });
    expect(sendNowCommand("stop")).toMatchObject({ type: "abort_and_prompt", message: "stop" });
  });

  it("aborts with the official abort command", () => {
    expect(abortTurnCommand()).toMatchObject({ type: "abort" });
  });

  it("applies a JSON RPC line and ignores junk", () => {
    const ready = applyChatValue(emptyTranscript(), parseChatLine(JSON.stringify({ type: "ready", protocolVersion: 2 })));
    expect(ready.ready).toBe(true);
    expect(applyChatValue(ready, parseChatLine("not-json"))).toBe(ready);
  });

  it("drops follow-up rows OMP has delivered once get_state reports the queue", () => {
    let state = emptyTranscript();
    for (const text of ["a", "b", "c"]) state = appendOptimisticUser(state, text, "follow_up");
    const trimmed = applyChatValue(state, { type: "response", command: "get_state", success: true, data: { queuedMessageCount: 1 } });
    expect(trimmed.entries.filter((entry) => entry.type === "follow_up").map((entry) => (entry.type === "follow_up" ? entry.text : ""))).toEqual(["c"]);
  });

  it("re-reads the queue only after a follow-up lands or a turn ends", () => {
    expect(queueRefreshCommand({ type: "response", command: "follow_up", success: true })).toMatchObject({ type: "get_state" });
    expect(queueRefreshCommand({ type: "turn_end" })).toMatchObject({ type: "get_state" });
    expect(queueRefreshCommand({ type: "response", command: "prompt", success: true })).toBeNull();
    expect(queueRefreshCommand({ type: "message_update" })).toBeNull();
    expect(queueRefreshCommand(undefined)).toBeNull();
  });
});
