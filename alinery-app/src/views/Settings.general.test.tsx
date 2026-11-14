import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE, normalizeAppearance } from "../appearance";
import { mockIpc } from "../test/mockIpc";
import { effectiveOf, fakeSettings, pickScope } from "../test/settingsHooks";
import type { AppearancePrefs, GlobalSettings } from "../types";
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
  defaults: { harness: "vinculum", model: "", playbook: { scope: "bundled", key: "superdevelop" }, draft_autosave: false },
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

vi.mock("../ipc", () =>
  mockIpc({
    readGlobalSettings: vi.fn(async () => globalSettings),
    writeGlobalSettings: vi.fn(async (next: GlobalSettings) => next),
    writeAppearance: vi.fn(async (appearance: AppearancePrefs) => ({ active_repo: "/r", known_repos: ["/r"], mcp_enabled: true, appearance })),
    getVersion: async () => "0.0.0",
  }),
);

// The playbook library is the daemon's PlaybookService (sync/playbooks); the default-playbook picker reads an empty catalog here.
vi.mock("../sync/playbooks", async (actual) => ({
  ...(await actual<typeof import("../sync/playbooks")>()),
  listPlaybookCatalog: async () => ({ candidates: [], picker_preferences: { order: [], entries: [] }, diagnostics: [] }),
}));
vi.mock("../sync/settings", async (actual) => (await import("../test/settingsHooks")).settingsHooks(await actual()));

import * as ipc from "../ipc";
import { SECTIONS, Settings } from "./Settings";

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

const NOTE =
  "This keeps this computer from idling. It will not prevent closing the display from putting it to sleep. The screen can still turn off. It only does this while at least one session is not Idle.";

// No initialSection: Settings opens at the top of its list, on Appearance.
function renderGeneral(appearance: AppearancePrefs = DEFAULT_APPEARANCE) {
  const onAppearanceChange = vi.fn();
  render(<Settings mcp={mcp} activeRepo="/r" knownRepos={["/r"]} appearance={appearance} onAppearanceChange={onAppearanceChange} onNotificationsChange={() => {}} />);
  return onAppearanceChange;
}

const keepAwake = () => screen.findByRole("checkbox", { name: /Keep this computer awake/ }) as Promise<HTMLInputElement>;
const telemetry = () => screen.getByRole("checkbox", { name: /Share anonymous usage/ }) as HTMLInputElement;
const lastWrite = () => vi.mocked(ipc.writeGlobalSettings).mock.lastCall?.[0] as GlobalSettings;

beforeEach(() => {
  fakeSettings.reset();
  fakeSettings.serve("/r", (overrides) => effectiveOf(globalSettings, overrides));
});

afterEach(() => {
  cleanup();
  vi.mocked(ipc.writeGlobalSettings).mockClear();
  vi.mocked(ipc.writeAppearance).mockClear();
});

