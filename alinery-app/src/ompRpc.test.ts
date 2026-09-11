import { describe, expect, it } from "vitest";
import {
  abortAndPromptCommand,
  compactCommand,
  extensionUiConfirm,
  extensionUiValue,
  getAvailableModelsCommand,
  getLoginProvidersCommand,
  getStateCommand,
  getSubagentsCommand,
  loginCommand,
  negotiateProtocolCommand,
  promptCommand,
  setAutoCompactionCommand,
  setModelCommand,
  setSubagentSubscriptionCommand,
  TRANSPORT_LIMIT_HINT,
  transportLimitMessage,
} from "./ompRpc";

describe("ompRpc", () => {
  it("sends official { type, message } commands, never JSON-RPC method/params", () => {
    expect(promptCommand("hi", "c1")).toEqual({ id: "c1", type: "prompt", message: "hi" });
    expect(getStateCommand("c6")).toEqual({ id: "c6", type: "get_state" });
    expect(getAvailableModelsCommand("c7")).toEqual({ id: "c7", type: "get_available_models" });
    expect(setModelCommand("xai", "grok-4.6", "c8")).toEqual({ id: "c8", type: "set_model", provider: "xai", modelId: "grok-4.6" });
    expect(compactCommand("keep the API", "c9")).toEqual({ id: "c9", type: "compact", customInstructions: "keep the API" });
    expect(compactCommand(undefined, "c10")).toEqual({ id: "c10", type: "compact" });
    expect(setAutoCompactionCommand(false, "c14")).toEqual({ id: "c14", type: "set_auto_compaction", enabled: false });
    expect(setSubagentSubscriptionCommand("events", "c11")).toEqual({
      id: "c11",
      type: "set_subagent_subscription",
      level: "events",
    });
    expect(getLoginProvidersCommand("c12")).toEqual({ id: "c12", type: "get_login_providers" });
    expect(loginCommand("anthropic", "c13")).toEqual({ id: "c13", type: "login", providerId: "anthropic" });
    expect(extensionUiValue("ui-1", "https://localhost")).toEqual({
      type: "extension_ui_response",
      id: "ui-1",
      value: "https://localhost",
    });
    expect(extensionUiConfirm("ui-2", true)).toEqual({ type: "extension_ui_response", id: "ui-2", confirmed: true });
    expect(JSON.stringify(promptCommand("hi", "c1"))).not.toContain("method");
    expect(JSON.stringify(promptCommand("hi", "c1"))).not.toContain("params");
  });

  it("negotiates protocol v2", () => {
    expect(negotiateProtocolCommand(2, "p1")).toEqual({ id: "p1", type: "negotiate_protocol", protocolVersion: 2 });
    expect(transportLimitMessage("RPC response exceeded the transport limit")).toBe(TRANSPORT_LIMIT_HINT);
    expect(transportLimitMessage("other")).toBe("other");
  });

  it("getSubagentsCommand is official { id, type } stdin", () => {
    expect(getSubagentsCommand("c20")).toEqual({ id: "c20", type: "get_subagents" });
    expect(JSON.stringify(getSubagentsCommand("c20"))).not.toContain("method");
    expect(JSON.stringify(getSubagentsCommand("c20"))).not.toContain("params");
  });

  it("abortAndPromptCommand is official { id, type, message } stdin", () => {
    expect(abortAndPromptCommand("now", "c21")).toEqual({ id: "c21", type: "abort_and_prompt", message: "now" });
    expect(JSON.stringify(abortAndPromptCommand("now", "c21"))).not.toContain("method");
    expect(JSON.stringify(abortAndPromptCommand("now", "c21"))).not.toContain("params");
  });
});
