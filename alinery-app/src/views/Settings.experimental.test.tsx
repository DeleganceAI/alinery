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
    switchPiDurable: vi.fn(async (enabled: boolean) => ({
      ...globalSettings,
      experiments: { ...globalSettings.experiments, pi_durable: enabled },
    })),
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
  vi.mocked(ipc.switchPiDurable).mockClear();
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

  it("keeps PI durable off until opted in, and shows the Grok key only while it is on", async () => {
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

    const toggle = (await screen.findByRole("checkbox", { name: /PI durable/ })) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(screen.queryByLabelText("Grok API key")).toBeNull();
    fireEvent.click(toggle);
    const key = (await screen.findByLabelText("Grok API key")) as HTMLInputElement;
    expect(key.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(ipc.switchPiDurable).toHaveBeenCalledWith(true);
    expect(ipc.writeGlobalSettings).not.toHaveBeenCalled();
  });

  it("disables the PI durable controls when the scope is not global", async () => {
    globalSettings.experiments = { show_original_kanban: true, show_chat: false, pi_durable: true, grok_api_key: "kept" };
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
    const toggle = (await screen.findByRole("checkbox", { name: /PI durable/ })) as HTMLInputElement;
    const key = (await screen.findByLabelText("Grok API key")) as HTMLInputElement;
    expect(toggle.disabled).toBe(true);
    expect(key.disabled).toBe(true);
    globalSettings.experiments = undefined;
  });

  it("saves the Grok key without clearing other experimental flags or switching daemons", async () => {
    vi.mocked(ipc.switchPiDurable).mockResolvedValueOnce({
      ...globalSettings,
      experiments: { show_original_kanban: true, show_chat: true, pi_durable: true },
    });
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

    fireEvent.click(await screen.findByRole("checkbox", { name: /PI durable/ }));
    const key = await screen.findByLabelText("Grok API key");
    fireEvent.blur(key, { target: { value: "xai-test-key" } });
    await waitFor(() => expect(ipc.writeGlobalSettings).toHaveBeenCalled());
    const calls = vi.mocked(ipc.writeGlobalSettings).mock.calls;
    const saved = calls[calls.length - 1][0] as GlobalSettings;
    expect(saved.experiments?.grok_api_key).toBe("xai-test-key");
    expect(saved.experiments?.show_chat).not.toBe(false);
    expect(saved.experiments?.show_original_kanban).not.toBe(false);
    expect(ipc.switchPiDurable).toHaveBeenCalledTimes(1);
  });
});
