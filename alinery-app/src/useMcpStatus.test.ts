import { describe, expect, it, vi } from "vitest";
import { type McpStatus, mcpDotColor, mcpFooterLabel, mcpIsUp, mcpStatusKind, mcpStatusLabel } from "./useMcpStatus";

vi.mock("./ipc");

const status = (over: Partial<McpStatus> = {}): McpStatus => ({
  enabled: true,
  running: true,
  clients: 0,
  socket_reachable: true,
  binary_found: true,
  binary_path: "/bin/alinery-mcp",
  repo: "/r",
  socket_path: "/r/.alinery/mcp.sock",
  error: "",
  ...over,
});

describe("mcpIsUp", () => {
  it("needs both enabled and running", () => {
    expect(mcpIsUp(status())).toBe(true);
    expect(mcpIsUp(status({ enabled: false }))).toBe(false);
    expect(mcpIsUp(status({ running: false }))).toBe(false);
  });
});

// The order of these branches is the contract: each condition assumes the ones above it
// were already false. Reordering "no repo" below "not enabled", say, would report OFF for
// a machine that simply has no repo selected yet.
describe("mcpStatusLabel precedence", () => {
  it("reports no repo before anything else", () => {
    expect(mcpStatusLabel(status({ repo: "", binary_found: false, enabled: false, running: false }))).toBe("No repo");
  });

  it("reports a missing binary before the enabled flag", () => {
    expect(mcpStatusLabel(status({ binary_found: false, enabled: false }))).toBe("Binary missing");
  });

  it("reports off before down", () => {
    expect(mcpStatusLabel(status({ enabled: false, running: false }))).toBe("Off");
  });

  it("reports down when enabled but not running", () => {
    expect(mcpStatusLabel(status({ running: false }))).toBe("Down");
  });

  it("distinguishes idle from connected clients, and singular from plural", () => {
    expect(mcpStatusLabel(status({ clients: 0 }))).toBe("Idle");
    expect(mcpStatusLabel(status({ clients: 1 }))).toBe("1 client");
    expect(mcpStatusLabel(status({ clients: 4 }))).toBe("4 clients");
  });
});

describe("mcpDotColor", () => {
  it("greys out when there is nothing to report", () => {
    expect(mcpDotColor(status({ enabled: false }))).toBe("var(--text-faint)");
    expect(mcpDotColor(status({ repo: "" }))).toBe("var(--text-faint)");
  });

  it("goes red for a missing binary or a stopped server", () => {
    expect(mcpDotColor(status({ binary_found: false }))).toBe("var(--danger)");
    expect(mcpDotColor(status({ running: false }))).toBe("var(--danger)");
  });

  it("goes green only when actually up", () => {
    expect(mcpDotColor(status())).toBe("var(--success)");
  });
});

describe("mcpStatusKind", () => {
  it("mirrors the dot severity so icons can reinforce the label", () => {
    expect(mcpStatusKind(status())).toBe("ok");
    expect(mcpStatusKind(status({ enabled: false }))).toBe("muted");
    expect(mcpStatusKind(status({ binary_found: false }))).toBe("error");
    expect(mcpStatusKind(status({ running: false }))).toBe("error");
  });
});

describe("mcpFooterLabel", () => {
  // The footer is always visible, so "no repo selected" must render as nothing at all
  // rather than as a permanent "MCP NO REPO" badge.
  it("renders nothing when there is no repo", () => {
    expect(mcpFooterLabel(status({ repo: "" }))).toBe("");
  });

  it("prefixes every other state", () => {
    expect(mcpFooterLabel(status({ clients: 2 }))).toBe("MCP 2 clients");
    expect(mcpFooterLabel(status({ running: false }))).toBe("MCP down");
  });
});
