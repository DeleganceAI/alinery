import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE } from "../appearance";
import { mockIpc } from "../test/mockIpc";
import type { GlobalSettings } from "../types";
import type { McpStatusHandle } from "../useMcpStatus";

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
  defaults: { harness: "claude", model: "", playbook: "", draft_autosave: false },
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

vi.mock("../ipc", () =>
  mockIpc({
    readGlobalSettings: async () => globalSettings,
    storageInfo: async () => {
      throw new Error("Storage is not used by this test");
    },
    connectionStatuses: vi.fn(async () => []),
    orbitronXaiKeyStatus: vi.fn(async () => ({ present: false })),
    clearOrbitronXaiKey: vi.fn(async () => ({ present: false })),
  }),
);

// askConfirm resolves the cancel key when no ConfirmHost is mounted, so without stubbing this the
// accepted path can never run and a "did not call the backend" assertion would pass on its own.
vi.mock("../confirm", () => ({ confirmDanger: vi.fn(async () => true) }));

import { confirmDanger } from "../confirm";
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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("provider connections", () => {
  it("loads status only after the Connections section opens", async () => {
    render(<Settings mcp={mcp} activeRepo="/r" knownRepos={["/r"]} appearance={DEFAULT_APPEARANCE} onAppearanceChange={() => {}} onNotificationsChange={() => {}} />);

    const connections = await screen.findByRole("button", { name: "Connections" });
    expect(ipc.connectionStatuses).not.toHaveBeenCalled();

    fireEvent.click(connections);

    await waitFor(() => expect(ipc.connectionStatuses).toHaveBeenCalledTimes(1));
  });

  // A connection made before the account label moved out of the Keychain reports reconnect
  // without being broken. It has to keep saying Connected, or a working connection reads as a
  // dead one — while still offering the button that fills the label back in.
  it("keeps the Connected badge and offers Reconnect when a live connection asks for one", async () => {
    vi.mocked(ipc.connectionStatuses).mockResolvedValueOnce([
      {
        provider: "linear",
        name: "Linear",
        kind: "Web",
        connected: true,
        reconnect: true,
        available: true,
        removable: true,
        account: "",
        detail: "Connected — reconnect to show your account",
      },
    ]);

    render(<Settings mcp={mcp} activeRepo="/r" knownRepos={["/r"]} appearance={DEFAULT_APPEARANCE} onAppearanceChange={() => {}} onNotificationsChange={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Connections" }));

    expect(await screen.findByText("Connected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Linear connection actions" }));
    expect(screen.getByRole("menuitem", { name: "Reconnect" })).toBeTruthy();
  });

  // Existence alone can render Connected (the status path never decrypts), so a Linear row with a
  // dead credential must always carry a way out — the menu, not a button that only appears when the
  // backend already knows something is wrong.
  it("offers remove and reconnect on a Linear row that reports nothing wrong", async () => {
    vi.mocked(ipc.connectionStatuses).mockResolvedValueOnce([
      {
        provider: "linear",
        name: "Linear",
        kind: "Web",
        connected: true,
        reconnect: false,
        available: true,
        removable: true,
        account: "someone@example.com",
        detail: "Connected",
      },
    ]);

    render(<Settings mcp={mcp} activeRepo="/r" knownRepos={["/r"]} appearance={DEFAULT_APPEARANCE} onAppearanceChange={() => {}} onNotificationsChange={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Connections" }));

    fireEvent.click(await screen.findByRole("button", { name: "Linear connection actions" }));
    expect(screen.getByRole("menuitem", { name: "Reconnect" })).toBeTruthy();
    vi.mocked(ipc.disconnectLinear).mockResolvedValueOnce({
      provider: "linear",
      name: "Linear",
      kind: "Web",
      connected: false,
      reconnect: false,
      available: true,
      removable: false,
      account: "",
      detail: "Not connected",
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove connection" }));

    // Deleting the Keychain entry is not undoable, so it asks first and only then calls the backend,
    // and the row it patches back in has to be the one the backend just recomputed.
    await waitFor(() => expect(ipc.disconnectLinear).toHaveBeenCalledTimes(1));
    expect(confirmDanger).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("button", { name: "Connect Linear" })).toBeTruthy();
  });

  // Alinery holds no GitHub credential — gh does — so the only removal it could perform is
  // `gh auth logout`, which reaches into the user's terminal. That item must not exist at all.
  it("offers GitHub reconnect but never a remove", async () => {
    vi.mocked(ipc.connectionStatuses).mockResolvedValueOnce([
      { provider: "github", name: "GitHub", kind: "Web", connected: true, reconnect: false, available: true, removable: false, account: "matthewrball", detail: "Connected" },
    ]);

    render(<Settings mcp={mcp} activeRepo="/r" knownRepos={["/r"]} appearance={DEFAULT_APPEARANCE} onAppearanceChange={() => {}} onNotificationsChange={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Connections" }));

    fireEvent.click(await screen.findByRole("button", { name: "GitHub connection actions" }));
    expect(screen.getByRole("menuitem", { name: "Reconnect" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Remove connection" })).toBeNull();
  });

  it("loads xAI key status only after Connections opens", async () => {
    render(<Settings mcp={mcp} activeRepo="/r" knownRepos={["/r"]} appearance={DEFAULT_APPEARANCE} onAppearanceChange={() => {}} onNotificationsChange={() => {}} />);
    expect(ipc.orbitronXaiKeyStatus).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Connections" }));
    await waitFor(() => expect(ipc.orbitronXaiKeyStatus).toHaveBeenCalledTimes(1));
  });

  it("shows Set when absent and Replace plus Clear when present", async () => {
    vi.mocked(ipc.orbitronXaiKeyStatus).mockResolvedValueOnce({ present: false });
    const { unmount } = render(
      <Settings mcp={mcp} activeRepo="/r" knownRepos={["/r"]} appearance={DEFAULT_APPEARANCE} onAppearanceChange={() => {}} onNotificationsChange={() => {}} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Connections" }));
    expect(await screen.findByRole("button", { name: "Set" })).toBeTruthy();
    expect(ipc.connectGithub).not.toHaveBeenCalled();
    expect(ipc.connectLinear).not.toHaveBeenCalled();
    unmount();

    vi.mocked(ipc.orbitronXaiKeyStatus).mockResolvedValueOnce({ present: true });
    render(<Settings mcp={mcp} activeRepo="/r" knownRepos={["/r"]} appearance={DEFAULT_APPEARANCE} onAppearanceChange={() => {}} onNotificationsChange={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Connections" }));
    expect(await screen.findByRole("button", { name: "Replace" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear" })).toBeTruthy();
  });

  it("clears the xAI key through confirmDanger not window.confirm", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    vi.mocked(ipc.orbitronXaiKeyStatus).mockResolvedValue({ present: true });
    render(<Settings mcp={mcp} activeRepo="/r" knownRepos={["/r"]} appearance={DEFAULT_APPEARANCE} onAppearanceChange={() => {}} onNotificationsChange={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Connections" }));
    fireEvent.click(await screen.findByRole("button", { name: "Clear" }));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(confirmDanger).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(ipc.clearOrbitronXaiKey).toHaveBeenCalledTimes(1));
    confirmSpy.mockRestore();
  });
});
