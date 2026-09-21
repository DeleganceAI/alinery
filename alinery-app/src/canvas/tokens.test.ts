import { afterEach, describe, expect, it, vi } from "vitest";
import { readCanvasTokens, truncateCached } from "./tokens";

describe("readCanvasTokens", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  // 3.41 — reads the role vars set as CSS custom properties on the element.
  it("reads the role vars", () => {
    const el = document.createElement("div");
    el.style.setProperty("--canvas", "#000104");
    el.style.setProperty("--surface", "#12141c");
    el.style.setProperty("--text", "#e6e8ef");
    el.style.setProperty("--text-strong", "#ffffff");
    el.style.setProperty("--text-muted", "#8a8fa3");
    el.style.setProperty("--accent", "#5ac8fa");
    el.style.setProperty("--border", "#2a2d3a");
    el.style.setProperty("--danger", "#ff453a");
    el.style.setProperty("--font-ui", "Inter");
    el.style.setProperty("--ui-scale", "1.25");
    document.body.appendChild(el);

    const tokens = readCanvasTokens(el);

    expect(tokens).toEqual({
      canvas: "#000104",
      surface: "#12141c",
      text: "#e6e8ef",
      textStrong: "#ffffff",
      textMuted: "#8a8fa3",
      accent: "#5ac8fa",
      border: "#2a2d3a",
      danger: "#ff453a",
      fontUi: "Inter",
      uiScale: 1.25,
    });
  });

  it("defaults uiScale to 1 when the property is absent", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);

    expect(readCanvasTokens(el).uiScale).toBe(1);
  });
});

describe("truncateCached", () => {
  // 3.42 — a repeat call with the same (text, maxWidth, fontKey) is a cache hit and does
  // not call measure again.
  it("cache hit does not remeasure", () => {
    const measure = vi.fn((s: string) => s.length * 10);

    const first = truncateCached("A very long task title that will not fit", 120, "ui-14", measure);
    const measureCallsAfterFirst = measure.mock.calls.length;
    const second = truncateCached("A very long task title that will not fit", 120, "ui-14", measure);

    expect(second).toBe(first);
    expect(measure.mock.calls.length).toBe(measureCallsAfterFirst);
  });

  it("a different fontKey is a cache miss", () => {
    const measure = vi.fn((s: string) => s.length * 10);

    truncateCached("A very long task title that will not fit", 120, "ui-14", measure);
    const measureCallsAfterFirst = measure.mock.calls.length;
    truncateCached("A very long task title that will not fit", 120, "ui-16", measure);

    expect(measure.mock.calls.length).toBeGreaterThan(measureCallsAfterFirst);
  });

  it("returns the text unchanged when it fits", () => {
    const measure = vi.fn(() => 10);

    expect(truncateCached("short", 100, "ui-fit", measure)).toBe("short");
  });

  it("truncates with an ellipsis when it does not fit", () => {
    const measure = vi.fn((s: string) => s.length);

    const result = truncateCached("abcdefghij", 5, "ui-trunc", measure);

    expect(result.endsWith("…")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(5);
  });
});