describe("Settings General", () => {
  it("defaults the starting view to the task list", async () => {
    renderGeneral();
    const select = (await screen.findByRole("combobox", { name: "Default starting view" })) as HTMLSelectElement;
    expect(select.value).toBe("list");
    expect(select.disabled).toBe(false);
    expect(screen.getByText("Choose the view Alinery opens on launch.")).toBeTruthy();
  });

  it("saves another starting view without changing the rest of the appearance", async () => {
    const appearance = normalizeAppearance({ ...DEFAULT_APPEARANCE, mode: "dark", terminal_font_size: 18 });
    const onAppearanceChange = renderGeneral(appearance);
    fireEvent.change(await screen.findByRole("combobox", { name: "Default starting view" }), { target: { value: "sessions" } });
    await waitFor(() => expect(ipc.writeAppearance).toHaveBeenCalledTimes(1));
    expect(ipc.writeAppearance).toHaveBeenCalledWith({ ...appearance, startup_view: "sessions" });
    expect(onAppearanceChange).toHaveBeenCalledWith({ ...appearance, startup_view: "sessions" });
    expect(screen.getByRole("button", { name: "Appearance" }).classList.contains("on")).toBe(true);
  });

  it("offers configured grid views and enabled tabs", async () => {
    vi.mocked(ipc.readGlobalSettings).mockResolvedValueOnce({
      ...globalSettings,
      experiments: { show_original_kanban: false, show_chat: true },
      grid_views: [{ id: "planning", name: "Planning", slot: 1 }],
    });
    renderGeneral({ ...DEFAULT_APPEARANCE, startup_view: "grid:planning" });
    const select = (await screen.findByRole("combobox", { name: "Default starting view" })) as HTMLSelectElement;
    expect(select.value).toBe("grid:planning");
    const options = Array.from(select.options);
    expect(options.find((option) => option.value === "grid:planning")?.textContent).toBe("Planning");
    expect(options.map((option) => option.value)).toEqual(expect.arrayContaining(["list", "sessions", "chat", "notifications", "playbooks", "settings"]));
    expect(options.map((option) => option.value)).not.toContain("kanban");
  });

  it("shows the task list when the saved starting view is unavailable", async () => {
    renderGeneral({ ...DEFAULT_APPEARANCE, startup_view: "grid:deleted" });
    const select = (await screen.findByRole("combobox", { name: "Default starting view" })) as HTMLSelectElement;
    expect(select.value).toBe("list");
    expect(Array.from(select.options, (option) => option.value)).not.toContain("chat");
    expect(ipc.writeAppearance).not.toHaveBeenCalled();
  });

  it("lists every group once, in page order", () => {
    expect(SECTIONS.map((section) => section.label)).toEqual(["Appearance", "Views", "Agents", "Connections", "Notifications", "Data", "MCP server", "System"]);
  });

  it("renders every group on one page, with General's old parts under the groups they belong to", async () => {
    renderGeneral();
    await keepAwake();
    expect(screen.getByRole("button", { name: "Appearance" }).classList.contains("on")).toBe(true);
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(SECTIONS.map((section) => section.label));
    const group = (name: string) => within(screen.getByRole("region", { name }));
    const part = (name: string) => within(screen.getByRole("heading", { level: 3, name }).closest(".settings-part") as HTMLElement);
    expect(group("Appearance").getByRole("button", { name: "Light" })).toBeTruthy();
    expect(group("Agents").getByLabelText("Default playbook")).toBeTruthy();
    expect(group("Notifications").getByRole("button", { name: "Send test notification" })).toBeTruthy();
    expect(group("Notifications").getByRole("group", { name: "Dock badge categories" })).toBeTruthy();
    expect(part("Updates").getByRole("button", { name: "Check now" })).toBeTruthy();
    expect(part("Updates").getByRole("checkbox", { name: /Check for updates/ })).toBeTruthy();
    const misc = part("Power and privacy").getAllByRole("checkbox");
    expect(misc).toEqual([await keepAwake(), telemetry()]);
    const experimental = part("Experimental").getAllByRole("checkbox");
    // The canvas needs Chat on, so it sits under it and is off until Chat is.
    expect(experimental).toHaveLength(2);
    expect(experimental[0]).toBe(part("Experimental").getByRole("checkbox", { name: /^Chat/ }));
    expect(experimental[1]).toBe(part("Experimental").getByRole("checkbox", { name: /^Thread canvas/ }));
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

  it("shows global values read-only in repository scope, each global-only group saying so once", async () => {
    renderGeneral();
    await keepAwake();
    await pickScope("/r");
    const box = await keepAwake();
    expect(box.checked).toBe(false); // repo scope mirrors the global tier it reads
    expect(box.disabled).toBe(true);
    expect(telemetry().disabled).toBe(true);
    expect((within(screen.getByRole("region", { name: "Notifications" })).getByRole("checkbox", { name: /Enabled/ }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Light" }) as HTMLButtonElement).disabled).toBe(true);
    const startingView = screen.getByRole("combobox", { name: "Default starting view" }) as HTMLSelectElement;
    expect(startingView.disabled).toBe(true);
    expect(screen.getByText(/Appearance settings are global-only\./)).toBeTruthy();
    expect(screen.getByText(/Notifications settings are global-only\./)).toBeTruthy();
    expect(screen.getByText(/Updates, power, privacy and experimental options are global-only\./)).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: /Check for updates/ }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole("checkbox", { name: /Original Kanban/ })).toBeNull();
    expect((screen.getByRole("checkbox", { name: /^Chat/ }) as HTMLInputElement).disabled).toBe(true);
    await waitFor(() => expect((screen.getByLabelText("Default playbook") as HTMLSelectElement).disabled).toBe(false));
    expect(screen.getByText(NOTE)).toBeTruthy();
    fireEvent.click(box);
    fireEvent.click(telemetry());
    fireEvent.change(startingView, { target: { value: "sessions" } });
    expect(ipc.writeGlobalSettings).not.toHaveBeenCalled();
    expect(ipc.writeAppearance).not.toHaveBeenCalled();
  });
});

describe("Settings search", () => {
  const search = () => screen.getByRole("searchbox", { name: "Search settings" }) as HTMLInputElement;
  const rail = () => within(screen.getByRole("navigation", { name: "Settings sections" }));
  const visibleGroupNames = () =>
    [...document.querySelectorAll<HTMLElement>("section.settings-group")].filter((group) => !group.hidden).map((group) => group.querySelector("h2")?.textContent);

  it("narrows the rail and the list to what matches, and Esc brings everything back", async () => {
    renderGeneral();
    await keepAwake();
    fireEvent.change(search(), { target: { value: "dark mode" } });
    expect(visibleGroupNames()).toEqual(["Appearance"]);
    expect(
      rail()
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Appearance"]);
    fireEvent.keyDown(search(), { key: "Escape" });
    expect(search().value).toBe("");
    expect(visibleGroupNames()).toEqual(SECTIONS.map((section) => section.label));
  });

  it("shows a matching part under its group and keeps the field's own state while hidden", async () => {
    renderGeneral();
    await keepAwake();
    fireEvent.change(search(), { target: { value: "telemetry" } });
    expect(visibleGroupNames()).toEqual(["System"]);
    expect(
      rail()
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["System", "Power and privacy"]);
    expect((screen.getByRole("heading", { level: 3, name: "Updates", hidden: true }).closest(".settings-part") as HTMLElement).hidden).toBe(true);
    expect(telemetry().closest("[hidden]")).toBeNull();
  });

  it("says so when nothing matches", async () => {
    renderGeneral();
    await keepAwake();
    fireEvent.change(search(), { target: { value: "zzz" } });
    expect(screen.getByText("Nothing matches “zzz”.")).toBeTruthy();
    expect(visibleGroupNames()).toEqual([]);
  });

  it("reaches the field with / from the page, but not from inside another field", async () => {
    renderGeneral();
    await keepAwake();
    fireEvent.keyDown(document.body, { key: "/" });
    expect(document.activeElement).toBe(search());
    const grok = screen.getByLabelText("Grok API key");
    grok.focus();
    fireEvent.keyDown(grok, { key: "/" });
    expect(document.activeElement).toBe(grok);
    fireEvent.keyDown(grok, { key: "f", metaKey: true });
    expect(document.activeElement).toBe(search());
  });
});
