import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE, normalizeChatView } from "../appearance";
import { mockIpc } from "../test/mockIpc";
import type { AppearancePrefs, GlobalSettings, RepoOverrides, ScopedSettings } from "../types";
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
  telemetry: { enabled: true, prompted: false, install_id: "", endpoint: "https://telemetry.alinery.ai" },
  updates: { check_enabled: true },
  // The Chat settings section only exists while the experimental Chat tab is on.
  experiments: { show_chat: true },
};

// A repo scope on top of `global`: `overrides` is what the repo file holds, and each field's provenance follows it.
function scopedFor(global: GlobalSettings, overrides: RepoOverrides): ScopedSettings {
  const thinking = overrides.defaults.thinking;
  return {
    global,
    overrides,
    effective: {
      notifications: global.notifications,
      github: global.github,
      defaults: { ...global.defaults, thinking: thinking ?? global.defaults.thinking },
      provenance: {
        github_token: "global",
        defaults: { harness: "global", model: "global", thinking: thinking == null ? "global" : "repository", playbook: "global", draft_autosave: "global" },
      },
      backup: global.backup,
      telemetry: global.telemetry,
    },
  };
}

const mocks = vi.hoisted(() => ({
  writeGlobalSettings: vi.fn(),
  readGlobalSettings: vi.fn(),
  readScopedSettingsForRepo: vi.fn(),
  writeRepoOverridesForRepo: vi.fn(),
  checkOmpUpdate: vi.fn(),
  writeAppearance: vi.fn(),
  updateOmp: vi.fn(),
  confirmDanger: vi.fn(),
  askConfirm: vi.fn(),
  repoLiveSessions: vi.fn(),
  stopDaemon: vi.fn(),
}));

vi.mock("../ipc", () =>
  mockIpc({
    readGlobalSettings: mocks.readGlobalSettings,
    writeGlobalSettings: mocks.writeGlobalSettings,
    readScopedSettingsForRepo: mocks.readScopedSettingsForRepo,
    writeRepoOverridesForRepo: mocks.writeRepoOverridesForRepo,
    checkOmpUpdate: mocks.checkOmpUpdate,
    updateOmp: mocks.updateOmp,
    storageInfo: () => new Promise(() => {}),
    repoLiveSessions: mocks.repoLiveSessions,
    stopDaemon: mocks.stopDaemon,
    listHarnessModels: async () => [],
    listHarnessModelsForRepo: async () => [],
    getVersion: async () => "0.0.0",
    writeAppearance: mocks.writeAppearance,
  }),
);

vi.mock("../confirm", () => ({ confirmDanger: mocks.confirmDanger, askConfirm: mocks.askConfirm }));

vi.mock("./ProviderSetupDialog", () => ({
  ProviderSetupDialog: ({ onPick, onClose }: { onPick?: (model: string) => void; onClose: () => void }) => (
    <div>
      <button type="button" onClick={() => onPick?.("openai/gpt-5")}>
        Pick GPT-5
      </button>
      <button type="button" onClick={onClose}>
        Close picker
      </button>
    </div>
  ),
}));

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

function renderSection(initialSection: "harness" | "sessionsView" | "chat", appearance: AppearancePrefs = DEFAULT_APPEARANCE, knownRepos = ["/r"]) {
  render(
    <Settings
      mcp={mcp}
      activeRepo="/r"
      knownRepos={knownRepos}
      appearance={appearance}
      onAppearanceChange={() => {}}
      onNotificationsChange={() => {}}
      initialSection={initialSection}
    />,
  );
}

const renderHarnessSection = () => renderSection("harness");

function lastSavedAppearance(): AppearancePrefs {
  return mocks.writeAppearance.mock.calls[mocks.writeAppearance.mock.calls.length - 1]?.[0];
}

