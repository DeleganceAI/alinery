import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE } from "../appearance";
import { mockIpc } from "../test/mockIpc";
import type { GlobalSettings } from "../types";
import type { McpStatusHandle } from "../useMcpStatus";

const confirmDanger = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../confirm", () => ({ confirmDanger }));

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
    dock_badge_interruptions: true,
    native_input_waits: true,
    native_approval_waits: true,
    native_failures: true,
    native_interruptions: true,
    native_final_completions: true,
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
  grid_views: [
    { id: "kanban-plus", name: "Kanban+", slot: 1 },
    { id: "planning", name: "Planning", slot: 2 },
  ],
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

function renderGridSettings() {
  return render(
    <Settings
      mcp={mcp}
      activeRepo="/r"
      knownRepos={["/r"]}
      appearance={DEFAULT_APPEARANCE}
      onAppearanceChange={() => {}}
      onNotificationsChange={() => {}}
      initialSection="gridViews"
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.mocked(ipc.writeGlobalSettings).mockClear();
  confirmDanger.mockClear();
});

describe("Settings Grid-based views", () => {
  it("shows names and fixed shortcut slots, then adds up to the maximum", async () => {
    renderGridSettings();

    expect(await screen.findByDisplayValue("Kanban+")).toBeTruthy();
    expect(screen.getByText("⌘2")).toBeTruthy();
    expect(screen.getByText("⌘4")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add Grid-based View" }));

    await waitFor(() => expect(ipc.writeGlobalSettings).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("⌘5")).toBeTruthy();
    const saved = vi.mocked(ipc.writeGlobalSettings).mock.calls[0][0] as GlobalSettings;
    expect(saved.grid_views).toHaveLength(3);
    expect(saved.grid_views?.[2]).toMatchObject({ name: "Grid view 2", slot: 3 });
    expect(await screen.findByText("Maximum of 3 views configured")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Add Grid-based View" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("trims names and rejects case-insensitive duplicates without changing stable IDs", async () => {
    renderGridSettings();
    const first = await screen.findByDisplayValue("Kanban+");
    fireEvent.change(first, { target: { value: "  Roadmap  " } });
    fireEvent.blur(first);

    await waitFor(() => expect(ipc.writeGlobalSettings).toHaveBeenCalledTimes(1));
    const saved = vi.mocked(ipc.writeGlobalSettings).mock.calls[0][0] as GlobalSettings;
    expect(saved.grid_views?.[0]).toMatchObject({ id: "kanban-plus", name: "Roadmap", slot: 1 });

    const planning = screen.getByDisplayValue("Planning");
    fireEvent.change(planning, { target: { value: "roadmap" } });
    fireEvent.blur(planning);
    expect(await screen.findByText("Names must be unique.")).toBeTruthy();
    expect(ipc.writeGlobalSettings).toHaveBeenCalledTimes(1);
  });

  it("reorders shortcut slots and confirms deletion while preserving one required view", async () => {
    renderGridSettings();
    await screen.findByDisplayValue("Planning");
    fireEvent.click(screen.getByRole("button", { name: "Move Planning up" }));

    await waitFor(() => expect(ipc.writeGlobalSettings).toHaveBeenCalledTimes(1));
    const reordered = vi.mocked(ipc.writeGlobalSettings).mock.calls[0][0] as GlobalSettings;
    expect(reordered.grid_views?.map(({ id, slot }) => [id, slot])).toEqual([
      ["planning", 1],
      ["kanban-plus", 2],
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Delete Planning" }));
    await waitFor(() => expect(confirmDanger).toHaveBeenCalled());
    await waitFor(() => expect(ipc.writeGlobalSettings).toHaveBeenCalledTimes(2));
    const afterDelete = vi.mocked(ipc.writeGlobalSettings).mock.calls[1][0] as GlobalSettings;
    expect(afterDelete.grid_views).toEqual([{ id: "kanban-plus", name: "Kanban+", slot: 1 }]);
    expect(((await screen.findByRole("button", { name: "Delete Kanban+" })) as HTMLButtonElement).disabled).toBe(true);
  });
});
