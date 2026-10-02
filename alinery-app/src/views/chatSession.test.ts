import { describe, expect, it } from "vitest";
import { emptyTranscript } from "../chatTranscript";
import { abortTurnCommand, applyChatLine, sendCommand } from "./chatSession";

describe("chatSession", () => {
  it("sends a prompt, a follow-up, or an abort-and-prompt", () => {
    expect(sendCommand("hi", false, false)).toMatchObject({ type: "prompt", message: "hi" });
    expect(sendCommand("again", false, true)).toMatchObject({ type: "follow_up", message: "again" });
    expect(sendCommand("stop", true, true)).toMatchObject({ type: "abort_and_prompt", message: "stop" });
  });

  it("aborts with the official abort command", () => {
    expect(abortTurnCommand()).toMatchObject({ type: "abort" });
  });

  it("applies a JSON RPC line and ignores junk", () => {
    const ready = applyChatLine(emptyTranscript(), JSON.stringify({ type: "ready", protocolVersion: 2 }));
    expect(ready.ready).toBe(true);
    expect(applyChatLine(ready, "not-json")).toBe(ready);
  });
});