beforeEach(() => {
  mocks.writeGlobalSettings.mockReset().mockImplementation(async (next: GlobalSettings) => next);
  mocks.readGlobalSettings.mockReset().mockResolvedValue(baseGlobal);
  mocks.readScopedSettingsForRepo.mockReset().mockResolvedValue(scopedFor(baseGlobal, { github: {}, defaults: {}, backup: {} }));
  mocks.writeRepoOverridesForRepo.mockReset().mockImplementation(async (_repo: string, overrides: RepoOverrides) => scopedFor(baseGlobal, overrides));
  vi.stubGlobal("localStorage", {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
  });
  mocks.checkOmpUpdate.mockReset().mockResolvedValue({ installed: "", available: null, checked_at: 0 });
  mocks.updateOmp.mockReset().mockResolvedValue("omp/18.2.0");
  mocks.writeAppearance
    .mockReset()
    .mockImplementation(async (appearance: typeof DEFAULT_APPEARANCE) => ({ active_repo: "/r", known_repos: ["/r"], mcp_enabled: true, appearance }));
  mocks.confirmDanger.mockReset().mockResolvedValue(true);
  mocks.askConfirm.mockReset().mockResolvedValue("update");
  mocks.repoLiveSessions.mockReset().mockResolvedValue(0);
  mocks.stopDaemon.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Harness live session observations", () => {
  function deferredCount() {
    let resolve!: (count: number) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<number>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  }

  async function openService(knownRepos = ["/r"]) {
    renderSection("harness", DEFAULT_APPEARANCE, knownRepos);
    const summary = await screen.findByText(/Session service/);
    fireEvent.click(summary);
    return summary.closest("details") as HTMLElement;
  }

  it("publishes successful repos independently of failed and pending peers", async () => {
    const slow = deferredCount();
    mocks.repoLiveSessions.mockImplementation((repo: string) => (repo === "/r" ? Promise.resolve(3) : repo === "/failed" ? Promise.reject(new Error("offline")) : slow.promise));
    const service = await openService(["/r", "/failed", "/slow"]);
    await waitFor(() => {
      expect(within(service).getByText(/r — 3 live sessions/)).toBeTruthy();
      expect(within(service).getByText(/failed — Unknown/)).toBeTruthy();
      expect(within(service).getByText(/slow — Checking/)).toBeTruthy();
    });
    expect(service.textContent).not.toContain("No live sessions");
    await act(async () => slow.resolve(2));
    expect(within(service).getByText(/slow — 2 live sessions/)).toBeTruthy();
  });

  it("retains cached zero during pending and failed refreshes, including shutdown confirmation", async () => {
    const intervals = vi.spyOn(globalThis, "setInterval");
    const refresh = deferredCount();
    mocks.repoLiveSessions.mockResolvedValueOnce(0).mockReturnValueOnce(refresh.promise);
    const service = await openService();
    await waitFor(() => expect(within(service).getByText(/r — 0 live sessions — Last checked/)).toBeTruthy());
    const tick = intervals.mock.calls.find((call) => call[1] === 2000)?.[0];
    if (typeof tick !== "function") throw new Error("Session polling callback was not registered");
    act(() => tick());
    expect(within(service).getByText(/r — 0 live sessions.*Checking latest count/)).toBeTruthy();
    act(() => tick());
    expect(mocks.repoLiveSessions).toHaveBeenCalledTimes(2);
    await act(async () => refresh.reject(new Error("offline")));
    expect(within(service).getByText(/r — 0 live sessions.*Last checked.*Could not fetch latest count/)).toBeTruthy();
    expect(service.textContent).not.toContain("No live sessions");
    mocks.confirmDanger.mockResolvedValueOnce(false);
    fireEvent.click(within(service).getByRole("button", { name: /Stop all sessions/ }));
    await waitFor(() => expect(mocks.confirmDanger).toHaveBeenCalled());
    const confirmation = render(mocks.confirmDanger.mock.calls[0][1]);
    expect(confirmation.container.textContent).toContain("Could not fetch latest count");
    expect(confirmation.container.textContent).toContain("Last checked");
    expect(confirmation.container.textContent).toContain("Current live session counts are not confirmed");
    expect(confirmation.container.textContent).not.toContain("No live sessions");
    expect(mocks.stopDaemon).not.toHaveBeenCalled();
  });

  it("warns for uncached failures but still honors explicit shutdown authorization and refreshes afterwards", async () => {
    mocks.repoLiveSessions.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(0);
    const service = await openService();
    await waitFor(() => expect(within(service).getByText(/r — Unknown/)).toBeTruthy());
    fireEvent.click(within(service).getByRole("button", { name: /Stop all sessions/ }));
    await waitFor(() => expect(mocks.stopDaemon).toHaveBeenCalledWith("/r"));
    const confirmation = render(mocks.confirmDanger.mock.calls[0][1]);
    expect(confirmation.container.textContent).toContain("Unknown");
    expect(confirmation.container.textContent).not.toContain("No live sessions");
    await waitFor(() => expect(within(service).getByText(/r — 0 live sessions — Last checked/)).toBeTruthy());
  });

  it("ignores old scope responses while preserving successful per-repo cache", async () => {
    const intervals = vi.spyOn(globalThis, "setInterval");
    const oldRefresh = deferredCount();
    const currentRefresh = deferredCount();
    mocks.repoLiveSessions.mockImplementation((repo: string) => (repo === "/other" ? Promise.resolve(1) : Promise.resolve(4)));
    const service = await openService(["/r", "/other"]);
    await waitFor(() => expect(within(service).getByText(/r — 4 live sessions/)).toBeTruthy());
    mocks.repoLiveSessions.mockImplementation((repo: string) => (repo === "/r" ? oldRefresh.promise : Promise.resolve(1)));
    const tick = intervals.mock.calls.find((call) => call[1] === 2000)?.[0];
    if (typeof tick !== "function") throw new Error("Session polling callback was not registered");
    act(() => tick());
    mocks.repoLiveSessions.mockImplementation((repo: string) => (repo === "/r" ? currentRefresh.promise : Promise.resolve(1)));
    fireEvent.click(screen.getByRole("button", { name: "r" }));
    expect(within(service).getByText(/r — 4 live sessions.*Checking latest count/)).toBeTruthy();
    expect(within(service).queryByText(/other —/)).toBeNull();
    await act(async () => oldRefresh.resolve(99));
    expect(service.textContent).not.toContain("99 live sessions");
    await act(async () => currentRefresh.reject(new Error("offline")));
    expect(within(service).getByText(/r — 4 live sessions.*Could not fetch latest count/)).toBeTruthy();
  });
});

