import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
          defaults: { harness: "global", model: "global", thinking: "global", playbook: "global", draft_autosave: "global" },
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

// No initialSection: General is also the tab Settings opens on.
function renderGeneral() {
  render(<Settings mcp={mcp} activeRepo="/r" knownRepos={["/r"]} appearance={DEFAULT_APPEARANCE} onAppearanceChange={() => {}} onNotificationsChange={() => {}} />);
}

const keepAwake = () => screen.findByRole("checkbox", { name: /Keep this computer awake/ }) as Promise<HTMLInputElement>;
const telemetry = () => screen.getByRole("checkbox", { name: /Share anonymous usage/ }) as HTMLInputElement;
const lastWrite = () => vi.mocked(ipc.writeGlobalSettings).mock.lastCall?.[0] as GlobalSettings;

afterEach(() => {
  cleanup();
  vi.mocked(ipc.writeGlobalSettings).mockClear();
});

describe("Settings General", () => {
  it("is the first tab and absorbs the pages folded into it", () => {
    const labels = SECTIONS.map((section) => section.label);
    expect(labels[0]).toBe("General");
    for (const gone of ["Appearance", "Notifications", "Telemetry", "Power", "Playbooks", "Updates", "Experimental"]) expect(labels).not.toContain(gone);
  });

  it("opens on General with Playbooks above Notifications, Updates above Misc, and experimental options inside Misc", async () => {
    renderGeneral();
    await keepAwake();
    expect(screen.getByRole("button", { name: "General" }).classList.contains("on")).toBe(true);
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(["Appearance", "Playbooks", "Notifications", "Updates", "Misc"]);
    const subsection = (name: string) => within(screen.getByRole("heading", { name }).closest(".settings-subsection") as HTMLElement);
    expect(subsection("Appearance").getByRole("button", { name: "Light" })).toBeTruthy();
    expect(subsection("Playbooks").getByLabelText("Default playbook")).toBeTruthy();
    expect(subsection("Notifications").getByRole("button", { name: "Send test notification" })).toBeTruthy();
    expect(subsection("Notifications").getByRole("group", { name: "Dock badge categories" })).toBeTruthy();
    expect(subsection("Updates").getByRole("button", { name: "Check now" })).toBeTruthy();
    expect(subsection("Updates").getByRole("checkbox", { name: /Check for updates/ })).toBeTruthy();
    const misc = subsection("Misc");
    expect(misc.getByRole("heading", { level: 3, name: "Experimental options" })).toBeTruthy();
    const boxes = misc.getAllByRole("checkbox");
    expect(boxes).toHaveLength(4);
    expect(boxes[0]).toBe(await keepAwake());
    expect(boxes[1]).toBe(telemetry());
    expect(boxes[2]).toBe(misc.getByRole("checkbox", { name: /Original Kanban/ }));
    expect(boxes[3]).toBe(misc.getByRole("checkbox", { name: /^Chat/ }));
  });

  it("shows Keep awake off and editable, with the note under it", async () => {
    renderGeneral();
    const box = await keepAwake();
    expect(box.checked).toBe(false);
    expect(box.disabled).toBe(false);
    expect(screen.getByText(NOTE)).toBeTruthy();
    expect(screen.getByText(/not Idle/)).toBeTruthy();
    expect(screen.getByText(/closing the display/)).toBeTruthy();
    expect(screen.queryByText(/are global-only\./)).toBeNull();
  });

  it("writes power.keep_awake and leaves the rest of the loaded global unchanged", async () => {
    renderGeneral();
    fireEvent.click(await keepAwake());
    await waitFor(() => expect(ipc.writeGlobalSettings).toHaveBeenCalledTimes(1));
    expect(lastWrite().power?.keep_awake).toBe(true);
    expect(lastWrite()).toEqual({ ...globalSettings, power: { keep_awake: true } });
  });

  it("writes telemetry from Misc", async () => {
    renderGeneral();
    await keepAwake();
    expect(telemetry().checked).toBe(true);
    fireEvent.click(telemetry());
    await waitFor(() => expect(ipc.writeGlobalSettings).toHaveBeenCalledTimes(1));
    expect(lastWrite()).toEqual({ ...globalSettings, telemetry: { ...globalSettings.telemetry, enabled: false } });
  });

  it("shows global values read-only in repository scope under one banner", async () => {
    renderGeneral();
    await keepAwake();
    fireEvent.click(screen.getByRole("button", { name: "r" }));
    await waitFor(async () => expect((await keepAwake()).checked).toBe(true));
    const box = await keepAwake();
    expect(box.disabled).toBe(true);
    expect(telemetry().disabled).toBe(true);
    expect((screen.getByRole("checkbox", { name: /Enabled/ }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Light" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText(/are global-only\./)).toHaveLength(1);
    expect(screen.getByText(/Appearance, notifications, updates, and misc are global-only\./)).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: /Check for updates/ }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("checkbox", { name: /Original Kanban/ }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("checkbox", { name: /^Chat/ }) as HTMLInputElement).disabled).toBe(true);
    await waitFor(() => expect((screen.getByLabelText("Default playbook") as HTMLSelectElement).disabled).toBe(false));
    expect(screen.getByText(NOTE)).toBeTruthy();
    fireEvent.click(box);
    fireEvent.click(telemetry());
    expect(ipc.writeGlobalSettings).not.toHaveBeenCalled();
  });
});
