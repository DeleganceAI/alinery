import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE } from "../appearance";
import { mockIpc } from "../test/mockIpc";
import type { GlobalSettings, UpdateStatus } from "../types";
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

vi.mock("../ipc", () =>
  mockIpc({
    readGlobalSettings: async () => globalSettings,
    writeGlobalSettings: vi.fn(async (next: GlobalSettings) => next),
    getVersion: async () => "0.10.0",
    storageInfo: () => new Promise(() => {}),
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

const available: UpdateStatus = {
  current: "0.10.0",
  available: {
    version: "0.11.0",
    url: "https://cdn.alinery.ai/v0.11.0/Alinery-aarch64-apple-darwin.app.zip",
    sha256: "a".repeat(64),
    size: 1,
    protocol_version: 2,
    published_at: "",
  },
  checked_at: 1,
};

afterEach(() => {
  cleanup();
  vi.mocked(ipc.writeGlobalSettings).mockClear();
});

describe("Settings updates wiring", () => {
  it("Check now calls the shared checkNow, not a private ipc.checkUpdate", async () => {
    const onCheckNow = vi.fn(async () => available);
    render(
      <Settings
        mcp={mcp}
        activeRepo="/r"
        knownRepos={["/r"]}
        appearance={DEFAULT_APPEARANCE}
        onAppearanceChange={() => {}}
        onNotificationsChange={() => {}}
        initialSection="updates"
        update={available}
        onCheckNow={onCheckNow}
        onUpgrade={() => {}}
        onClearUpdateOffer={() => {}}
      />,
    );

    const button = await screen.findByRole("button", { name: "Check now" });
    fireEvent.click(button);
    await waitFor(() => expect(onCheckNow).toHaveBeenCalled());
    expect(ipc.checkUpdate).not.toHaveBeenCalled();
  });

  it("shows an Upgrade button that uses the shared onUpgrade", async () => {
    const onUpgrade = vi.fn();
    render(
      <Settings
        mcp={mcp}
        activeRepo="/r"
        knownRepos={["/r"]}
        appearance={DEFAULT_APPEARANCE}
        onAppearanceChange={() => {}}
        onNotificationsChange={() => {}}
        initialSection="updates"
        update={available}
        onCheckNow={async () => available}
        onUpgrade={onUpgrade}
        onClearUpdateOffer={() => {}}
      />,
    );

    const button = await screen.findByRole("button", { name: "Upgrade to 0.11.0" });
    fireEvent.click(button);
    expect(onUpgrade).toHaveBeenCalledTimes(1);
  });

  it("opting out immediately clears the shared offer", async () => {
    const onClearUpdateOffer = vi.fn();
    render(
      <Settings
        mcp={mcp}
        activeRepo="/r"
        knownRepos={["/r"]}
        appearance={DEFAULT_APPEARANCE}
        onAppearanceChange={() => {}}
        onNotificationsChange={() => {}}
        initialSection="updates"
        update={available}
        onCheckNow={async () => available}
        onUpgrade={() => {}}
        onClearUpdateOffer={onClearUpdateOffer}
      />,
    );

    const checkbox = await screen.findByRole("checkbox", { name: /Check for updates/ });
    fireEvent.click(checkbox);
    expect(onClearUpdateOffer).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(ipc.writeGlobalSettings).toHaveBeenCalled());
    const saved = vi.mocked(ipc.writeGlobalSettings).mock.calls[0][0] as GlobalSettings;
    expect(saved.updates.check_enabled).toBe(false);
  });
});
