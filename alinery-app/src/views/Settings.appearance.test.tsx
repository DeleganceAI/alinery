import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ARTIFACT_FONT_MAX, ARTIFACT_VIEWER_WIDTH_DEFAULT, DEFAULT_APPEARANCE, TERMINAL_FONT_MIN } from "../appearance";
import { mockIpc } from "../test/mockIpc";
import type { AppConfig, AppearancePrefs, GlobalSettings } from "../types";
import type { McpStatusHandle } from "../useMcpStatus";

// Regression pin for the Stage D triage finding: the appearance-mode select must
// apply the theme synchronously and persist through write_appearance. The select
// is located by its accessible name, which also pins the label association.

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

const appConfigFor = (appearance: AppearancePrefs): AppConfig => ({ active_repo: "/r", known_repos: ["/r"], mcp_enabled: true, appearance });

vi.mock("../ipc", () =>
  mockIpc({
    readGlobalSettings: async () => globalSettings,
    // Storage loads eagerly with the view; keep it pending — no test visits it.
    storageInfo: () => new Promise(() => {}),
    writeAppearance: vi.fn(async (appearance: AppearancePrefs) => appConfigFor(appearance)),
  }),
);

import * as ipc from "../ipc";
import { SECTIONS, Settings } from "./Settings";

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

function renderAppearanceSection(onAppearanceChange = vi.fn(), appearance: AppearancePrefs = DEFAULT_APPEARANCE) {
  render(
    <Settings
      mcp={mcp}
      activeRepo="/r"
      knownRepos={["/r"]}
      appearance={appearance}
      onAppearanceChange={onAppearanceChange}
      onNotificationsChange={() => {}}
      initialSection="appearance"
    />,
  );
  return onAppearanceChange;
}

afterEach(() => {
  cleanup();
  vi.mocked(ipc.writeAppearance).mockClear();
});

describe("settings sections", () => {
  it("keeps Chat and omits Distill, Harnesses, and a top-level Harness section", () => {
    expect(SECTIONS.map((section) => section.label)).toContain("Chat");
    expect(SECTIONS.map((section) => section.label)).not.toContain("Harness");
    expect(SECTIONS.map((section) => section.label)).not.toContain("Distill to Wiki");
    expect(SECTIONS.map((section) => section.label)).not.toContain("Harnesses");
    expect(SECTIONS.map((section) => section.label)).not.toContain("Sessions");
  });
});

describe("appearance mode cards", () => {
  it("applies the chosen mode to the document and persists it", async () => {
    document.documentElement.setAttribute("data-theme", "dark");
    const onAppearanceChange = renderAppearanceSection();

    const light = await screen.findByRole("button", { name: "Light" });
    fireEvent.click(light);

    // applyAppearance runs synchronously in the click handler.
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    await waitFor(() => expect(ipc.writeAppearance).toHaveBeenCalled());
    expect(vi.mocked(ipc.writeAppearance).mock.calls[0][0].mode).toBe("light");
    expect(onAppearanceChange).toHaveBeenCalled();
    const applied = onAppearanceChange.mock.calls[0][0] as AppearancePrefs;
    expect(applied.mode).toBe("light");
  });

  it("is enabled in the default global scope", async () => {
    renderAppearanceSection();
    for (const name of ["System", "Light", "Dark"]) {
      const card = await screen.findByRole("button", { name });
      expect((card as HTMLButtonElement).disabled).toBe(false);
    }
  });
});

describe("interface scale slider", () => {
  it("previews every step but writes once, on release", async () => {
    renderAppearanceSection();
    const slider = await screen.findByRole("slider", { name: "Interface scale" });

    fireEvent.change(slider, { target: { value: "1.125" } });
    fireEvent.change(slider, { target: { value: "1.25" } });

    expect(document.documentElement.style.getPropertyValue("--ui-scale")).toBe("1.25");
    expect(ipc.writeAppearance).not.toHaveBeenCalled();

    fireEvent.pointerUp(slider);

    await waitFor(() => expect(ipc.writeAppearance).toHaveBeenCalledTimes(1));
    expect(vi.mocked(ipc.writeAppearance).mock.calls[0][0].ui_scale).toBe(1.25);
  });

  it("commits on blur when no pointer or key event ever starts, e.g. an assistive-tech change", async () => {
    renderAppearanceSection();
    const slider = await screen.findByRole("slider", { name: "Interface scale" });

    fireEvent.change(slider, { target: { value: "1.25" } });
    expect(ipc.writeAppearance).not.toHaveBeenCalled();

    fireEvent.blur(slider);

    await waitFor(() => expect(ipc.writeAppearance).toHaveBeenCalledTimes(1));
    expect(vi.mocked(ipc.writeAppearance).mock.calls[0][0].ui_scale).toBe(1.25);
  });
});

describe("font size steppers", () => {
  it("steps by one and persists", async () => {
    renderAppearanceSection();

    fireEvent.click(await screen.findByRole("button", { name: "Increase terminal font size" }));

    await waitFor(() => expect(ipc.writeAppearance).toHaveBeenCalled());
    expect(vi.mocked(ipc.writeAppearance).mock.calls[0][0].terminal_font_size).toBe(DEFAULT_APPEARANCE.terminal_font_size + 1);
  });

  it("disables the button that would cross a bound", async () => {
    renderAppearanceSection(vi.fn(), { ...DEFAULT_APPEARANCE, terminal_font_size: TERMINAL_FONT_MIN, artifact_font_size: ARTIFACT_FONT_MAX });

    expect(((await screen.findByRole("button", { name: "Decrease terminal font size" })) as HTMLButtonElement).disabled).toBe(true);
    expect(((await screen.findByRole("button", { name: "Increase terminal font size" })) as HTMLButtonElement).disabled).toBe(false);
    expect(((await screen.findByRole("button", { name: "Increase artifact font size" })) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("artifact viewer width stepper", () => {
  it("steps by twenty and persists", async () => {
    renderAppearanceSection();

    fireEvent.click(await screen.findByRole("button", { name: "Increase artifact viewer width" }));

    await waitFor(() => expect(ipc.writeAppearance).toHaveBeenCalled());
    expect(vi.mocked(ipc.writeAppearance).mock.calls[0][0].artifact_viewer_width).toBe(ARTIFACT_VIEWER_WIDTH_DEFAULT + 20);
  });
});
