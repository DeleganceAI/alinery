import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE } from "../appearance";
import type * as IpcFixtures from "../test/mockIpc";
import type { GlobalSettings, PickerPreferences, PlaybookCatalog, PlaybookRef } from "../types";
import type { McpStatusHandle } from "../useMcpStatus";
import { Settings } from "./Settings";

const mocks = vi.hoisted(() => ({
  readGlobalSettings: vi.fn(),
  writeGlobalSettings: vi.fn(),
  listPlaybookCatalog: vi.fn(),
  readPlaybookPickerPreferences: vi.fn(),
  savePlaybookPickerPreferences: vi.fn(),
}));
vi.mock("../ipc", async () => {
  // This hoisted factory is invoked while the Settings dependency graph is loading.
  const { mockIpc } = await vi.importActual<typeof IpcFixtures>("../test/mockIpc");
  return mockIpc(mocks);
});

const base: GlobalSettings = {
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
  defaults: { harness: "omp", model: "", playbook: { scope: "bundled", key: "shared" }, draft_autosave: true },
  backup: { destination: "", enabled: false, retention: 5, trigger_pre_archive: false, trigger_post_artifact_change: false, trigger_post_push_commit: false },
  harnesses: { harness: [] },
  telemetry: { enabled: false, prompted: true, install_id: "", endpoint: "" },
  updates: { check_enabled: false },
  model_favorites: {},
  experiments: { show_original_kanban: false },
};
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
let saved: GlobalSettings;
let preferences: PickerPreferences;
let catalog: PlaybookCatalog;

beforeEach(() => {
  vi.clearAllMocks();
  saved = structuredClone(base);
  preferences = { order: [], entries: [] };
  catalog = {
    candidates: (["bundled", "global", "repo"] as PlaybookRef["scope"][]).map((scope) => ({
      source: { reference: { scope, key: "shared" }, path: scope === "bundled" ? null : `/${scope}/shared/playbook.md` },
      title: "Shared",
      description: "",
      modified_at_ms: scope === "bundled" ? null : 1700000000000,
      diagnostics: [],
    })),
    diagnostics: [],
    picker_preferences: preferences,
  };
  mocks.readGlobalSettings.mockImplementation(async () => structuredClone(saved));
  mocks.writeGlobalSettings.mockImplementation(async (next: GlobalSettings) => {
    saved = structuredClone(next);
    return saved;
  });
  mocks.listPlaybookCatalog.mockImplementation(async () => structuredClone(catalog));
  mocks.readPlaybookPickerPreferences.mockImplementation(async () => structuredClone(preferences));
  mocks.savePlaybookPickerPreferences.mockImplementation(async (next: PickerPreferences) => {
    preferences = structuredClone(next);
  });
});
afterEach(cleanup);

function openSettings() {
  return render(
    <Settings
      mcp={mcp}
      activeRepo="/r"
      knownRepos={["/r"]}
      appearance={DEFAULT_APPEARANCE}
      onAppearanceChange={() => {}}
      onNotificationsChange={() => {}}
      initialSection="playbooks"
    />,
  );
}

describe("Scoped playbook settings", () => {
  it("keeps three same-key scopes distinct and preserves an unavailable configured default until explicitly replaced", async () => {
    saved.defaults.playbook = { scope: "global", key: "missing" };
    const first = openSettings();
    const select = (await screen.findByLabelText("Default playbook")) as HTMLSelectElement;
    await screen.findByRole("option", { name: "Shared — global/shared" });
    expect(select.value).toBe("global/missing");
    expect(screen.getByText(/configured default is unavailable/)).toBeTruthy();
    expect(Array.from(select.options).map((option) => option.value)).toEqual(["global/missing", "bundled/shared", "global/shared", "repo/shared"]);
    expect(mocks.writeGlobalSettings).not.toHaveBeenCalled();
    fireEvent.change(select, { target: { value: "global/shared" } });
    await waitFor(() => expect(select.value).toBe("global/shared"));
    first.unmount();
    openSettings();
    await screen.findByRole("option", { name: "Shared — global/shared" });
    expect((screen.getByLabelText("Default playbook") as HTMLSelectElement).value).toBe("global/shared");
    expect(saved.defaults.playbook).toEqual({ scope: "global", key: "shared" });
    expect(mocks.savePlaybookPickerPreferences).not.toHaveBeenCalled();
  });

  it("shows invalid choices without replacing the invalid default", async () => {
    saved.defaults.playbook = { scope: "repo", key: "shared" };
    catalog.candidates[2].diagnostics = [{ code: "invalid_selector", message: "Output selector overlaps another producer", severity: "error", line: 14, field: "step.outputs" }];
    openSettings();
    const invalid = (await screen.findByRole("option", { name: "Shared — repo/shared — invalid" })) as HTMLOptionElement;
    expect(invalid.disabled).toBe(true);
    expect((screen.getByLabelText("Default playbook") as HTMLSelectElement).value).toBe("repo/shared");
    expect(screen.getByText("Output selector overlaps another producer")).toBeTruthy();
    expect(mocks.writeGlobalSettings).not.toHaveBeenCalled();
  });

  it("keeps default choices independent of preferred membership, ordering and legacy visibility", async () => {
    preferences.order = [
      { scope: "repo", key: "shared" },
      { scope: "global", key: "shared" },
    ];
    preferences.entries = [
      {
        reference: { scope: "repo", key: "shared" },
        preferred: true,
        hidden: true,
        collapsed: false,
        badge: "Personal",
        color: "#123456",
        last_imported_at_ms: null,
      },
    ];
    const originalPreferences = structuredClone(preferences);
    openSettings();
    const select = (await screen.findByLabelText("Default playbook")) as HTMLSelectElement;
    await screen.findByRole("option", { name: "Shared — repo/shared" });
    expect(select.value).toBe("bundled/shared");
    expect(screen.queryByRole("list", { name: "Personal playbook picker" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /Hide .* in picker/ })).toBeNull();
    fireEvent.change(select, { target: { value: "repo/shared" } });
    await waitFor(() => expect(saved.defaults.playbook).toEqual({ scope: "repo", key: "shared" }));
    expect(preferences).toEqual(originalPreferences);
    expect(mocks.readPlaybookPickerPreferences).not.toHaveBeenCalled();
    expect(mocks.savePlaybookPickerPreferences).not.toHaveBeenCalled();
  });
});
