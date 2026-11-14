import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE } from "../appearance";
import { mockIpc } from "../test/mockIpc";
import { fakeSettings } from "../test/settingsHooks";
import type { GlobalSettings } from "../types";
import type { McpStatusHandle } from "../useMcpStatus";

const REMOTE = "alinery+ssh://devbox/srv/app";

const globalSettings = {
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
  backup: { destination: "", enabled: false, retention: 5, trigger_pre_archive: false, trigger_post_artifact_change: false, trigger_post_push_commit: false },
  harnesses: { harness: [] },
  model_favorites: {},
  telemetry: { enabled: true, prompted: false, install_id: "", endpoint: "https://telemetry.alinery.ai" },
  updates: { check_enabled: true },
} as unknown as GlobalSettings;

const scoped = (destination: string) => ({
  global: globalSettings,
  overrides: { github: {}, defaults: {}, backup: destination ? { destination } : {} },
  effective: {
    notifications: globalSettings.notifications,
    github: globalSettings.github,
    defaults: globalSettings.defaults,
    provenance: {
      github_token: "global" as const,
      defaults: { harness: "global" as const, model: "global" as const, thinking: "global" as const, playbook: "global" as const, draft_autosave: "global" as const },
    },
    backup: { ...globalSettings.backup, destination },
    telemetry: globalSettings.telemetry,
  },
});

const mocks = vi.hoisted(() => ({
  checkBackupDestination: vi.fn(),
  pickBackupDestinationDialog: vi.fn(),
  listBackups: vi.fn(),
  backupNow: vi.fn(),
  verifyBackup: vi.fn(),
  restoreBackup: vi.fn(),
  confirmDanger: vi.fn(),
  busy: { value: false },
}));

vi.mock("../ipc", () =>
  mockIpc({
    readGlobalSettings: async () => globalSettings,
    getVersion: async () => "0.0.0",
    pickBackupDestinationDialog: mocks.pickBackupDestinationDialog,
    restoreBackup: mocks.restoreBackup,
  }),
);
vi.mock("../confirm", () => ({ confirmDanger: mocks.confirmDanger }));
// Backups are the daemon's (sync/storage); the checks and the list are served here.
vi.mock("../sync/storage", () => ({
  listBackups: mocks.listBackups,
  backupNow: mocks.backupNow,
  verifyBackup: mocks.verifyBackup,
  useBackupBusy: () => mocks.busy.value,
  checkBackupDestination: mocks.checkBackupDestination,
}));

vi.mock("../sync/settings", async (actual) => (await import("../test/settingsHooks")).settingsHooks(await actual()));

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

function renderBackup() {
  return render(
    <Settings
      mcp={mcp}
      activeRepo="/repo-a"
      knownRepos={["/repo-a", REMOTE]}
      appearance={DEFAULT_APPEARANCE}
      onAppearanceChange={() => {}}
      onNotificationsChange={() => {}}
      initialSection="backup"
    />,
  );
}

beforeEach(() => {
  mocks.checkBackupDestination.mockReset().mockImplementation(async (_repo: string, destination: string) => destination);
  mocks.pickBackupDestinationDialog.mockReset();
  mocks.listBackups.mockReset().mockResolvedValue([]);
  mocks.backupNow.mockReset();
  mocks.verifyBackup.mockReset().mockResolvedValue({});
  mocks.restoreBackup.mockReset().mockResolvedValue(undefined);
  mocks.confirmDanger.mockReset().mockResolvedValue(true);
  mocks.busy.value = false;
  fakeSettings.reset();
  for (const repo of ["/repo-a", REMOTE]) fakeSettings.serve(repo, (overrides) => scoped(overrides.backup.destination ?? "").effective);
});

afterEach(cleanup);

