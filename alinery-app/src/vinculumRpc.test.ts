import { describe, expect, it } from "vitest";
import { abortAndPromptCommand, compactCommand, followUpCommand, getStateCommand, promptCommand, TRANSPORT_LIMIT_HINT, transportLimitMessage } from "./vinculumRpc";

describe("vinculumRpc", () => {
  it("sends official { type, message } commands, never JSON-RPC method/params", () => {
    expect(promptCommand("hi", "c1")).toEqual({ id: "c1", type: "prompt", message: "hi" });
    expect(getStateCommand("c6")).toEqual({ id: "c6", type: "get_state" });
    expect(compactCommand("keep the API", "c9")).toEqual({ id: "c9", type: "compact", customInstructions: "keep the API" });
    expect(compactCommand(undefined, "c10")).toEqual({ id: "c10", type: "compact" });
    expect(abortAndPromptCommand("now", "c21")).toEqual({ id: "c21", type: "abort_and_prompt", message: "now" });
    expect(JSON.stringify(promptCommand("hi", "c1"))).not.toContain("method");
    expect(JSON.stringify(promptCommand("hi", "c1"))).not.toContain("params");
  });

  it("maps a transport-limit failure to the history hint", () => {
    expect(transportLimitMessage("RPC response exceeded the transport limit")).toBe(TRANSPORT_LIMIT_HINT);
    expect(transportLimitMessage("other")).toBe("other");
  });

  it("puts images on prompt/follow_up/abort_and_prompt and omits an empty list", () => {
    const images = [{ type: "image" as const, data: "aa", mimeType: "image/png" }];
    expect(promptCommand("hi", "c1", images)).toEqual({ id: "c1", type: "prompt", message: "hi", images });
    expect(followUpCommand("hi", "c2", images)).toEqual({ id: "c2", type: "follow_up", message: "hi", images });
    expect(abortAndPromptCommand("hi", "c3", images)).toEqual({ id: "c3", type: "abort_and_prompt", message: "hi", images });
    expect(promptCommand("hi", "c1", [])).toEqual({ id: "c1", type: "prompt", message: "hi" });
  });
});
