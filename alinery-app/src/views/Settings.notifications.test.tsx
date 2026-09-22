import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE } from "../appearance";
import { mockIpc } from "../test/mockIpc";
import { Toast } from "../toast";
import type { GlobalSettings, NotificationPrefs } from "../types";
import type { McpStatusHandle } from "../useMcpStatus";

const notifications: NotificationPrefs = {
  enabled: true,
  sound: true,
  bounce: false,
  banner: true,
  dock_badge: true,
  dock_badge_input_waits: true,
  dock_badge_approval_waits: true,
  dock_badge_failures: true,
  dock_badge_completions: true,
};

const globalSettings: GlobalSettings = {
  notifications,

  github: { token: "" },
  defaults: { harness: "claude", model: "", playbook: { scope: "bundled", key: "superdevelop" }, draft_autosave: true },
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
  telemetry: { enabled: true, prompted: true, install_id: "", endpoint: "https://telemetry.alinery.ai" },
  updates: { check_enabled: true },
};

const mocks = vi.hoisted(() => ({ writeGlobalSettings: vi.fn() }));
vi.mock("../ipc", () =>
  mockIpc({
    readGlobalSettings: async () => globalSettings,
    storageInfo: () => new Promise<never>(() => {}),
    writeGlobalSettings: mocks.writeGlobalSettings,
  }),
);

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

const labels = ["Dock badge", "Input waits", "Approval waits", "Failures", "Unread playbook completions"];

function renderNotifications(onNotificationsChange = vi.fn()) {
  render(
    <>
      <Settings
        mcp={mcp}
        activeRepo="/repo"
        knownRepos={["/repo"]}
        appearance={DEFAULT_APPEARANCE}
        onAppearanceChange={() => {}}
        onNotificationsChange={onNotificationsChange}
        initialSection="notifications"
      />
      <Toast />
    </>,
  );
  return onNotificationsChange;
}

beforeEach(() => mocks.writeGlobalSettings.mockReset().mockImplementation(async (next: GlobalSettings) => next));
afterEach(cleanup);

describe("notification badge settings", () => {
  it("renders all five global switches enabled by default", async () => {
    renderNotifications();
    for (const label of labels) expect(((await screen.findByRole("checkbox", { name: new RegExp(label) })) as HTMLInputElement).checked).toBe(true);
  });

  it("nests category switches under the Dock badge control", async () => {
    renderNotifications();
    const group = await screen.findByRole("group", { name: "Dock badge categories" });
    expect(group.classList.contains("dock-badge-options")).toBe(true);
    expect(group.querySelectorAll('input[type="checkbox"]')).toHaveLength(4);
    expect(group.textContent).toContain("Input waits");
    expect(group.textContent).toContain("Approval waits");
    expect(group.textContent).toContain("Failures");
    expect(group.textContent).toContain("Unread playbook completions");
  });

  it("persists each exact preference key independently", async () => {
    renderNotifications();
    const cases = [
      ["Dock badge", "dock_badge"],
      ["Input waits", "dock_badge_input_waits"],
      ["Approval waits", "dock_badge_approval_waits"],
      ["Failures", "dock_badge_failures"],
      ["Unread playbook completions", "dock_badge_completions"],
    ] as const;
    for (const [label, key] of cases) {
      const checkbox = await screen.findByRole("checkbox", { name: new RegExp(label) });
      fireEvent.click(checkbox);
      await waitFor(() => expect(mocks.writeGlobalSettings).toHaveBeenCalled());
      const saved = mocks.writeGlobalSettings.mock.calls[mocks.writeGlobalSettings.mock.calls.length - 1][0] as GlobalSettings;
      expect(saved.notifications[key]).toBe(false);
      expect(saved.notifications.banner).toBe(true);
      expect(saved.notifications.sound).toBe(true);
      expect(saved.notifications.bounce).toBe(false);
      fireEvent.click(checkbox);
      await waitFor(() => expect(mocks.writeGlobalSettings.mock.calls.length).toBeGreaterThan(1));
    }
  });

  it("disables badge settings in repository scope", async () => {
    renderNotifications();
    fireEvent.click(await screen.findByRole("button", { name: "repo" }));
    for (const label of labels) expect((screen.getByRole("checkbox", { name: new RegExp(label) }) as HTMLInputElement).disabled).toBe(true);
  });

  it("notifies App only after a successful write", async () => {
    let resolve!: (value: GlobalSettings) => void;
    mocks.writeGlobalSettings.mockReturnValueOnce(
      new Promise<GlobalSettings>((accept) => {
        resolve = accept;
      }),
    );
    const onNotificationsChange = renderNotifications();
    fireEvent.click(await screen.findByRole("checkbox", { name: /Dock badge/ }));
    expect(onNotificationsChange).not.toHaveBeenCalled();
    const saved = { ...globalSettings, notifications: { ...notifications, dock_badge: false } };
    resolve(saved);
    await waitFor(() => expect(onNotificationsChange).toHaveBeenCalledWith(saved.notifications));

    mocks.writeGlobalSettings.mockRejectedValueOnce(new Error("write failed"));
    fireEvent.click(screen.getByRole("checkbox", { name: /Input waits/ }));
    await waitFor(() => expect(screen.getByText(/Couldn't save settings/)).toBeDefined());
    expect(onNotificationsChange).toHaveBeenCalledTimes(1);
  });
});
