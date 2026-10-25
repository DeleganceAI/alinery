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
  it("shows Original Kanban for older settings and persists an opt-out", async () => {
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
        initialSection="general"
      />,
    );

    const checkbox = await screen.findByRole("checkbox", { name: /Original Kanban/ });
    expect((checkbox as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("button", { name: "Grid views" })).toBeTruthy();
    fireEvent.click(checkbox);

    await waitFor(() => expect(ipc.writeGlobalSettings).toHaveBeenCalled());
    const saved = vi.mocked(ipc.writeGlobalSettings).mock.calls[0][0] as GlobalSettings;
    expect(saved.experiments?.show_original_kanban).toBe(false);
    await waitFor(() => expect(onGlobalSettingsChange).toHaveBeenCalledWith(saved));
  });

  it("keeps the Chat tab off until opted in, and leaves the Kanban flag alone", async () => {
    render(
      <Settings
        mcp={mcp}
        activeRepo="/r"
        knownRepos={["/r"]}
        appearance={DEFAULT_APPEARANCE}
        onAppearanceChange={() => {}}
        onGlobalSettingsChange={() => {}}
        onNotificationsChange={() => {}}
        initialSection="general"
      />,
    );

    const checkbox = (await screen.findByRole("checkbox", { name: /^Chat/ })) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    fireEvent.click(checkbox);

    await waitFor(() => expect(ipc.writeGlobalSettings).toHaveBeenCalled());
    const saved = vi.mocked(ipc.writeGlobalSettings).mock.calls[0][0] as GlobalSettings;
    expect(saved.experiments?.show_chat).toBe(true);
    expect(saved.experiments?.show_original_kanban).not.toBe(false);
  });

  it("shows the Chat settings section only while the Chat flag is on", async () => {
    render(
      <Settings
        mcp={mcp}
        activeRepo="/r"
        knownRepos={["/r"]}
        appearance={DEFAULT_APPEARANCE}
        onAppearanceChange={() => {}}
        onGlobalSettingsChange={() => {}}
        onNotificationsChange={() => {}}
        initialSection="chat"
      />,
    );

    // Off by default: no Chat section, and a request to open it lands on General.
    const checkbox = (await screen.findByRole("checkbox", { name: /^Chat/ })) as HTMLInputElement;
    expect(screen.queryByRole("button", { name: "Chat" })).toBeNull();
    expect(screen.getByRole("button", { name: "Sessions view" })).toBeTruthy();
    fireEvent.click(checkbox);
    expect(await screen.findByRole("button", { name: "Chat" })).toBeTruthy();
  });

  it("shows the Grok key without a daemon toggle", async () => {
    render(
      <Settings
        mcp={mcp}
        activeRepo="/r"
        knownRepos={["/r"]}
        appearance={DEFAULT_APPEARANCE}
        onAppearanceChange={() => {}}
        onGlobalSettingsChange={() => {}}
        onNotificationsChange={() => {}}
        initialSection="general"
      />,
    );

    expect(screen.queryByRole("checkbox", { name: /PI durable/ })).toBeNull();
    expect(await screen.findByLabelText("Grok API key")).toBeTruthy();
  });

  it("disables the Grok key when the scope is not global", async () => {
    globalSettings.experiments = { show_original_kanban: true, show_chat: false, grok_api_key: "kept" };
    render(
      <Settings
        mcp={mcp}
        activeRepo="/r"
        knownRepos={["/r"]}
        appearance={DEFAULT_APPEARANCE}
        onAppearanceChange={() => {}}
        onGlobalSettingsChange={() => {}}
        onNotificationsChange={() => {}}
        initialSection="general"
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "r" }));
    const key = (await screen.findByLabelText("Grok API key")) as HTMLInputElement;
    expect(key.disabled).toBe(true);
    globalSettings.experiments = undefined;
  });

  it("saves the Grok key without clearing other experimental flags", async () => {
    globalSettings.experiments = { show_original_kanban: true, show_chat: true, grok_api_key: "" };
    render(
      <Settings
        mcp={mcp}
        activeRepo="/r"
        knownRepos={["/r"]}
        appearance={DEFAULT_APPEARANCE}
        onAppearanceChange={() => {}}
        onGlobalSettingsChange={() => {}}
        onNotificationsChange={() => {}}
        initialSection="general"
      />,
    );

    const key = await screen.findByLabelText("Grok API key");
    fireEvent.blur(key, { target: { value: "xai-test-key" } });
    await waitFor(() => expect(ipc.writeGlobalSettings).toHaveBeenCalled());
    const calls = vi.mocked(ipc.writeGlobalSettings).mock.calls;
    const saved = calls[calls.length - 1][0] as GlobalSettings;
    expect(saved.experiments?.grok_api_key).toBe("xai-test-key");
    expect(saved.experiments?.show_chat).not.toBe(false);
    expect(saved.experiments?.show_original_kanban).not.toBe(false);
    globalSettings.experiments = undefined;
  });
});
