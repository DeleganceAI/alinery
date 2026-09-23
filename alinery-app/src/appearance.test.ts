import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  APPEARANCE_EVENT,
  ARTIFACT_FONT_MAX,
  ARTIFACT_FONT_MIN,
  ARTIFACT_VIEWER_MAX_SCREEN_FRACTION,
  ARTIFACT_VIEWER_WIDTH_DEFAULT,
  ARTIFACT_VIEWER_WIDTH_MAX,
  ARTIFACT_VIEWER_WIDTH_MIN,
  accentTokens,
  applyAppearance,
  clampArtifactViewerWidth,
  contrastRatio,
  DEFAULT_ACCENT_COLOR,
  DEFAULT_APPEARANCE,
  normalizeAppearance,
  resolvedTheme,
  TERMINAL_FONT_MAX,
  TERMINAL_FONT_MIN,
  UI_SCALE_STEPS,
} from "./appearance";
import type { AppearancePrefs } from "./types";

const prefs = (over: Partial<AppearancePrefs> = {}): AppearancePrefs => ({ ...DEFAULT_APPEARANCE, ...over });

describe("normalizeAppearance", () => {
  it("snaps ui_scale to the nearest allowed step", () => {
    expect(normalizeAppearance(prefs({ ui_scale: 1.1 })).ui_scale).toBe(1.125);
    expect(normalizeAppearance(prefs({ ui_scale: 0.9 })).ui_scale).toBe(0.875);
    expect(normalizeAppearance(prefs({ ui_scale: 999 })).ui_scale).toBe(UI_SCALE_STEPS[UI_SCALE_STEPS.length - 1]);
    expect(normalizeAppearance(prefs({ ui_scale: -5 })).ui_scale).toBe(UI_SCALE_STEPS[0]);
  });

  it("leaves an exact scale step alone", () => {
    for (const step of UI_SCALE_STEPS) expect(normalizeAppearance(prefs({ ui_scale: step })).ui_scale).toBe(step);
  });

  it("clamps font sizes into range and rounds them", () => {
    expect(normalizeAppearance(prefs({ terminal_font_size: 2 })).terminal_font_size).toBe(TERMINAL_FONT_MIN);
    expect(normalizeAppearance(prefs({ terminal_font_size: 999 })).terminal_font_size).toBe(TERMINAL_FONT_MAX);
    expect(normalizeAppearance(prefs({ terminal_font_size: 12.6 })).terminal_font_size).toBe(13);
    expect(normalizeAppearance(prefs({ artifact_font_size: 0 })).artifact_font_size).toBe(ARTIFACT_FONT_MIN);
    expect(normalizeAppearance(prefs({ artifact_font_size: 500 })).artifact_font_size).toBe(ARTIFACT_FONT_MAX);
  });

  it("clamps artifact viewer width into range and rounds it", () => {
    expect(normalizeAppearance(prefs({ artifact_viewer_width: 100 })).artifact_viewer_width).toBe(ARTIFACT_VIEWER_WIDTH_MIN);
    expect(normalizeAppearance(prefs({ artifact_viewer_width: 9999 })).artifact_viewer_width).toBe(ARTIFACT_VIEWER_WIDTH_MAX);
    expect(normalizeAppearance(prefs({ artifact_viewer_width: 480.6 })).artifact_viewer_width).toBe(481);
  });

  it("falls back to defaults for non-finite numbers", () => {
    expect(normalizeAppearance(prefs({ ui_scale: Number.NaN })).ui_scale).toBe(DEFAULT_APPEARANCE.ui_scale);
    expect(normalizeAppearance(prefs({ terminal_font_size: Number.NaN })).terminal_font_size).toBe(DEFAULT_APPEARANCE.terminal_font_size);
    expect(normalizeAppearance(prefs({ artifact_font_size: Number.POSITIVE_INFINITY })).artifact_font_size).toBe(DEFAULT_APPEARANCE.artifact_font_size);
    expect(normalizeAppearance(prefs({ artifact_viewer_width: Number.NaN })).artifact_viewer_width).toBe(ARTIFACT_VIEWER_WIDTH_DEFAULT);
    expect(normalizeAppearance({ ...prefs(), artifact_viewer_width: undefined }).artifact_viewer_width).toBe(ARTIFACT_VIEWER_WIDTH_DEFAULT);
  });

  it("normalizes a valid accent and rejects invalid values", () => {
    expect(normalizeAppearance(prefs({ accent_color: "  #5566BF " })).accent_color).toBe("#5566bf");
    expect(normalizeAppearance(prefs({ accent_color: "blue" })).accent_color).toBe(DEFAULT_APPEARANCE.accent_color);
  });

  it("preserves valid custom accent colors", () => {
    expect(normalizeAppearance(prefs({ accent_color: "#38459D" })).accent_color).toBe("#38459d");
    expect(normalizeAppearance(prefs({ accent_color: "#5566BF" })).accent_color).toBe("#5566bf");
  });

  it("drops legacy preset colors instead of reviving a third theme", () => {
    const legacy = { ...prefs({ mode: "light" }), colors: { primary: "#ff00ff" } } as AppearancePrefs;
    expect(normalizeAppearance(legacy)).toEqual(prefs({ mode: "light" }));
    expect(normalizeAppearance(legacy)).not.toHaveProperty("colors");
  });

  it("is idempotent", () => {
    const once = normalizeAppearance(prefs({ ui_scale: 1.1, terminal_font_size: 99 }));
    expect(normalizeAppearance(once)).toEqual(once);
  });
});

