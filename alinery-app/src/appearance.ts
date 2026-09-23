import type { AppearanceMode, AppearancePrefs, ChatMaxWidth, ChatRailDensity, SessionDefaultView } from "./types";

export const DEFAULT_ACCENT_COLOR = "#315bff";
export const ARTIFACT_VIEWER_WIDTH_DEFAULT = 360;
export const ARTIFACT_VIEWER_WIDTH_MIN = 260;
export const ARTIFACT_VIEWER_WIDTH_MAX = 2400;
export const ARTIFACT_VIEWER_MAX_SCREEN_FRACTION = 0.6;
export const SESSION_MESSAGE_TERMINAL_RESERVE = 120;

export const CHAT_FONT_DEFAULT = 14;
export const CHAT_FONT_MIN = 10;
export const CHAT_FONT_MAX = 22;
export const CHAT_RAIL_FONT_DEFAULT = 12;

export const DEFAULT_APPEARANCE: AppearancePrefs = {
  accent_color: DEFAULT_ACCENT_COLOR,
  ui_scale: 1,
  terminal_font_size: 13,
  artifact_font_size: 14,
  artifact_viewer_width: ARTIFACT_VIEWER_WIDTH_DEFAULT,
  chat_show_thinking: false,
  chat_expand_thinking: false,
  chat_show_tools: false,
  chat_expand_tools: false,
  chat_show_harness: true,
  chat_show_turn_markers: false,
  chat_show_subagent_rows: true,
  chat_show_subagent_drawer: true,
  chat_auto_collapse_thinking: true,
  chat_auto_compaction: true,
  chat_auto_scroll: true,
  chat_rail_density: "normal",
  chat_font_size: CHAT_FONT_DEFAULT,
  chat_rail_font_size: CHAT_RAIL_FONT_DEFAULT,
  chat_show_meta: true,
  chat_show_composer_hints: true,
  chat_max_width: "900",
  chat_show_date: true,
  chat_show_time: true,
  chat_show_actor_labels: true,
  chat_show_agent_bubbles: true,
  chat_show_block_copy_buttons: true,
  session_default_view: "chat",
  mode: "system",
};

export const UI_SCALE_STEPS = [0.75, 0.875, 1, 1.125, 1.25, 1.375, 1.5] as const;
export const TERMINAL_FONT_MIN = 8;
export const TERMINAL_FONT_MAX = 22;
export const ARTIFACT_FONT_MIN = 10;
export const ARTIFACT_FONT_MAX = 22;

export function normalizeArtifactViewerWidth(width: number | undefined): number {
  if (typeof width !== "number" || !Number.isFinite(width)) return ARTIFACT_VIEWER_WIDTH_DEFAULT;
  return Math.min(ARTIFACT_VIEWER_WIDTH_MAX, Math.max(ARTIFACT_VIEWER_WIDTH_MIN, Math.round(width)));
}
export function normalizeChatFontSize(size: number | undefined): number {
  if (typeof size !== "number" || !Number.isFinite(size)) return CHAT_FONT_DEFAULT;
  return Math.min(CHAT_FONT_MAX, Math.max(CHAT_FONT_MIN, Math.round(size)));
}
export function normalizeChatRailFontSize(size: number | undefined): number {
  if (typeof size !== "number" || !Number.isFinite(size)) return CHAT_RAIL_FONT_DEFAULT;
  return Math.min(CHAT_FONT_MAX, Math.max(CHAT_FONT_MIN, Math.round(size)));
}
export function normalizeChatRailDensity(value: string | undefined): ChatRailDensity {
  if (value === "dense" || value === "comfortable") return value;
  // Absent / "normal" / unknown → normal (product default).
  return "normal";
}
export function normalizeChatMaxWidth(value: string | undefined): ChatMaxWidth {
  if (value === "600" || value === "900" || value === "1200" || value === "none") return value;
  return "900";
}
export function normalizeSessionDefaultView(value: string | undefined): SessionDefaultView {
  return value === "terminal" ? "terminal" : "chat";
}
/** CSS max-width for the centered Chat column (`none` stays the keyword). */
export function chatMaxWidthCss(value: ChatMaxWidth): string {
  return value === "none" ? "none" : `${value}px`;
}
export function clampArtifactViewerWidth(width: number, screenWidth = typeof window === "undefined" ? Number.POSITIVE_INFINITY : window.innerWidth): number {
  const max = Math.min(ARTIFACT_VIEWER_WIDTH_MAX, Math.floor(screenWidth * ARTIFACT_VIEWER_MAX_SCREEN_FRACTION));
  return Math.max(ARTIFACT_VIEWER_WIDTH_MIN, Math.min(max, Math.round(width)));
}

