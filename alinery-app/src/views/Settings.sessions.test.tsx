import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    repoLiveSessions: async () => 0,
    listHarnessModels: async () => [],
    listHarnessModelsForRepo: async () => [],
    getVersion: async () => "0.0.0",
    writeAppearance: mocks.writeAppearance,
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

function renderSection(initialSection: "harness" | "sessionsView" | "chat", appearance: AppearancePrefs = DEFAULT_APPEARANCE) {
  render(
    <Settings
      mcp={mcp}
      activeRepo="/r"
      knownRepos={["/r"]}
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
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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

describe("Harness settings thinking default", () => {
  // By role: in a repo scope the label also holds the badge's "Use global value" button, which label text queries match too.
  const thinkingSelect = async () => (await screen.findByRole("combobox", { name: /Default thinking level/ })) as HTMLSelectElement;

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

  // The journal rows both tabs start with: thinking, tools and turn markers hidden; harness notices,
  // subagent rows and drawer, date, time and the per-message copy icon shown; no actor labels,
  // agent bubbles or block copy buttons.
  const JOURNAL_DEFAULTS: [RegExp, boolean][] = [
    [/Show thinking/, false],
    [/Expand thinking by default/, false],
    [/Show tool use/, false],
    [/Expand tools by default/, false],
    [/Show harness events/, true],
    [/Show turn markers/, false],
    [/Show subagent rows/, true],
    [/Show subagent drawer/, true],
    [/Show date/, true],
    [/Show time/, true],
    [/Show You \/ Agent labels/, false],
    [/Show agent reply bubbles/, false],
    [/Show block copy buttons/, false],
    [/Show copy buttons/, true],
  ];

  it.each(["sessionsView", "chat"] as const)("%s starts with the shared journal defaults", async (section) => {
    renderSection(section, DEFAULT_APPEARANCE);
    await screen.findByLabelText(/Show thinking/);
    for (const [label, checked] of JOURNAL_DEFAULTS) expect((screen.getByLabelText(label) as HTMLInputElement).checked, String(label)).toBe(checked);
  });

  it("Chat describes the meta strip and column width for Ava", async () => {
    renderSection("chat");
    expect(await screen.findByText("— repo · branch · status line under the thread title")).toBeTruthy();
    expect(screen.getByText("Limits the width of the message thread, composer and notices.")).toBeTruthy();
    expect(screen.getByText("Which journal rows appear in the Chat view. Global-only.")).toBeTruthy();
    expect(screen.getByText("Density, sizing and behavior of the Chat view. Global-only.")).toBeTruthy();
    expect(screen.getByText("Chat view column width")).toBeTruthy();
    expect(screen.getByText("Chat view text")).toBeTruthy();
    expect(screen.queryByText(/model · thinking · event count/)).toBeNull();
    expect(screen.queryByText(/Limits journal thread width/)).toBeNull();
  });

  it("Sessions view keeps the journal descriptions for the session thread", async () => {
    renderSection("sessionsView");
    expect(await screen.findByText("— model · thinking · event count · context above the chat")).toBeTruthy();
    expect(screen.getByText("Limits journal thread width; meta and composer stay full width.")).toBeTruthy();
    expect(screen.getByText("Which journal rows appear in session chats. Global-only.")).toBeTruthy();
    expect(screen.getByText("Density, sizing and behavior of session chats. Global-only.")).toBeTruthy();
    expect(screen.getByText("Session chat column width")).toBeTruthy();
    expect(screen.getByText("Session chat text")).toBeTruthy();
    expect(screen.queryByText(/status line under the thread title/)).toBeNull();
    expect(screen.queryByText(/message thread, composer and notices/)).toBeNull();
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
    expect(screen.queryByRole("button", { name: "Update OMP" })).toBeNull();
  });

  it("Update OMP goes through confirm, then updateOmp", async () => {
    mocks.checkOmpUpdate.mockResolvedValue({
      installed: "18.1.10",
      available: { version: "18.2.0", asset_url: "https://example.test/omp" },
      checked_at: 1,
    });
    renderHarnessSection();
    const omp = await screen.findByRole("region", { name: "OMP" });
    const button = await within(omp).findByRole("button", { name: "Update OMP" });
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
