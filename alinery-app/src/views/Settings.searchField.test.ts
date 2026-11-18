import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "../appearance";

// The Settings search field paints its own background, so it must also name its text
// colour: without one the browser default (black) is what lands on the dark raised
// surface, and the query you type is invisible. This parses the rules that ship, so a
// token swap or a dropped `color` fails here instead of in someone's eyes.
const settingsCss = readFileSync("src/views/Settings.css", "utf8");
const themeCss = readFileSync("src/theme.css", "utf8");

function rule(css: string, selector: string, withText?: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const bodies = [...css.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "g"))].map((match) => match[1]);
  if (bodies.length === 0) throw new Error(`${selector} rule not found`);
  // A selector can appear more than once (a media query may set a width); the declaration
  // set is the one that carries the paint.
  const body = withText ? bodies.find((candidate) => candidate.includes(withText)) : bodies[bodies.length - 1];
  if (!body) throw new Error(`${selector} rule without ${withText} not found`);
  return body;
}

const lightStart = themeCss.indexOf(':root[data-theme="light"]');
const blocks = { dark: themeCss.slice(themeCss.indexOf(":root {"), lightStart), light: themeCss.slice(lightStart) };

function token(theme: "dark" | "light", name: string): string {
  const match = blocks[theme].match(new RegExp(`--${name}: (#[0-9a-f]{6});`));
  if (!match) throw new Error(`--${name} not found in ${theme} tokens`);
  return match[1];
}

describe("Settings search field", () => {
  const search = rule(settingsCss, ".settings-nav input.settings-search", "background:");

  it("names a text colour instead of inheriting the browser default", () => {
    expect(search).toMatch(/background:\s*var\(--surface-raised\);/);
    expect(search).toMatch(/color:\s*var\(--text\);/);
    expect(rule(settingsCss, ".settings-nav input.settings-search::placeholder")).toMatch(/color:\s*var\(--text-muted\);/);
  });

  it("keeps typed text and the placeholder readable on its own surface in both themes", () => {
    for (const theme of ["dark", "light"] as const) {
      const surface = token(theme, "surface-raised");
      expect(contrastRatio(token(theme, "text"), surface), `typed text (${theme})`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(token(theme, "text-muted"), surface), `placeholder (${theme})`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
