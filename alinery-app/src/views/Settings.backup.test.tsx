import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE } from "../appearance";
import { mockIpc } from "../test/mockIpc";
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
  defaults: { harness: "omp", model: "", playbook: { scope: "bundled", key: "superdevelop" }, draft_autosave: false },
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
    provenance: { github_token: "global", defaults: { harness: "global", model: "global", thinking: "global", playbook: "global", draft_autosave: "global" } },
    backup: { ...globalSettings.backup, destination },
    telemetry: globalSettings.telemetry,
  },
});

const mocks = vi.hoisted(() => ({
  checkBackupDestination: vi.fn(),
  pickBackupDestinationDialog: vi.fn(),
  writeRepoOverridesForRepo: vi.fn(),
}));

vi.mock("../ipc", () =>
  mockIpc({
    readGlobalSettings: async () => globalSettings,
    readScopedSettingsForRepo: async () => scoped(""),
    listBackups: async () => [],
    backupBusy: async () => false,
    getVersion: async () => "0.0.0",
    checkBackupDestination: mocks.checkBackupDestination,
    pickBackupDestinationDialog: mocks.pickBackupDestinationDialog,
    writeRepoOverridesForRepo: mocks.writeRepoOverridesForRepo,
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
  mocks.writeRepoOverridesForRepo
    .mockReset()
    .mockImplementation(async (_repo: string, overrides: { backup: { destination?: string } }) => scoped(overrides.backup.destination ?? ""));
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
    await waitFor(() => expect(mocks.writeRepoOverridesForRepo).toHaveBeenCalled());
    expect(mocks.writeRepoOverridesForRepo.mock.calls[0][0]).toBe(REMOTE);
    expect(mocks.writeRepoOverridesForRepo.mock.calls[0][1].backup.destination).toBe("/srv/backups");
    expect(mocks.pickBackupDestinationDialog).not.toHaveBeenCalled();
  });

  it("saves nothing when the host refuses the folder", async () => {
    mocks.checkBackupDestination.mockRejectedValue("backup destination must be outside the repository's .alinery folder");
    renderBackup();
    fireEvent.click(await screen.findByRole("button", { name: "app" }));
    fireEvent.change(await screen.findByPlaceholderText("/absolute/folder/on/the/host"), { target: { value: "/srv/app/.alinery" } });
    fireEvent.click(screen.getByRole("button", { name: "Set folder" }));

    await waitFor(() => expect(mocks.checkBackupDestination).toHaveBeenCalled());
    expect(mocks.writeRepoOverridesForRepo).not.toHaveBeenCalled();
  });
});
