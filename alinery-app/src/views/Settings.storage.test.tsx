import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE } from "../appearance";
import { mockIpc } from "../test/mockIpc";
import { effectiveOf, fakeSettings, pickScope } from "../test/settingsHooks";
import type { GlobalSettings, SettingsSectionKey, StorageInfo } from "../types";
import type { McpStatusHandle } from "../useMcpStatus";

const SCOPE_EMPTY = "Select a repo to see these settings";

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
  telemetry: { enabled: true, prompted: false, install_id: "", endpoint: "https://telemetry.alinery.ai" },
  updates: { check_enabled: true },
};

function storageFor(repo: string): StorageInfo {
  return {
    app_config_path: "/app/app.toml",
    repo_path: repo,
    alinery_dir: `${repo}/.alinery`,
    repo_config_path: `${repo}/.alinery/config.toml`,
    harnesses_path: `${repo}/.alinery/harnesses.toml`,
    tasks_dir: `${repo}/.alinery/tasks`,
    worktrees_dir: `${repo}/.alinery/worktrees`,
    alineryd_socket_path: `${repo}/.alinery/alineryd.sock`,
    alineryd_lock_path: `${repo}/.alinery/.alineryd.lock`,
    mcp_socket_path: `${repo}/.alinery/mcp.sock`,
    mcp_status_path: `${repo}/.alinery/mcp-status.json`,
    archived_task_count: 3,
    archived_session_count: 7,
    archived_bytes: 2 * 1024 * 1024,
    active_bytes: 1024 * 1024,
  };
}

const mocks = vi.hoisted(() => ({
  storageInfo: vi.fn(),
  deleteAllArchivedStorage: vi.fn(),
  confirmDanger: vi.fn(),
}));

vi.mock("../ipc", () =>
  mockIpc({
    readGlobalSettings: async () => globalSettings,
    getVersion: async () => "0.0.0",
  }),
);
// The scan and the purge are jobs of the daemon (sync/storage).
vi.mock("../sync/storage", () => ({
  storageInfo: mocks.storageInfo,
  deleteAllArchivedStorage: mocks.deleteAllArchivedStorage,
  listBackups: async () => [],
  useBackupBusy: () => false,
}));

vi.mock("../sync/settings", async (actual) => (await import("../test/settingsHooks")).settingsHooks(await actual()));
vi.mock("../confirm", () => ({ confirmDanger: mocks.confirmDanger }));

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

function renderSettings(section: SettingsSectionKey) {
  return render(
    <Settings
      mcp={mcp}
      activeRepo="/repo-a"
      knownRepos={["/repo-a", "/repo-b"]}
      appearance={DEFAULT_APPEARANCE}
      onAppearanceChange={() => {}}
      onNotificationsChange={() => {}}
      initialSection={section}
    />,
  );
}

beforeEach(() => {
  fakeSettings.reset();
  for (const repo of ["/repo-a", "/repo-b"]) fakeSettings.serve(repo, (overrides) => effectiveOf(globalSettings, overrides));
  mocks.storageInfo.mockReset().mockImplementation(async (repoPath: string) => storageFor(repoPath));
  mocks.deleteAllArchivedStorage.mockReset().mockResolvedValue({
    deleted_tasks: 3,
    deleted_sessions: 7,
    deleted_worktrees: 3,
    errors: [],
  });
  mocks.confirmDanger.mockReset().mockResolvedValue(true);
});

afterEach(cleanup);

describe("Settings storage scope", () => {
  it("opens on All repositories, not the top-bar repo", async () => {
    renderSettings("data.storage");
    expect(((await screen.findByRole("combobox", { name: "Editing" })) as HTMLSelectElement).value).toBe("");
  });

  it("shows the scope empty state on Storage and does not fetch", async () => {
    renderSettings("data.storage");
    expect(await screen.findByText(SCOPE_EMPTY)).toBeTruthy();
    expect(screen.queryByText("Active data (read-only)")).toBeNull();
    expect(screen.queryByText("Delete all archived data…")).toBeNull();
    expect(mocks.storageInfo).not.toHaveBeenCalled();
  });

  it("keeps Backup enabled on All repositories and shows the same empty state", async () => {
    renderSettings("data.backup");
    const backupNav = (await screen.findByRole("button", { name: "Backup" })) as HTMLButtonElement;
    expect(backupNav.disabled).toBe(false);
    expect(backupNav.classList.contains("on")).toBe(true);
    expect(screen.getByText(SCOPE_EMPTY)).toBeTruthy();
    expect(screen.queryByText("Destination folder")).toBeNull();
  });

  it("stays on Backup when switching to All repositories", async () => {
    renderSettings("data.backup");
    await pickScope("/repo-b");
    expect(await screen.findByText("Destination folder")).toBeTruthy();
    await pickScope("");
    expect(await screen.findByText(SCOPE_EMPTY)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Backup" }).classList.contains("on")).toBe(true);
    expect(screen.getByRole("button", { name: "Appearance" }).classList.contains("on")).toBe(false);
  });

  it("loads the Settings-scope repo, not the top-bar repo", async () => {
    renderSettings("data.storage");
    await pickScope("/repo-b");
    await waitFor(() => expect(mocks.storageInfo).toHaveBeenCalledWith("/repo-b"));
    expect(await screen.findByText("Repository")).toBeTruthy();
    expect(screen.getByText("Repository").closest(".storage-path-row")?.querySelector("pre")?.textContent).toBe("/repo-b");
    expect(screen.getByText("/repo-b/.alinery")).toBeTruthy();
    expect(screen.queryByText("/repo-a")).toBeNull();
    expect(screen.queryByText("/repo-a/.alinery")).toBeNull();
    expect(screen.queryByText("Active repo")).toBeNull();
  });

  it("purges the Settings-scope repo", async () => {
    renderSettings("data.storage");
    await pickScope("/repo-b");
    fireEvent.click(await screen.findByRole("button", { name: "Delete all archived data…" }));
    await waitFor(() => expect(mocks.deleteAllArchivedStorage).toHaveBeenCalledWith("/repo-b"));
  });
});
