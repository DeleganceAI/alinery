import { describe, expect, it } from "vitest";
import { applyTabPill, layoutTabPill, primaryTabOf } from "./tabMotion";
import type { View } from "./types";

describe("layoutTabPill", () => {
  it("places the pill under the active tab, relative to the nav", () => {
    expect(layoutTabPill(100, { left: 148, width: 72 })).toEqual({ x: 48, w: 72 });
  });

  it("returns null when there is no measurable active tab", () => {
    expect(layoutTabPill(0, null)).toBeNull();
    expect(layoutTabPill(0, { left: 10, width: 0 })).toBeNull();
  });
});

describe("applyTabPill", () => {
  it("writes pill coordinates as CSS variables and marks the nav ready", () => {
    const nav = document.createElement("nav");
    applyTabPill(nav, { x: 24, w: 80 });
    expect(nav.style.getPropertyValue("--pill-x")).toBe("24px");
    expect(nav.style.getPropertyValue("--pill-w")).toBe("80px");
    expect(nav.classList.contains("pill-ready")).toBe(true);
    expect(nav.classList.contains("instant")).toBe(false);
  });

  it("adds the instant class when the switch should not animate", () => {
    const nav = document.createElement("nav");
    applyTabPill(nav, { x: 0, w: 40 }, { instant: true });
    expect(nav.classList.contains("instant")).toBe(true);
  });

  it("clears a leftover instant class on an animated switch", () => {
    const nav = document.createElement("nav");
    applyTabPill(nav, { x: 0, w: 40 }, { instant: true });
    applyTabPill(nav, { x: 40, w: 40 });
    expect(nav.classList.contains("instant")).toBe(false);
  });
});

describe("primaryTabOf", () => {
  it("resolves a drill-down view to the tab it was opened from", () => {
    const task: View = { kind: "task", slug: "s", from: { kind: "list" } };
    expect(primaryTabOf(task)).toBe("list");
  });

  it("walks multiple nesting levels back to the owning primary tab", () => {
    const session: View = {
      kind: "session",
      id: "id",
      cwd: "/",
      taskSlug: "s",
      phase: "p",
      harness: "h",
      model: "m",
      generic: false,
      from: { kind: "task", slug: "s", from: { kind: "kanban" } },
    };
    expect(primaryTabOf(session)).toBe("kanban");
  });

  it("keeps nested sessions owned by Notifications", () => {
    const direct: View = {
      kind: "session",
      id: "id",
      cwd: "/",
      taskSlug: "s",
      phase: "p",
      harness: "h",
      model: "m",
      generic: false,
      from: { kind: "notifications" },
    };
    const nested: View = {
      ...direct,
      id: "nested",
      from: { kind: "task", slug: "s", from: { kind: "notifications" } },
    };
    expect(primaryTabOf(direct)).toBe("notifications");
    expect(primaryTabOf(nested)).toBe("notifications");
  });

  it("keeps a library-originated task owned by Playbooks", () => {
    expect(primaryTabOf({ kind: "task", slug: "s", from: { kind: "playbooks" } })).toBe("playbooks");
  });
});
