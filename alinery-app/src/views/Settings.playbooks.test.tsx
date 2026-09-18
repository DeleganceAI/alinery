import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE } from "../appearance";
import * as ipc from "../ipc";
import type * as IpcFixtures from "../test/mockIpc";
import type { GlobalSettings, PickerPreferences, PlaybookCatalog, PlaybookRef } from "../types";
import type { McpStatusHandle } from "../useMcpStatus";
import { Settings } from "./Settings";

const mocks = vi.hoisted(() => ({
  readGlobalSettings: vi.fn(), writeGlobalSettings: vi.fn(), listPlaybookCatalog: vi.fn(),
  readPlaybookPickerPreferences: vi.fn(), savePlaybookPickerPreferences: vi.fn(),
}));
vi.mock("../ipc", async () => {
  // This hoisted factory is invoked while the Settings dependency graph is loading.
  const { mockIpc } = await vi.importActual<typeof IpcFixtures>("../test/mockIpc");
  return mockIpc(mocks);
});

const base: GlobalSettings = {
  notifications: { enabled: false, sound: false, bounce: false, banner: false, dock_badge: true, dock_badge_input_waits: true, dock_badge_approval_waits: true, dock_badge_failures: true, dock_badge_completions: true },
  github: { token: "" },
  defaults: { harness: "omp", model: "", playbook: { scope: "bundled", key: "shared" }, draft_autosave: true },
  backup: { destination: "", enabled: false, retention: 5, trigger_pre_archive: false, trigger_post_artifact_change: false, trigger_post_push_commit: false },
  harnesses: { harness: [] },
  telemetry: { enabled: false, prompted: true, install_id: "", endpoint: "" },
  updates: { check_enabled: false }, model_favorites: {}, experiments: { show_original_kanban: false },
};
const mcp: McpStatusHandle = {
  enabled: false, running: false, clients: 0, socket_reachable: false, binary_found: false,
  binary_path: "", repo: "", socket_path: "", error: "", refresh: () => {},
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
      title: "Shared", description: "", modified_at_ms: scope === "bundled" ? null : 1700000000000,
      diagnostics: [],
    })),
    diagnostics: [], picker_preferences: preferences,
  };
  mocks.readGlobalSettings.mockImplementation(async () => structuredClone(saved));
  mocks.writeGlobalSettings.mockImplementation(async (next: GlobalSettings) => { saved = structuredClone(next); return saved; });
  mocks.listPlaybookCatalog.mockImplementation(async () => structuredClone(catalog));
  mocks.readPlaybookPickerPreferences.mockImplementation(async () => structuredClone(preferences));
  mocks.savePlaybookPickerPreferences.mockImplementation(async (next: PickerPreferences) => { preferences = structuredClone(next); });
});
afterEach(cleanup);

function openSettings() {
  return render(<Settings mcp={mcp} activeRepo="/r" knownRepos={["/r"]} appearance={DEFAULT_APPEARANCE} onAppearanceChange={() => {}} onNotificationsChange={() => {}} initialSection="playbooks" />);
}
function pickerOrder() {
  return within(screen.getByRole("list", { name: "Personal playbook picker" })).getAllByRole("listitem").map((item) => item.getAttribute("aria-label"));
}

describe("Scoped playbook settings", () => {
  it("keeps three same-key scopes distinct and preserves an unavailable configured default until explicitly replaced", async () => {
    saved.defaults.playbook = { scope: "global", key: "missing" };
    const first = openSettings();
    const select = await screen.findByLabelText("Default playbook") as HTMLSelectElement;
    await screen.findByRole("option", { name: "Shared — global/shared" });
    expect(select.value).toBe("global/missing");
    expect(screen.getByText(/configured default is unavailable/)).toBeTruthy();
    expect(pickerOrder()).toEqual(["bundled/shared", "global/shared", "repo/shared"]);
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

  it("shows invalid choices and actual timestamp availability without replacing the invalid default", async () => {
    saved.defaults.playbook = { scope: "repo", key: "shared" };
    catalog.candidates[2].diagnostics = [{ code: "invalid_selector", message: "Output selector overlaps another producer", severity: "error", line: 14, field: "step.outputs" }];
    openSettings();
    const invalid = await screen.findByRole("option", { name: "Shared — repo/shared — invalid" }) as HTMLOptionElement;
    expect(invalid.disabled).toBe(true);
    expect((screen.getByLabelText("Default playbook") as HTMLSelectElement).value).toBe("repo/shared");
    expect(screen.getByText("Output selector overlaps another producer")).toBeTruthy();
    expect(screen.getByText(/Bundled definition · Modification time unavailable/)).toBeTruthy();
    expect(screen.getByText(`/global/shared/playbook.md · Modified ${new Date(1700000000000).toLocaleString()}`)).toBeTruthy();
    expect(mocks.writeGlobalSettings).not.toHaveBeenCalled();
  });

  it("personal picker preferences persist without rewriting definitions", async () => {
    const originalCatalog = structuredClone(catalog);
    const first = openSettings();
    const move = await screen.findByRole("button", { name: "Move repo/shared up" });
    fireEvent.click(move);
    await waitFor(() => expect(pickerOrder()).toEqual(["bundled/shared", "repo/shared", "global/shared"]));
    fireEvent.click(screen.getByRole("checkbox", { name: "Hide global/shared in picker" }));
    await waitFor(() => expect((screen.getByRole("checkbox", { name: "Hide global/shared in picker" }) as HTMLInputElement).checked).toBe(true));
    const badge = screen.getByLabelText("Badge for global/shared");
    fireEvent.change(badge, { target: { value: "Personal" } });
    fireEvent.blur(badge);
    await waitFor(() => expect(preferences.entries.find((entry) => entry.reference.scope === "global")?.badge).toBe("Personal"));
    const color = screen.getByLabelText("Color for repo/shared");
    fireEvent.change(color, { target: { value: "#123456" } });
    fireEvent.blur(color);
    await waitFor(() => expect(preferences.entries.find((entry) => entry.reference.scope === "repo")?.color).toBe("#123456"));
    first.unmount();
    openSettings();
    await screen.findByRole("button", { name: "Move repo/shared up" });
    expect(pickerOrder()).toEqual(["bundled/shared", "repo/shared", "global/shared"]);
    expect((screen.getByRole("checkbox", { name: "Hide global/shared in picker" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Hide bundled/shared in picker" }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText("Badge for global/shared") as HTMLInputElement).value).toBe("Personal");
    expect((screen.getByLabelText("Color for repo/shared") as HTMLInputElement).value).toBe("#123456");
    expect(catalog).toEqual(originalCatalog);
    expect(ipc.savePlaybookSource).not.toHaveBeenCalled();
    expect(mocks.writeGlobalSettings).not.toHaveBeenCalled();
  });
});
