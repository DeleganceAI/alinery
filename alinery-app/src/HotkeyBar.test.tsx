import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HotkeyBar } from "./HotkeyBar";
import type { DaemonStatus } from "./types";
import type { McpStatus } from "./useMcpStatus";

const daemon: DaemonStatus = {
  reachable: false,
  mode: "local",
  alive: 0,
  busy: 0,
  waiting_for_input: 0,
  waiting_for_approval: 0,
  idle: 0,
  unknown: 0,
  exited: 0,
  total: 0,
  extra_lanes: 0,
  stale_lanes: 0,
  repo: "",
  build_drift: false,
  conflict: null,
  repo_busy: false,
  host_guard_warning: false,
};

const mcp: McpStatus = {
  enabled: false,
  running: false,
  clients: 0,
  socket_reachable: false,
  binary_found: true,
  binary_path: "",
  repo: "",
  socket_path: "",
  error: "",
};

describe("HotkeyBar runtime status", () => {
  it("keeps the footer identity minimal and exposes power-user status", () => {
    const html = renderToStaticMarkup(<HotkeyBar view="kanban" daemon={daemon} mcp={mcp} />);
    expect(html).toContain(">Alinery</span>");
    expect(html).toContain('class="live down"');
    expect(html).toContain("Daemon");
    expect(html).toContain("MCP server");
    expect(html).toContain("Daemon build");
    expect(html).not.toContain("<details");
    expect(html).not.toContain("<summary");
    expect(html).not.toContain("Alinery Dev");
  });

  it("prints the running app version next to the identity", () => {
    const html = renderToStaticMarkup(<HotkeyBar view="kanban" daemon={daemon} mcp={mcp} version="0.11.0" />);
    expect(html).toContain('class="footer-version"');
    expect(html).toContain("v0.11.0");
  });

  it("omits the version block until the version has loaded", () => {
    const html = renderToStaticMarkup(<HotkeyBar view="kanban" daemon={daemon} mcp={mcp} />);
    expect(html).not.toContain("footer-version");
  });

  it("hides keyboard hints before a repository is selected", () => {
    const html = renderToStaticMarkup(<HotkeyBar view="kanban" daemon={daemon} mcp={mcp} showHints={false} />);
    expect(html).not.toContain('class="keys"');
    expect(html).not.toContain("Search");
  });
});

describe("HotkeyBar named Grid hints", () => {
  it("shows the active Grid view's assigned shortcut", () => {
    const html = renderToStaticMarkup(<HotkeyBar view="grid" daemon={daemon} mcp={mcp} gridViewName="Triage" gridViewShortcut="⌘4" />);
    expect(html).toContain("⌘4");
    expect(html).toContain("Triage");
    expect(html).not.toContain("⌘3</b>Grid");
  });

  it("advertises only the assigned view shortcut ranges", () => {
    const html = renderToStaticMarkup(<HotkeyBar view="settings" daemon={daemon} mcp={mcp} />);
    expect(html).toContain("⌘1–5, 7–9");
  });
});

describe("HotkeyBar duplicate task hints", () => {
  it.each(["list", "kanban", "task"])("advertises Command+D in the %s context", (view) => {
    const html = renderToStaticMarkup(<HotkeyBar view={view} daemon={daemon} mcp={mcp} />);
    expect(html).toContain("⌘D");
    expect(html).toContain("Duplicate");
  });

  it.each(["settings", "sessions", "create", "createSession", "session", "reviewHandoff"])("does not advertise duplicate in the %s context", (view) => {
    const html = renderToStaticMarkup(<HotkeyBar view={view} daemon={daemon} mcp={mcp} />);
    expect(html).not.toContain("⌘D");
    expect(html).not.toContain("Duplicate");
  });
});
