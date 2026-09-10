import { describe, expect, it } from "vitest";
import { parseMcpListOutput, parseProviderModel, routeSlash } from "./slash";
import type { ChatCommand } from "./types";

const catalog: ChatCommand[] = [
  { name: "thinking", source: "builtin" },
  { name: "todo", source: "builtin" },
  { name: "skill:brave-search", source: "skill" },
  { name: "compact", source: "builtin" },
  { name: "model", aliases: ["models"], source: "builtin" },
  { name: "mcp", source: "builtin" },
  { name: "tools", source: "builtin" },
];

describe("routeSlash", () => {
  it("opens the providers modal on Accounts or Models and never prompts those names", () => {
    expect(routeSlash("/model", catalog)).toEqual({ kind: "open-providers", tab: "models", args: "" });
    expect(routeSlash("/models xai/grok-4.6", catalog)).toEqual({ kind: "open-providers", tab: "models", args: "xai/grok-4.6" });
    expect(routeSlash("/login", catalog)).toEqual({ kind: "open-providers", tab: "accounts", args: "" });
    expect(routeSlash("/provider", catalog)).toEqual({ kind: "open-providers", tab: "accounts", args: "" });
    expect(routeSlash("/providers", catalog)).toEqual({ kind: "open-providers", tab: "accounts", args: "" });
    expect(routeSlash("/setup", catalog)).toEqual({ kind: "open-providers", tab: "accounts", args: "" });
  });

  it("sends logout to the Terminal hatch, never as a prompt", () => {
    const logout = routeSlash("/logout", catalog);
    expect(logout?.kind).toBe("hatch");
    if (logout?.kind === "hatch") expect(logout.name).toBe("logout");
  });

  it("leaves /thinking as a catalog prompt", () => {
    expect(routeSlash("/thinking high", catalog)).toEqual({ kind: "prompt", message: "/thinking high" });
  });

  it("reads tools from get_state, not a /tools prompt", () => {
    expect(routeSlash("/tools", catalog)).toEqual({ kind: "get-tools" });
  });

  it("compacts with typed RPC unless a slash mode is present", () => {
    expect(routeSlash("/compact", catalog)).toEqual({ kind: "compact" });
    expect(routeSlash("/compact keep the API", catalog)).toEqual({ kind: "compact", customInstructions: "keep the API" });
    expect(routeSlash("/compact snapcompact", catalog)).toEqual({ kind: "compact-mode", message: "/compact snapcompact" });
  });

  it("lists MCP, prompts mutations, and hatches TUI-only verbs", () => {
    expect(routeSlash("/mcp", catalog)).toEqual({ kind: "mcp-list" });
    expect(routeSlash("/mcp list", catalog)).toEqual({ kind: "mcp-list" });
    expect(routeSlash("/mcp enable foo", catalog)).toEqual({ kind: "mcp-prompt", message: "/mcp enable foo" });
    expect(routeSlash("/mcp reauth", catalog)?.kind).toBe("hatch");
  });

  it("invokes skills as prompt", () => {
    expect(routeSlash("/skill:brave-search find X", catalog)).toEqual({
      kind: "prompt",
      message: "/skill:brave-search find X",
    });
  });

  it("sends unknown catalog names as prompt and unknown non-catalog names as a model turn", () => {
    expect(routeSlash("/todo", catalog)).toEqual({ kind: "prompt", message: "/todo" });
    expect(routeSlash("/not-a-command", catalog)).toEqual({ kind: "unknown-prompt", message: "/not-a-command" });
  });

  it("returns null for a normal message", () => {
    expect(routeSlash("hello", catalog)).toBeNull();
  });
});

describe("parseProviderModel", () => {
  it("splits provider/id", () => {
    expect(parseProviderModel("xai/grok-4.6")).toEqual({ provider: "xai", modelId: "grok-4.6" });
    expect(parseProviderModel("")).toBeNull();
    expect(parseProviderModel("grok-4.6")).toBeNull();
  });
});

describe("parseMcpListOutput", () => {
  it("parses pipe rows and the empty sentence", () => {
    expect(parseMcpListOutput("No MCP servers configured.")).toBe("empty");
    expect(parseMcpListOutput("gh | http | enabled | project\nfs | stdio | disabled | user")).toEqual([
      { name: "gh", type: "http", enabled: true, location: "project" },
      { name: "fs", type: "stdio", enabled: false, location: "user" },
    ]);
  });
});