describe("clampArtifactViewerWidth", () => {
  it("keeps the default inside a typical window", () => {
    expect(clampArtifactViewerWidth(ARTIFACT_VIEWER_WIDTH_DEFAULT, 1440)).toBe(ARTIFACT_VIEWER_WIDTH_DEFAULT);
  });

  it("caps at 60 percent of the window", () => {
    expect(clampArtifactViewerWidth(800, 1000)).toBe(600);
  });

  it("never goes below the minimum pane width", () => {
    expect(clampArtifactViewerWidth(10, 1440)).toBe(ARTIFACT_VIEWER_WIDTH_MIN);
  });

  it("does not apply a viewport cap when no screen width is known", () => {
    expect(clampArtifactViewerWidth(ARTIFACT_VIEWER_WIDTH_MAX, Number.POSITIVE_INFINITY)).toBe(ARTIFACT_VIEWER_WIDTH_MAX);
  });
});

describe("artifact pane CSS tokens", () => {
  const css = readFileSync("src/theme.css", "utf8");
  const root = css.slice(css.indexOf(":root {"), css.indexOf(':root[data-theme="light"]'));
  const token = (name: string): string => {
    const match = root.match(new RegExp(`--${name}: ([^;]+);`));
    if (!match) throw new Error(`--${name} not found in :root`);
    return match[1].trim();
  };

  it("matches the JS min width and screen fraction", () => {
    expect(token("artifact-pane-min")).toBe(`${ARTIFACT_VIEWER_WIDTH_MIN}px`);
    expect(token("artifact-pane-max-fraction")).toBe(`${ARTIFACT_VIEWER_MAX_SCREEN_FRACTION * 100}vw`);
  });
});

