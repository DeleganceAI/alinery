import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE } from "../appearance";
import { mockIpc } from "../test/mockIpc";
import type { GlobalSettings } from "../types";
import type { McpStatusHandle } from "../useMcpStatus";

const globalSettings: GlobalSettings = {
  notifications: {
    enabled: false,
    sound: false,
    bounce: false,
    banner: false,
    dock_badge: true,
    dock_badge_input_waits: true,
    dock_badge_approval_waits: true,
    dock_badge_failures: true,
    dock_badge_completions: true,
  },

  github: { token: "" },
  defaults: { harness: "claude", model: "", playbook: { scope: "bundled", key: "superdevelop" }, draft_autosave: false },
  backup: {
    destination: "",
    enabled: false,
    retention: 5,
    trigger_pre_archive: false,
    trigger_post_artifact_change: false,
    trigger_post_push_commit: false,
  },
  harnesses: { harness: [] },
  model_favorites: {},
  telemetry: { enabled: true, prompted: false, install_id: "", endpoint: "https://telemetry.alinery.ai" },
  updates: { check_enabled: true },
};

vi.mock("../ipc", () => mockIpc({ readGlobalSettings: async () => globalSettings }));

import { Settings } from "./Settings";

const NOT_READY: McpStatusHandle = {
  enabled: false,
  running: false,
  clients: 0,
  socket_reachable: false,
  binary_found: false,
  binary_path: "",
  repo: "",
  socket_path: "",
  error: "",
  refresh: () => {},
};

const READY: McpStatusHandle = {
  ...NOT_READY,
  binary_found: true,
  binary_path: "/Applications/Alinery.app/Contents/MacOS/alinery-mcp",
  repo: "/Users/dev/code/my-repo",
  socket_path: "/Users/dev/code/my-repo/.alinery/mcp.sock",
};

// What useMcpStatus falls back to when the status call fails: it claims binary_found
// with no path to show for it.
const OFFLINE_FALLBACK: McpStatusHandle = { ...NOT_READY, enabled: true, binary_found: true, binary_path: "" };

const renderMcp = (mcp: McpStatusHandle, knownRepos: string[] = ["/r"]) =>
  render(
    <Settings
      mcp={mcp}
      activeRepo={mcp.repo || "/r"}
      knownRepos={knownRepos}
      appearance={DEFAULT_APPEARANCE}
      onAppearanceChange={() => {}}
      onNotificationsChange={() => {}}
      initialSection="mcp"
    />,
  );

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("MCP settings", () => {
  // The config block is copy-paste bait: whatever it renders is what a user drops into
  // their host. Until the binary is known it must show a placeholder and refuse to copy,
  // or the host silently gets a config pointing at nothing. Repo is no longer part of
  // this readiness — it's a per-call tool argument now, not a launch flag.
  it("shows a placeholder binary path and blocks Copy config until the binary is known", async () => {
    renderMcp(NOT_READY);

    const config = await screen.findByText(/mcpServers/);
    expect(config.textContent).toContain("/path/to/alinery-mcp");
    expect((screen.getByRole("button", { name: "Copy config" }) as HTMLButtonElement).disabled).toBe(true);
  });

  // The offline fallback claims binary_found with no path. Calling that "Binary ready"
  // tells the user the prerequisite is satisfied when there is no binary to point at.
  it("does not claim the binary is ready when the fallback reports no path", async () => {
    renderMcp(OFFLINE_FALLBACK);

    await screen.findByText(/mcpServers/);
    expect(screen.queryByText("Binary ready")).toBe(null);
    expect(screen.getAllByText("alinery-mcp binary not found next to the app — rebuild.").length).toBeGreaterThan(0);
  });

  // Advanced is closed by default, so a hint that only lives inside it does not reach
  // the one user who cannot start the server.
  it("says why the toggle is disabled without needing Advanced opened", async () => {
    renderMcp(NOT_READY);

    await screen.findByText(/mcpServers/);
    // Both sentences also exist on the Advanced rows, so "is in the DOM" proves nothing.
    // What matters is that one instance sits outside the collapsed disclosure.
    const outsideAdvanced = (text: string) => screen.getAllByText(text).filter((el) => !el.closest("details"));
    expect(outsideAdvanced("Select a repo first.")).toHaveLength(1);
    expect(outsideAdvanced("alinery-mcp binary not found next to the app — rebuild.")).toHaveLength(1);
    expect(document.querySelector("details")?.open).toBe(false);
  });

  it("drops the prerequisite hints once everything is ready", async () => {
    renderMcp(READY);

    await screen.findByText(/mcpServers/);
    expect(screen.queryByText("Select a repo first.")).toBe(null);
  });

  // The status label already names the first unmet prerequisite; a chip repeating it
  // printed the same two words side by side.
  it("does not repeat the status label as a chip", async () => {
    renderMcp(NOT_READY);

    await screen.findByText(/mcpServers/);
    expect(screen.getAllByText("No repo")).toHaveLength(1);
    expect(document.querySelectorAll(".mcp-chip")).toHaveLength(0);
  });

  it("shows a chip per satisfied prerequisite once ready", async () => {
    renderMcp(READY);

    await screen.findByText(/mcpServers/);
    expect(document.querySelectorAll(".mcp-chip")).toHaveLength(2);
    expect(screen.getByText("Binary ready")).toBeTruthy();
  });

  // The section configures the active repo whatever the scope bar says. Selecting a
  // different repo must not let its config be pasted as if it were that repo's.
  it("warns when the selected scope is not the repo being configured", async () => {
    const other = "/Users/dev/code/other-repo";
    renderMcp(READY, [READY.repo, other]);

    await screen.findByText(/mcpServers/);
    expect(screen.queryByText(/always configures the active repository/)).toBe(null);

    fireEvent.click(screen.getByRole("button", { name: "other-repo" }));

    const warning = await screen.findByText(/always configures the active repository/);
    expect(warning.textContent).toContain("other-repo");
    // The real target, in full, so it cannot be mistaken for the selected one.
    expect(document.querySelector(".inline-status-detail")?.textContent).toBe(READY.repo);
  });

  it("shows the real binary path and allows Copy config once the binary is known", async () => {
    renderMcp(READY);

    const config = await screen.findByText(/mcpServers/);
    expect(config.textContent).toContain(READY.binary_path);
    expect(config.textContent).not.toContain("/path/to/");
    expect(config.textContent).not.toContain(READY.repo);
    expect((screen.getByRole("button", { name: "Copy config" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps the managed-server toggle disabled while prerequisites are missing", async () => {
    renderMcp(NOT_READY);

    const toggle = (await screen.findByRole("checkbox", { name: /App-managed server/ })) as HTMLInputElement;
    expect(toggle.disabled).toBe(true);
  });

  it("keeps Advanced collapsed so the managed socket is not the install path", async () => {
    renderMcp(READY);

    const advanced = (await screen.findByText("Advanced")).closest("details");
    expect(advanced).toBeTruthy();
    expect(advanced?.open).toBe(false);
    expect(advanced?.textContent).toContain("Managed socket");
    expect(advanced?.textContent).toContain(READY.socket_path);
  });
});