export function artifactWidthFromAppearance(prefs: AppearancePrefs): number {
  return clampArtifactViewerWidth(normalizeArtifactViewerWidth(prefs.artifact_viewer_width));
}

function normalizeAccent(value: string | undefined): string {
  const accent = value?.trim();
  if (!accent || !/^#[0-9a-f]{6}$/i.test(accent)) return DEFAULT_ACCENT_COLOR;
  const normalized = accent.toLowerCase();
  return normalized;
}

export function normalizeAppearance(input: AppearancePrefs): AppearancePrefs {
  const raw = input ?? DEFAULT_APPEARANCE;
  const requestedScale = Number.isFinite(raw.ui_scale) ? raw.ui_scale : DEFAULT_APPEARANCE.ui_scale;
  let ui_scale: number = UI_SCALE_STEPS[0];
  for (const step of UI_SCALE_STEPS) {
    if (Math.abs(requestedScale - step) < Math.abs(requestedScale - ui_scale)) ui_scale = step;
  }
  const terminal_font_size = Number.isFinite(raw.terminal_font_size)
    ? Math.min(TERMINAL_FONT_MAX, Math.max(TERMINAL_FONT_MIN, Math.round(raw.terminal_font_size)))
    : DEFAULT_APPEARANCE.terminal_font_size;
  const artifact_font_size = Number.isFinite(raw.artifact_font_size)
    ? Math.min(ARTIFACT_FONT_MAX, Math.max(ARTIFACT_FONT_MIN, Math.round(raw.artifact_font_size)))
    : DEFAULT_APPEARANCE.artifact_font_size;
  const mode: AppearanceMode = raw.mode === "light" || raw.mode === "dark" ? raw.mode : "system";
  return {
    accent_color: normalizeAccent(raw.accent_color),
    ui_scale,
    terminal_font_size,
    artifact_font_size,
    artifact_viewer_width: normalizeArtifactViewerWidth(raw.artifact_viewer_width),
    chat_show_thinking: raw.chat_show_thinking === true,
    chat_expand_thinking: raw.chat_expand_thinking === true,
    chat_show_tools: raw.chat_show_tools === true,
    chat_expand_tools: raw.chat_expand_tools === true,
    chat_show_harness: raw.chat_show_harness !== false,
    chat_show_turn_markers: raw.chat_show_turn_markers === true,
    chat_show_subagent_rows: raw.chat_show_subagent_rows !== false,
    chat_show_subagent_drawer: raw.chat_show_subagent_drawer !== false,
    chat_auto_collapse_thinking: raw.chat_auto_collapse_thinking !== false,
    chat_auto_compaction: raw.chat_auto_compaction !== false,
    chat_auto_scroll: raw.chat_auto_scroll !== false,
    chat_rail_density: normalizeChatRailDensity(raw.chat_rail_density),
    chat_font_size: normalizeChatFontSize(raw.chat_font_size),
    chat_rail_font_size: normalizeChatRailFontSize(raw.chat_rail_font_size),
    chat_show_meta: raw.chat_show_meta !== false,
    chat_show_composer_hints: raw.chat_show_composer_hints !== false,
    chat_max_width: normalizeChatMaxWidth(raw.chat_max_width),
    chat_show_date: raw.chat_show_date !== false,
    chat_show_time: raw.chat_show_time !== false,
    chat_show_actor_labels: raw.chat_show_actor_labels !== false,
    chat_show_agent_bubbles: raw.chat_show_agent_bubbles !== false,
    chat_show_block_copy_buttons: raw.chat_show_block_copy_buttons !== false,
    session_default_view: normalizeSessionDefaultView(raw.session_default_view),
    mode,
  };
}

export function resolvedTheme(prefs: AppearancePrefs, systemDark: boolean): "light" | "dark" {
  if (prefs.mode === "light" || prefs.mode === "dark") return prefs.mode;
  return systemDark ? "dark" : "light";
}

type Rgb = [number, number, number];

function rgb(value: string): Rgb {
  const color = Number.parseInt(value.slice(1), 16);
  return [color >> 16, (color >> 8) & 255, color & 255];
}

function hex([red, green, blue]: Rgb): string {
  return `#${[red, green, blue].map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
}

function luminance(color: Rgb): number {
  const [red, green, blue] = color.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(a: Rgb, b: Rgb): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((left, right) => right - left);
  return (lighter + 0.05) / (darker + 0.05);
}

function mix(color: Rgb, target: number, amount: number): Rgb {
  return color.map((channel) => channel + (target - channel) * amount) as Rgb;
}

/** WCAG contrast ratio between two #rrggbb colors (1..21). */
export function contrastRatio(a: string, b: string): number {
  return contrast(rgb(a), rgb(b));
}

/* Every surface accent text/icons must stay readable on, worst case last.
   Keep in sync with --canvas/--surface/--surface-subtle in theme.css
   (appearance.test.ts parses theme.css and fails on drift). */
const ACCENT_SURFACES = {
  dark: ["#000104", "#08090b", "#1b1d21"],
  light: ["#fffefa", "#ffffff", "#f4f1ea"],
} as const;

export function accentTokens(base: string, theme: "light" | "dark") {
  const normalized = normalizeAccent(base);
  const original = rgb(normalized);
  const surfaces = ACCENT_SURFACES[theme].map(rgb);
  const target = theme === "dark" ? 255 : 0;
  const legible = (color: Rgb) => surfaces.every((surface) => contrast(color, surface) >= 4.5);
  // Judge every candidate after hex rounding — the float can pass 4.5 while the
  // shipped rounded hex lands at 4.49.
  let readable = rgb(hex(original));
  for (let step = 0; step <= 100 && !legible(readable); step += 1) {
    readable = rgb(hex(mix(original, target, step / 100)));
  }
  const onAccent = contrast(readable, rgb("#0a0a0a")) >= contrast(readable, rgb("#ffffff")) ? "#0a0a0a" : "#ffffff";
  return { base: normalized, readable: hex(readable), onAccent };
}

/** Dispatched only when assigned visual tokens change: data-theme, --accent-base, --accent, --accent-subtle, --on-accent, --ui-scale, --artifact-font-size. Not fired for artifact_viewer_width or terminal_font_size. */
export const APPEARANCE_EVENT = "alinery-appearance";

let systemMedia: MediaQueryList | null = null;
let lastApplied: AppearancePrefs | null = null;
let lastVisualTokens = "";

function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return true;
  systemMedia ??= window.matchMedia("(prefers-color-scheme: dark)");
  return systemMedia.matches;
}

function watchSystemTheme() {
  if (!systemMedia || (systemMedia as { alinery_watched?: boolean }).alinery_watched) return;
  (systemMedia as unknown as { alinery_watched: boolean }).alinery_watched = true;
  systemMedia.addEventListener("change", () => {
    if (lastApplied) applyAppearance(lastApplied);
  });
}

export function applyAppearance(input: AppearancePrefs): AppearancePrefs {
  const normalized = normalizeAppearance(input);
  const theme = resolvedTheme(normalized, systemPrefersDark());
  const accent = accentTokens(normalized.accent_color, theme);
  const el = document.documentElement;
  const assigned: string[] = [theme];
  const setVisual = (name: string, value: string) => {
    el.style.setProperty(name, value);
    assigned.push(value);
  };
  el.setAttribute("data-theme", theme);
  watchSystemTheme();
  setVisual("--accent-base", accent.base);
  setVisual("--accent", accent.readable);
  setVisual("--accent-subtle", `color-mix(in srgb, ${accent.base} ${theme === "dark" ? 24 : 12}%, transparent)`);
  setVisual("--on-accent", accent.onAccent);
  setVisual("--ui-scale", String(normalized.ui_scale));
  setVisual("--artifact-font-size", `${normalized.artifact_font_size}px`);
  setVisual("--chat-font-size", `${normalized.chat_font_size}px`);
  setVisual("--chat-rail-font-size", `${normalized.chat_rail_font_size}px`);
  lastApplied = normalized;
  const tokens = assigned.join("|");
  if (tokens !== lastVisualTokens) {
    lastVisualTokens = tokens;
    window.dispatchEvent(new Event(APPEARANCE_EVENT));
  }
  return normalized;
}