describe("Harness settings model default", () => {
  it("does not offer a leftover claude model as the OMP default", async () => {
    mocks.readGlobalSettings.mockResolvedValue({
      ...baseGlobal,
      defaults: { harness: "claude", model: "sonnet", playbook: { scope: "bundled", key: "superdevelop" }, draft_autosave: false },
    });
    renderHarnessSection();
    await waitFor(() => expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe(""));
  });

  it("stamps defaults.harness as omp when a model is picked", async () => {
    mocks.readGlobalSettings.mockResolvedValue({ ...baseGlobal, defaults: { ...baseGlobal.defaults, harness: "claude", model: "sonnet" } });
    renderHarnessSection();
    fireEvent.click(await screen.findByRole("combobox", { name: "Model" }));
    fireEvent.click(await screen.findByRole("button", { name: "Pick GPT-5" }));
    await waitFor(() => expect(mocks.writeGlobalSettings).toHaveBeenCalled());
    const saved = mocks.writeGlobalSettings.mock.calls[mocks.writeGlobalSettings.mock.calls.length - 1][0] as GlobalSettings;
    expect(saved.defaults.harness).toBe("omp");
    expect(saved.defaults.model).toBe("openai/gpt-5");
    expect((screen.getByRole("combobox", { name: "Model" }) as HTMLInputElement).value).toBe("openai/gpt-5");
  });

  it("does not write an override merely by opening the picker", async () => {
    renderHarnessSection();
    const trigger = await screen.findByRole("combobox", { name: "Model" });
    fireEvent.click(trigger);
    fireEvent.blur(trigger);
    fireEvent.click(await screen.findByRole("button", { name: "Close picker" }));
    expect(mocks.writeGlobalSettings).not.toHaveBeenCalled();
    expect(mocks.writeRepoOverridesForRepo).not.toHaveBeenCalled();
  });
});