describe("Settings backup destination", () => {
  it("uses the Finder picker for a local repository", async () => {
    renderBackup();
    fireEvent.click(await screen.findByRole("button", { name: "repo-a" }));
    expect(await screen.findByRole("button", { name: "Choose folder…" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Set folder" })).toBeNull();
  });

  it("takes a typed folder for a remote repository and has the host check it", async () => {
    renderBackup();
    fireEvent.click(await screen.findByRole("button", { name: "app" }));
    expect(screen.queryByRole("button", { name: "Choose folder…" })).toBeNull();
    const field = (await screen.findByPlaceholderText("/absolute/folder/on/the/host")) as HTMLInputElement;
    const set = screen.getByRole("button", { name: "Set folder" }) as HTMLButtonElement;
    expect(set.disabled).toBe(true);

    fireEvent.change(field, { target: { value: " /srv/backups " } });
    expect(set.disabled).toBe(false);
    fireEvent.click(set);

    await waitFor(() => expect(mocks.checkBackupDestination).toHaveBeenCalledWith(REMOTE, "/srv/backups"));
    await waitFor(() => expect(fakeSettings.writes).toHaveLength(1));
    expect(fakeSettings.writes[0].repo).toBe(REMOTE);
    expect(fakeSettings.writes[0].overrides.backup.destination).toBe("/srv/backups");
    expect(mocks.pickBackupDestinationDialog).not.toHaveBeenCalled();
  });

  it("saves nothing when the host refuses the folder", async () => {
    mocks.checkBackupDestination.mockRejectedValue("backup destination must be outside the repository's .alinery folder");
    renderBackup();
    fireEvent.click(await screen.findByRole("button", { name: "app" }));
    fireEvent.change(await screen.findByPlaceholderText("/absolute/folder/on/the/host"), { target: { value: "/srv/app/.alinery" } });
    fireEvent.click(screen.getByRole("button", { name: "Set folder" }));

    await waitFor(() => expect(mocks.checkBackupDestination).toHaveBeenCalled());
    expect(fakeSettings.writes).toEqual([]);
  });
});

// A repository with backups switched on and a folder chosen: the run and restore buttons are live.
const ARCHIVE = {
  id: "repo-a-1700000000-v1.zip",
  path: "/dest/repo-a-1700000000-v1.zip",
  created_at: 1_700_000_000,
  trigger: "manual",
  size_bytes: 4096,
  alinery_version: "1.0.0",
};
function serveReady() {
  fakeSettings.serve("/repo-a", (overrides) => ({
    ...scoped(overrides.backup.destination ?? "/dest").effective,
    backup: { ...globalSettings.backup, enabled: true, destination: "/dest" },
  }));
}

describe("Settings backup runs", () => {
  beforeEach(() => {
    serveReady();
    mocks.listBackups.mockResolvedValue([ARCHIVE]);
  });

  it("asks the daemon for a manual backup and reads the list again", async () => {
    mocks.backupNow.mockResolvedValue({ repo_name: "repo-a", created_at: 1_700_000_000 });
    renderBackup();
    fireEvent.click(await screen.findByRole("button", { name: "repo-a" }));
    const run = (await screen.findByRole("button", { name: "Back up now" })) as HTMLButtonElement;
    await waitFor(() => expect(mocks.listBackups).toHaveBeenCalled());
    const before = mocks.listBackups.mock.calls.length;
    fireEvent.click(run);
    await waitFor(() => expect(mocks.backupNow).toHaveBeenCalledWith("/repo-a"));
    await waitFor(() => expect(mocks.listBackups.mock.calls.length).toBeGreaterThan(before));
  });

  it("shows a run somebody else started as busy, and leaves both buttons off", async () => {
    mocks.busy.value = true;
    renderBackup();
    fireEvent.click(await screen.findByRole("button", { name: "repo-a" }));
    expect(((await screen.findByRole("button", { name: "Restore" })) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText("Backing up…", { exact: false }).closest("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("verifies the archive with the daemon, then has the shell restore it", async () => {
    renderBackup();
    fireEvent.click(await screen.findByRole("button", { name: "repo-a" }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    await waitFor(() => expect(mocks.restoreBackup).toHaveBeenCalledWith("/repo-a", ARCHIVE.path));
    expect(mocks.verifyBackup).toHaveBeenCalledWith("/repo-a", ARCHIVE.path);
    expect(mocks.verifyBackup.mock.invocationCallOrder[0]).toBeLessThan(mocks.confirmDanger.mock.invocationCallOrder[0]);
    expect(mocks.confirmDanger.mock.invocationCallOrder[0]).toBeLessThan(mocks.restoreBackup.mock.invocationCallOrder[0]);
  });

  it("does not ask to stop anything for an archive the daemon refuses", async () => {
    mocks.verifyBackup.mockRejectedValue(new Error("backup belongs to /other, not /repo-a"));
    renderBackup();
    fireEvent.click(await screen.findByRole("button", { name: "repo-a" }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    await waitFor(() => expect(mocks.verifyBackup).toHaveBeenCalled());
    expect(mocks.confirmDanger).not.toHaveBeenCalled();
    expect(mocks.restoreBackup).not.toHaveBeenCalled();
  });

  it("restores nothing when the person declines", async () => {
    mocks.confirmDanger.mockResolvedValue(false);
    renderBackup();
    fireEvent.click(await screen.findByRole("button", { name: "repo-a" }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    await waitFor(() => expect(mocks.confirmDanger).toHaveBeenCalled());
    expect(mocks.restoreBackup).not.toHaveBeenCalled();
  });

  it("does not poll the backend for a busy flag", async () => {
    vi.useFakeTimers();
    try {
      renderBackup();
      await vi.advanceTimersByTimeAsync(500);
      const settled = mocks.listBackups.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(mocks.listBackups.mock.calls.length).toBe(settled);
    } finally {
      vi.useRealTimers();
    }
  });
});
