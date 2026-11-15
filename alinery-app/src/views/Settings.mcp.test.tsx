import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE } from "../appearance";
import { mockIpc } from "../test/mockIpc";
import { effectiveOf, fakeSettings } from "../test/settingsHooks";
import type { GlobalSettings } from "../types";
import type { McpStatus } from "../useMcpStatus";

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

vi.mock("../sync/settings", async (actual) => (await import("../test/settingsHooks")).settingsHooks(await actual()));

import { Settings } from "./Settings";

beforeEach(() => {
  fakeSettings.reset();
  for (const repo of ["/r", "/Users/dev/code/my-repo", "/Users/dev/code/other-repo"]) fakeSettings.serve(repo, (overrides) => effectiveOf(globalSettings, overrides));
});

const NOT_READY: McpStatus = { binary_path: "", host_args: [] };

const READY: McpStatus = {
  binary_path: "/Applications/Alinery.app/Contents/MacOS/alinery-vinculum-daemon",
  host_args: ["--mcp", "--bridge", "--app-config", "/Users/dev/app.toml"],
};

const renderMcp = (mcp: McpStatus) =>
  render(
    <Settings mcp={mcp} activeRepo="/r" knownRepos={["/r"]} appearance={DEFAULT_APPEARANCE} onAppearanceChange={() => {}} onNotificationsChange={() => {}} initialSection="mcp" />,
  );

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const MISSING = "alinery-vinculum-daemon binary not found next to the app — rebuild.";

describe("MCP settings", () => {
  // The config block is copy-paste bait: whatever it renders is what a user drops into their host. Until the binary is known it must
  // show a placeholder and refuse to copy, or the host silently gets a config pointing at nothing.
  it("shows a placeholder binary path and blocks Copy config until the binary is known, saying why outside Advanced", async () => {
    renderMcp(NOT_READY);
    const config = await screen.findByText(/mcpServers/);
    expect(config.textContent).toContain("/path/to/alinery-vinculum-daemon");
    expect((screen.getByRole("button", { name: "Copy config" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("Binary ready")).toBe(null);
    expect(screen.getAllByText(MISSING).filter((el) => !el.closest("details"))).toHaveLength(1);
    expect(document.querySelector("details")?.open).toBe(false);
  });

  it("shows the bridge config with the real binary once it is known, and points to the Runtime panel for the rest", async () => {
    renderMcp(READY);
    const config = await screen.findByText(/mcpServers/);
    expect(config.textContent).toContain(READY.binary_path);
    expect(config.textContent).toContain("--bridge");
    expect(config.textContent).not.toContain("/path/to/");
    expect((screen.getByRole("button", { name: "Copy config" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText("Binary ready")).toBeTruthy();
    expect(screen.queryByText(MISSING)).toBe(null);
    expect(screen.getByText(/Updates → Runtime/)).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: /App-managed server/ })).toBe(null);
  });
});
