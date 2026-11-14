import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE } from "../appearance";
import { mockIpc } from "../test/mockIpc";
import { effectiveOf, fakeSettings, pickScope } from "../test/settingsHooks";
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
  experiments: { show_original_kanban: true },
};

vi.mock("../ipc", () =>
  mockIpc({
    readGlobalSettings: async () => globalSettings,
    writeGlobalSettings: vi.fn(async (next: GlobalSettings) => next),
  }),
);

vi.mock("../sync/settings", async (actual) => (await import("../test/settingsHooks")).settingsHooks(await actual()));

import * as ipc from "../ipc";
import { Settings } from "./Settings";

const mcp: McpStatusHandle = {
  enabled: false,
  running: false,
  clients: 0,
  socket_reachable: false,
  binary_found: false,
  binary_path: "",
  host_args: [],
  repo: "",
  socket_path: "",
  error: "",
  refresh: () => {},
};

beforeEach(() => {
  fakeSettings.reset();
  fakeSettings.serve("/r", (overrides) => effectiveOf(globalSettings, overrides));
});

afterEach(() => {
  cleanup();
  vi.mocked(ipc.writeGlobalSettings).mockClear();
});

describe("Settings experimental features", () => {
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
        initialSection="appearance"
      />,
    );

    const checkbox = (await screen.findByRole("checkbox", { name: /^Chat/ })) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    expect(screen.queryByRole("checkbox", { name: /Original Kanban/ })).toBeNull();
    fireEvent.click(checkbox);

    await waitFor(() => expect(ipc.writeGlobalSettings).toHaveBeenCalled());
    const saved = vi.mocked(ipc.writeGlobalSettings).mock.calls[0][0] as GlobalSettings;
    expect(saved.experiments?.show_chat).toBe(true);
    expect(saved.experiments?.show_original_kanban).toBe(true);
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
        initialSection="views.chat"
      />,
    );

    // Off by default: no Chat view part, and a request to open it lands on its Views group.
    const checkbox = (await screen.findByRole("checkbox", { name: /^Chat/ })) as HTMLInputElement;
    expect(screen.queryByRole("button", { name: "Chat view" })).toBeNull();
    expect(screen.getByRole("button", { name: "Session chat" })).toBeTruthy();
    fireEvent.click(checkbox);
    expect(await screen.findByRole("button", { name: "Chat view" })).toBeTruthy();
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
        initialSection="appearance"
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
        initialSection="appearance"
      />,
    );

    await pickScope("/r");
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
        initialSection="appearance"
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