describe("Harness settings thinking default", () => {
  // By role: in a repo scope the label also holds the badge's "Use global value" button, which label text queries match too.
  const thinkingSelect = async () => {
    const summary = await screen.findByText("Session preferences");
    if (!summary.closest("details")?.open) fireEvent.click(summary);
    return (await screen.findByRole("combobox", { name: /Default thinking level/ })) as HTMLSelectElement;
  };

  it("shows high while the setting is unset", async () => {
    renderHarnessSection();
    const select = await thinkingSelect();
    expect(select.value).toBe("high");
    expect(Array.from(select.options, (option) => option.value)).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  it("shows high for a stored value the daemon would not launch with", async () => {
    mocks.readGlobalSettings.mockResolvedValue({ ...baseGlobal, defaults: { ...baseGlobal.defaults, thinking: "turbo" } });
    renderHarnessSection();
    expect((await thinkingSelect()).value).toBe("high");
  });

  it("shows a stored valid value", async () => {
    mocks.readGlobalSettings.mockResolvedValue({ ...baseGlobal, defaults: { ...baseGlobal.defaults, thinking: "medium" } });
    renderHarnessSection();
    expect((await thinkingSelect()).value).toBe("medium");
  });

  it("writes a global change as defaults.thinking", async () => {
    renderHarnessSection();
    fireEvent.change(await thinkingSelect(), { target: { value: "low" } });
    await waitFor(() => expect(mocks.writeGlobalSettings).toHaveBeenCalled());
    const saved = mocks.writeGlobalSettings.mock.calls[mocks.writeGlobalSettings.mock.calls.length - 1][0] as GlobalSettings;
    expect(saved.defaults.thinking).toBe("low");
    expect(saved.defaults.model).toBe("");
    expect(mocks.writeRepoOverridesForRepo).not.toHaveBeenCalled();
  });

  it("writes a repo change as a repository override and labels it", async () => {
    renderHarnessSection();
    fireEvent.click(await screen.findByRole("button", { name: "r" }));
    const field = async () => (await thinkingSelect()).closest(".field") as HTMLElement;
    expect(within(await field()).getByText("Global")).toBeTruthy();
    fireEvent.change(await thinkingSelect(), { target: { value: "low" } });
    await waitFor(() => expect(mocks.writeRepoOverridesForRepo).toHaveBeenCalled());
    const [repo, overrides] = mocks.writeRepoOverridesForRepo.mock.calls[0] as [string, RepoOverrides];
    expect(repo).toBe("/r");
    expect(overrides.defaults.thinking).toBe("low");
    expect(mocks.writeGlobalSettings).not.toHaveBeenCalled();
    await waitFor(async () => expect(within(await field()).getByText(/Repository override/)).toBeTruthy());
    expect((await thinkingSelect()).value).toBe("low");
  });
});

describe("Sessions view and Chat tabs", () => {
  // Each tab edits its own copy: the Sessions view writes the flat chat_* fields, Chat writes ava_chat.
  const avaChat = normalizeChatView({ chat_max_width: "600", chat_font_size: 18, chat_show_copy_buttons: true });
  const split: AppearancePrefs = { ...DEFAULT_APPEARANCE, chat_max_width: "1200", chat_font_size: 12, chat_show_copy_buttons: true, ava_chat: avaChat };

  it.each(["sessionsView", "chat"] as const)("%s checks labels, reply bubbles, and block copying when preferences are absent", async (section) => {
    const missing = { chat_show_actor_labels: undefined, chat_show_agent_bubbles: undefined, chat_show_block_copy_buttons: undefined };
    renderSection(section, { ...DEFAULT_APPEARANCE, ...missing, ava_chat: missing });
    for (const label of [/Show You \/ Agent labels/, /Show agent reply bubbles/, /Show block copy buttons/]) {
      expect(((await screen.findByLabelText(label)) as HTMLInputElement).checked).toBe(true);
    }
  });

  it.each(["sessionsView", "chat"] as const)("%s preserves unchecked labels, reply bubbles, and block copying", async (section) => {
    const disabled = { chat_show_actor_labels: false, chat_show_agent_bubbles: false, chat_show_block_copy_buttons: false };
    renderSection(section, { ...DEFAULT_APPEARANCE, ...disabled, ava_chat: disabled });
    for (const label of [/Show You \/ Agent labels/, /Show agent reply bubbles/, /Show block copy buttons/]) {
      expect(((await screen.findByLabelText(label)) as HTMLInputElement).checked).toBe(false);
    }
  });

  it("Sessions view persists the copy button toggle into the flat chat_* fields and leaves ava_chat untouched", async () => {
    renderSection("sessionsView", split);
    const toggle = await screen.findByLabelText(/Show copy buttons/);
    expect((toggle as HTMLInputElement).checked).toBe(true);
    fireEvent.click(toggle);
    await waitFor(() => expect(mocks.writeAppearance).toHaveBeenCalled());
    const saved = lastSavedAppearance();
    expect(saved).toMatchObject({ chat_show_copy_buttons: false, chat_max_width: "1200", chat_font_size: 12 });
    expect(saved.ava_chat).toEqual(avaChat);
  });

  it("Chat renders its own values, not the flat chat_* fields", async () => {
    renderSection("chat", { ...split, chat_show_copy_buttons: false, chat_max_width: "none" });
    expect(((await screen.findByLabelText(/Show copy buttons/)) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("button", { name: "600px" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "None" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("Chat persists a toggle into ava_chat and leaves the flat chat_* fields untouched", async () => {
    renderSection("chat", split);
    fireEvent.click(await screen.findByLabelText(/Show copy buttons/));
    await waitFor(() => expect(mocks.writeAppearance).toHaveBeenCalled());
    const saved = lastSavedAppearance();
    expect(saved.ava_chat).toEqual({ ...avaChat, chat_show_copy_buttons: false });
    expect(saved).toMatchObject({ chat_show_copy_buttons: true, chat_max_width: "1200", chat_font_size: 12 });
  });

  it("Chat persists a choice card into ava_chat only", async () => {
    renderSection("chat", split);
    fireEvent.click(await screen.findByRole("button", { name: "Dense" }));
    await waitFor(() => expect(mocks.writeAppearance).toHaveBeenCalled());
    const saved = lastSavedAppearance();
    expect(saved.ava_chat?.chat_rail_density).toBe("dense");
    expect(saved.chat_rail_density).toBe("normal");
  });

  it("Chat falls back to the defaults when ava_chat was never saved", async () => {
    renderSection("chat", { ...DEFAULT_APPEARANCE, chat_show_copy_buttons: false });
    expect(((await screen.findByLabelText(/Show copy buttons/)) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("button", { name: "900px" }).getAttribute("aria-pressed")).toBe("true");
  });
});

describe("Harness OMP version", () => {
  it("Update OMP goes through confirm, then updateOmp", async () => {
    mocks.checkOmpUpdate.mockResolvedValue({
      installed: "18.1.10",
      available: { version: "18.2.0", asset_url: "https://example.test/omp" },
      checked_at: 1,
    });
    renderHarnessSection();
    const omp = await screen.findByRole("region", { name: "Agent & providers" });
    const button = await within(omp).findByRole("button", { name: "Update OMP" });
    fireEvent.click(button);
    await waitFor(() => expect(mocks.askConfirm).toHaveBeenCalled());
    await waitFor(() => expect(mocks.updateOmp).toHaveBeenCalledTimes(1));

    mocks.updateOmp.mockClear();
    mocks.askConfirm.mockResolvedValueOnce("cancel");
    fireEvent.click(await screen.findByRole("button", { name: "Update OMP" }));
    await waitFor(() => expect(mocks.askConfirm).toHaveBeenCalledTimes(2));
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
