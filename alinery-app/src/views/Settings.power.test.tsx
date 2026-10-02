import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE } from "../appearance";
import { mockIpc } from "../test/mockIpc";
import type { GlobalSettings } from "../types";
import type { McpStatusHandle } from "../useMcpStatus";

// No `power` key: the shape of an app config written before keep-awake existed.
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
  defaults: { harness: "omp", model: "", playbook: { scope: "bundled", key: "superdevelop" }, draft_autosave: false },
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
  updates: { check_enabled: false },
};

// Repo scope reads the global tier too; on here so the disabled box visibly mirrors it.
const repoGlobal: GlobalSettings = { ...globalSettings, power: { keep_awake: true } };

vi.mock("../ipc", () =>
  mockIpc({
    readGlobalSettings: async () => globalSettings,
    writeGlobalSettings: vi.fn(async (next: GlobalSettings) => next),
    readScopedSettingsForRepo: async () => ({
      global: repoGlobal,
      overrides: { github: {}, defaults: {}, backup: {} },
      effective: {
        notifications: repoGlobal.notifications,
        github: repoGlobal.github,
        defaults: repoGlobal.defaults,
        provenance: {
          github_token: "global",
          defaults: { harness: "global", model: "global", playbook: "global", draft_autosave: "global" },
        },
        backup: repoGlobal.backup,
        telemetry: repoGlobal.telemetry,
      },
    }),
    getVersion: async () => "0.0.0",
    storageInfo: () => new Promise(() => {}),
  }),
);

import * as ipc from "../ipc";
import { SECTIONS, Settings } from "./Settings";

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

const NOTE =
  "This keeps this computer from idling. It will not prevent closing the display from putting it to sleep. The screen can still turn off. It only does this while at least one session is not Idle.";

function renderPower() {
  render(
    <Settings
      mcp={mcp}
      activeRepo="/r"
      knownRepos={["/r"]}
      appearance={DEFAULT_APPEARANCE}
      onAppearanceChange={() => {}}
      onNotificationsChange={() => {}}
      initialSection="power"
    />,
  );
}

const keepAwake = () => screen.findByRole("checkbox", { name: /Keep this computer awake/ }) as Promise<HTMLInputElement>;

afterEach(() => {
  cleanup();
  vi.mocked(ipc.writeGlobalSettings).mockClear();
});

describe("Settings power", () => {
  it("is a global section after Notifications", () => {
    const labels = SECTIONS.map((section) => section.label);
    expect(labels).toContain("Power");
    expect(labels.indexOf("Power")).toBe(labels.indexOf("Notifications") + 1);
  });

  it("is off and editable in global scope, with the note under it", async () => {
    renderPower();
    const box = await keepAwake();
    expect(box.checked).toBe(false);
    expect(box.disabled).toBe(false);
    expect(screen.getByText(NOTE)).toBeTruthy();
    expect(screen.getByText(/not Idle/)).toBeTruthy();
    expect(screen.getByText(/closing the display/)).toBeTruthy();
    expect(screen.queryByText(/Power are global-only\./)).toBeNull();
  });

  it("writes power.keep_awake and leaves the rest of the loaded global unchanged", async () => {
    renderPower();
    fireEvent.click(await keepAwake());
    await waitFor(() => expect(ipc.writeGlobalSettings).toHaveBeenCalledTimes(1));
    const saved = vi.mocked(ipc.writeGlobalSettings).mock.calls[0][0] as GlobalSettings;
    expect(saved.power?.keep_awake).toBe(true);
    expect(saved).toEqual({ ...globalSettings, power: { keep_awake: true } });
  });

  it("shows the global value read-only in repository scope", async () => {
    renderPower();
    await keepAwake();
    fireEvent.click(screen.getByRole("button", { name: "r" }));
    await waitFor(async () => expect((await keepAwake()).checked).toBe(true));
    const box = await keepAwake();
    expect(box.disabled).toBe(true);
    expect(screen.getByText(/Power are global-only\./)).toBeTruthy();
    expect(screen.getByText(NOTE)).toBeTruthy();
    fireEvent.click(box);
    expect(ipc.writeGlobalSettings).not.toHaveBeenCalled();
  });
});
