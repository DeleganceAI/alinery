import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  telemetry: { enabled: true, prompted: false, install_id: "", endpoint: "https://telemetry.alinery.ai" },
  updates: { check_enabled: true },
  model_favorites: {},
  experiments: { show_original_kanban: false },
};

vi.mock("../ipc", () =>
  mockIpc({
    readGlobalSettings: async () => globalSettings,
    writeGlobalSettings: vi.fn(async (next: GlobalSettings) => next),
  }),
);

import * as ipc from "../ipc";
import { Settings } from "./Settings";

const mcp: McpStatusHandle = {
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

afterEach(() => {
  cleanup();
  vi.mocked(ipc.writeGlobalSettings).mockClear();
});

describe("Settings experimental features", () => {
  it("keeps Original Kanban off by default and persists an opt-in", async () => {
    const onGlobalSettingsChange = vi.fn();
    render(
      <Settings
        mcp={mcp}
        activeRepo="/r"
        knownRepos={["/r"]}
        appearance={DEFAULT_APPEARANCE}
        onAppearanceChange={() => {}}
        onGlobalSettingsChange={onGlobalSettingsChange}
        onNotificationsChange={() => {}}
        initialSection="experimental"
      />,
    );

    const checkbox = await screen.findByRole("checkbox", { name: /Original Kanban/ });
    expect((checkbox as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole("button", { name: "Grid views" })).toBeTruthy();
    fireEvent.click(checkbox);

    await waitFor(() => expect(ipc.writeGlobalSettings).toHaveBeenCalled());
    const saved = vi.mocked(ipc.writeGlobalSettings).mock.calls[0][0] as GlobalSettings;
    expect(saved.experiments?.show_original_kanban).toBe(true);
    await waitFor(() => expect(onGlobalSettingsChange).toHaveBeenCalledWith(saved));
  });
});