describe("applyAppearance", () => {
  beforeEach(() => {
    applyAppearance({ ...DEFAULT_APPEARANCE, mode: "dark" });
  });

  it("does not dispatch when only artifact viewer width changes", () => {
    const spy = vi.spyOn(window, "dispatchEvent");
    applyAppearance({ ...DEFAULT_APPEARANCE, mode: "dark", artifact_viewer_width: 480 });
    expect(spy.mock.calls.filter(([ev]) => ev instanceof Event && ev.type === APPEARANCE_EVENT)).toHaveLength(0);
    spy.mockRestore();
  });

  it("dispatches when theme tokens change", () => {
    const spy = vi.spyOn(window, "dispatchEvent");
    applyAppearance({ ...DEFAULT_APPEARANCE, mode: "light" });
    expect(spy.mock.calls.filter(([ev]) => ev instanceof Event && ev.type === APPEARANCE_EVENT).length).toBeGreaterThan(0);
    spy.mockRestore();
  });

  it("dispatches when only the accent changes", () => {
    const spy = vi.spyOn(window, "dispatchEvent");
    applyAppearance({ ...DEFAULT_APPEARANCE, mode: "dark", accent_color: "#e11d48" });
    expect(spy.mock.calls.filter(([ev]) => ev instanceof Event && ev.type === APPEARANCE_EVENT).length).toBeGreaterThan(0);
    spy.mockRestore();
  });

  it("dispatches when only artifact font size changes", () => {
    const spy = vi.spyOn(window, "dispatchEvent");
    applyAppearance({ ...DEFAULT_APPEARANCE, mode: "dark", artifact_font_size: 16 });
    expect(spy.mock.calls.filter(([ev]) => ev instanceof Event && ev.type === APPEARANCE_EVENT).length).toBeGreaterThan(0);
    spy.mockRestore();
  });

  it("clamps chat font size and normalizes rail density", () => {
    expect(normalizeAppearance(prefs({ chat_font_size: 9 })).chat_font_size).toBe(10);
    expect(normalizeAppearance(prefs({ chat_font_size: 30 })).chat_font_size).toBe(22);
    expect(normalizeAppearance(prefs({ chat_rail_density: "dense" })).chat_rail_density).toBe("dense");
    expect(normalizeAppearance(prefs({ chat_rail_density: "normal" })).chat_rail_density).toBe("normal");
    expect(normalizeAppearance(prefs({ chat_rail_density: "comfortable" })).chat_rail_density).toBe("comfortable");
    expect(normalizeAppearance({ ...prefs(), chat_rail_density: "compact" as AppearancePrefs["chat_rail_density"] }).chat_rail_density).toBe("normal");
    expect(normalizeAppearance({ ...prefs(), chat_rail_density: "loud" as AppearancePrefs["chat_rail_density"] }).chat_rail_density).toBe("normal");
    expect(normalizeAppearance(prefs({ chat_rail_font_size: 9 })).chat_rail_font_size).toBe(10);
    expect(normalizeAppearance({ ...prefs(), chat_show_actor_labels: true, chat_show_agent_bubbles: true, chat_show_copy_buttons: true })).toMatchObject({
      chat_show_actor_labels: true,
      chat_show_agent_bubbles: true,
      chat_show_copy_buttons: true,
    });
    expect(normalizeAppearance({ ...prefs(), chat_show_actor_labels: undefined, chat_show_agent_bubbles: undefined, chat_show_copy_buttons: undefined })).toMatchObject({
      chat_show_actor_labels: true,
      chat_show_agent_bubbles: true,
      chat_show_copy_buttons: true,
    });
  });

  it("defaults requested journal chrome on when keys are absent", () => {
    expect(
      normalizeAppearance({
        ...prefs(),
        chat_show_thinking: undefined,
        chat_show_tools: undefined,
        chat_show_turn_markers: undefined,
        chat_show_subagent_rows: undefined,
        chat_show_date: undefined,
        chat_show_time: undefined,
      } as AppearancePrefs),
    ).toMatchObject({
      chat_show_thinking: false,
      chat_show_tools: false,
      chat_show_turn_markers: false,
      chat_show_subagent_rows: true,
      chat_show_date: true,
      chat_show_time: true,
      chat_show_harness: true,
      chat_show_subagent_drawer: true,
      chat_rail_density: "normal",
    });
  });

  it("normalizes chat max width and stamp toggles", () => {
    expect(normalizeAppearance(prefs({ chat_max_width: "600" })).chat_max_width).toBe("600");
    expect(normalizeAppearance(prefs({ chat_max_width: "none" })).chat_max_width).toBe("none");
    expect(normalizeAppearance({ ...prefs(), chat_max_width: "loud" as AppearancePrefs["chat_max_width"] }).chat_max_width).toBe("900");
    expect(normalizeAppearance(prefs({ chat_show_date: false, chat_show_time: false }))).toMatchObject({ chat_show_date: false, chat_show_time: false });
    expect(normalizeAppearance({ ...prefs(), chat_show_date: undefined, chat_show_time: undefined })).toMatchObject({ chat_show_date: true, chat_show_time: true });
    expect(normalizeAppearance(prefs({ chat_show_date: true, chat_show_time: true }))).toMatchObject({ chat_show_date: true, chat_show_time: true });
  });

  it("defaults session view to chat", () => {
    expect(normalizeAppearance(prefs()).session_default_view).toBe("chat");
    expect(normalizeAppearance(prefs({ session_default_view: "terminal" })).session_default_view).toBe("terminal");
    expect(normalizeAppearance({ ...prefs(), session_default_view: "loud" as AppearancePrefs["session_default_view"] }).session_default_view).toBe("chat");
  });

  it("does not dispatch when only terminal font size changes", () => {
    const spy = vi.spyOn(window, "dispatchEvent");
    applyAppearance({ ...DEFAULT_APPEARANCE, mode: "dark", terminal_font_size: 18 });
    expect(spy.mock.calls.filter(([ev]) => ev instanceof Event && ev.type === APPEARANCE_EVENT)).toHaveLength(0);
    spy.mockRestore();
  });
});

describe("accentTokens", () => {
  it("keeps the royal blue base while making it readable in both themes", () => {
    expect(accentTokens(DEFAULT_ACCENT_COLOR, "dark")).toEqual({ base: "#315bff", readable: "#587aff", onAccent: "#0a0a0a" });
    expect(accentTokens(DEFAULT_ACCENT_COLOR, "light")).toEqual({ base: "#315bff", readable: "#315bff", onAccent: "#ffffff" });
  });

  it("darkens a pale custom accent for light surfaces", () => {
    expect(accentTokens("#ffff00", "light").readable).not.toBe("#ffff00");
  });
});

