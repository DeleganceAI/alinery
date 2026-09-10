import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE } from "../appearance";
import { mockIpc } from "../test/mockIpc";
import type { GlobalSettings } from "../types";
import type { McpStatusHandle } from "../useMcpStatus";

const baseGlobal: GlobalSettings = {
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
  defaults: { harness: "omp", model: "", playbook: "", draft_autosave: false },
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

const mocks = vi.hoisted(() => ({
  writeGlobalSettings: vi.fn(),
  readGlobalSettings: vi.fn(),
  checkOmpUpdate: vi.fn(),
  updateOmp: vi.fn(),
  confirmDanger: vi.fn(),
}));

vi.mock("../ipc", () =>
  mockIpc({
    readGlobalSettings: mocks.readGlobalSettings,
    writeGlobalSettings: mocks.writeGlobalSettings,
    checkOmpUpdate: mocks.checkOmpUpdate,
    updateOmp: mocks.updateOmp,
    storageInfo: () => new Promise(() => {}),
    repoLiveSessions: async () => 0,
    listHarnessModels: async () => [],
    listHarnessModelsForRepo: async () => [],
    getVersion: async () => "0.0.0",
  }),
);

vi.mock("../confirm", () => ({ confirmDanger: mocks.confirmDanger }));

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

function renderHarnessSection() {
  render(
    <Settings mcp={mcp} activeRepo="/r" knownRepos={["/r"]} appearance={DEFAULT_APPEARANCE} onAppearanceChange={() => {}} onNotificationsChange={() => {}} initialSection="chat" />,
  );
}

beforeEach(() => {
  mocks.writeGlobalSettings.mockReset().mockImplementation(async (next: GlobalSettings) => next);
  mocks.readGlobalSettings.mockReset().mockResolvedValue(baseGlobal);
  mocks.checkOmpUpdate.mockReset().mockResolvedValue({ installed: "", available: null, checked_at: 0 });
  mocks.updateOmp.mockReset().mockResolvedValue("omp/18.2.0");
  mocks.confirmDanger.mockReset().mockResolvedValue(true);
});

afterEach(cleanup);

describe("Harness settings model default", () => {
  it("does not offer a leftover claude model as the OMP default", async () => {
    mocks.readGlobalSettings.mockResolvedValue({
      ...baseGlobal,
      defaults: { harness: "claude", model: "sonnet", playbook: "", draft_autosave: false },
    });
    renderHarnessSection();
    await waitFor(() => expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe(""));
  });

  it("stamps defaults.harness as omp when committing a model", async () => {
    renderHarnessSection();
    const input = (await screen.findByLabelText("Model")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "gpt-5" } });
    fireEvent.blur(input);
    await waitFor(() => expect(mocks.writeGlobalSettings).toHaveBeenCalled());
    const saved = mocks.writeGlobalSettings.mock.calls[mocks.writeGlobalSettings.mock.calls.length - 1][0] as GlobalSettings;
    expect(saved.defaults.harness).toBe("omp");
    expect(saved.defaults.model).toBe("gpt-5");
  });
});

describe("Harness OMP version", () => {
  it("renders installed and available versions", async () => {
    mocks.checkOmpUpdate.mockResolvedValue({
      installed: "18.1.10",
      available: { version: "18.2.0", asset_url: "https://example.test/omp" },
      checked_at: 1,
    });
    renderHarnessSection();
    await waitFor(() => expect(screen.getByText(/Installed: 18.1.10/)).toBeTruthy());
    expect(screen.getByText(/Update available: 18.2.0/)).toBeTruthy();
    expect(screen.getByLabelText("Model")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Stop all sessions/ })).toBeTruthy();
  });

  it("names the binary and the config home this install uses", async () => {
    // A version with no location cannot answer "which install am I looking at" -- the whole
    // reason this panel got the paths.
    mocks.checkOmpUpdate.mockResolvedValue({
      installed: "18.1.10",
      available: null,
      checked_at: 1,
      binary_path: "/Applications/Alinery.omp/omp",
      config_dir: "/cfg/ai.delegance.alinery.dev/instances/abc123/omp/config/agent",
    });
    renderHarnessSection();
    await waitFor(() => expect(screen.getByText(/Binary: \/Applications\/Alinery.omp\/omp/)).toBeTruthy());
    expect(screen.getByText(/Config: .*instances\/abc123\/omp\/config\/agent/)).toBeTruthy();
  });

  it("says nothing rather than showing blanks when the paths are unknown", async () => {
    mocks.checkOmpUpdate.mockResolvedValue({ installed: "18.1.10", available: null, checked_at: 1, binary_path: "", config_dir: "" });
    renderHarnessSection();
    await waitFor(() => expect(screen.getByText(/Installed: 18.1.10/)).toBeTruthy());
    expect(screen.queryByText(/Binary:/)).toBeNull();
    expect(screen.queryByText(/Config:/)).toBeNull();
  });

  it("Update OMP goes through confirm, then updateOmp", async () => {
    mocks.checkOmpUpdate.mockResolvedValue({
      installed: "18.1.10",
      available: { version: "18.2.0", asset_url: "https://example.test/omp" },
      checked_at: 1,
    });
    renderHarnessSection();
    const button = await screen.findByRole("button", { name: "Update OMP" });
    fireEvent.click(button);
    await waitFor(() => expect(mocks.confirmDanger).toHaveBeenCalled());
    await waitFor(() => expect(mocks.updateOmp).toHaveBeenCalledTimes(1));

    mocks.updateOmp.mockClear();
    mocks.confirmDanger.mockResolvedValueOnce(false);
    fireEvent.click(await screen.findByRole("button", { name: "Update OMP" }));
    await waitFor(() => expect(mocks.confirmDanger).toHaveBeenCalledTimes(2));
    expect(mocks.updateOmp).not.toHaveBeenCalled();
  });

  it("hides the available offer after a successful OMP update", async () => {
    mocks.checkOmpUpdate.mockResolvedValue({
      installed: "18.1.10",
      available: { version: "18.2.0", asset_url: "https://example.test/omp" },
      checked_at: 1,
    });
    renderHarnessSection();
    const button = await screen.findByRole("button", { name: "Update OMP" });
    mocks.checkOmpUpdate.mockResolvedValue({ installed: "18.2.0", available: null, checked_at: 2 });
    fireEvent.click(button);
    await waitFor(() => expect(mocks.updateOmp).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText(/Update available:/)).toBeNull());
  });
});