describe("contrast (WCAG AA)", () => {
  // Assert real ratios against the tokens theme.css actually ships; parsing the
  // file keeps appearance.ts's surface list and theme.css from drifting apart.
  // cwd-relative: jsdom rewrites import.meta.url to an http URL
  const css = readFileSync("src/theme.css", "utf8");
  const lightStart = css.indexOf(':root[data-theme="light"]');
  const blocks = {
    dark: css.slice(css.indexOf(":root {"), lightStart),
    light: css.slice(lightStart, css.indexOf("}", lightStart)),
  };
  const themes = ["dark", "light"] as const;
  const surfaces = ["canvas", "surface", "surface-subtle"] as const;
  const token = (theme: (typeof themes)[number], name: string): string => {
    const match = blocks[theme].match(new RegExp(`--${name}: (#[0-9a-f]{6});`));
    if (!match) throw new Error(`--${name} not found in ${theme} tokens`);
    return match[1];
  };
  const rule = (selector: string): string => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
    if (!match) throw new Error(`${selector} rule not found`);
    return match[1];
  };

  it("anchors the contrast helper to known ratios", () => {
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#808080", "#808080")).toBe(1);
  });

  it("derives accents readable on every surface, with a readable label on solid accent", () => {
    for (const theme of themes) {
      for (const base of [DEFAULT_ACCENT_COLOR, "#808080", "#ffff00", "#7c3aed", "#e11d48"]) {
        const { readable, onAccent } = accentTokens(base, theme);
        for (const surface of surfaces) {
          expect(contrastRatio(readable, token(theme, surface)), `${base} (${theme}) vs --${surface}`).toBeGreaterThanOrEqual(4.5);
        }
        expect(contrastRatio(onAccent, readable), `on-accent for ${base} (${theme})`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps the static --accent/--on-accent tokens AA on every surface", () => {
    for (const theme of themes) {
      const accent = token(theme, "accent");
      for (const surface of surfaces) {
        expect(contrastRatio(accent, token(theme, surface)), `--accent (${theme}) vs --${surface}`).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrastRatio(token(theme, "on-accent"), accent), `--on-accent (${theme})`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps --text-faint AA on hover and inset surfaces", () => {
    for (const theme of themes) {
      for (const surface of surfaces) {
        expect(contrastRatio(token(theme, "text-faint"), token(theme, surface)), `--text-faint (${theme}) vs --${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps standard, danger, and focus roles visible on the app surface", () => {
    for (const theme of themes) {
      const surface = token(theme, "surface");
      const accent = token(theme, "accent");
      const danger = token(theme, "danger");
      const dangerHoverLabel = theme === "light" ? "#ffffff" : token(theme, "on-accent");

      expect(contrastRatio(token(theme, "on-accent"), accent), `standard label (${theme})`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(accent, surface), `standard boundary (${theme})`).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(danger, surface), `danger label and boundary (${theme})`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(dangerHoverLabel, danger), `danger hover label (${theme})`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(accent, surface), `focus indicator (${theme})`).toBeGreaterThanOrEqual(3);
    }
  });

  it("themes the terminal from the resolved appearance with readable default text", () => {
    for (const theme of themes) {
      const background = token(theme, "terminal-bg");
      const foreground = token(theme, "terminal-fg");

      expect(background, `terminal background (${theme})`).toBe(token(theme, "canvas"));
      expect(foreground, `terminal foreground (${theme})`).toBe(token(theme, "text"));
      expect(contrastRatio(foreground, background), `terminal text (${theme})`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("separates app-surface drawer chrome from the terminal canvas", () => {
    expect(rule(".terminal-drawer")).toMatch(/background:\s*var\(--terminal-bg\);/);
    expect(rule(".terminal-drawer-chrome")).toMatch(/background:\s*var\(--surface\);/);
  });
});

describe("resolvedTheme", () => {
  it("follows the OS in system mode", () => {
    expect(resolvedTheme(prefs({ mode: "system" }), true)).toBe("dark");
    expect(resolvedTheme(prefs({ mode: "system" }), false)).toBe("light");
  });

  it("lets explicit Light and Dark override the OS", () => {
    expect(resolvedTheme(prefs({ mode: "light" }), true)).toBe("light");
    expect(resolvedTheme(prefs({ mode: "dark" }), false)).toBe("dark");
  });

  it("treats a missing or unknown mode as System", () => {
    expect(normalizeAppearance({ ...prefs(), mode: undefined }).mode).toBe("system");
    expect(normalizeAppearance({ ...prefs(), mode: "neon" as AppearancePrefs["mode"] }).mode).toBe("system");
  });
});
