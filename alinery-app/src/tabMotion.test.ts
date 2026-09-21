import { describe, expect, it } from "vitest";
import { applyTabPill, gridViewIdOf, isPrimaryTab, layoutTabPill, primaryTabOf, viewFadeClass } from "./tabMotion";
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

describe("viewFadeClass", () => {
  it("fades on pointer tab switches and snaps when instant", () => {
    expect(viewFadeClass(false)).toBe("view-fade");
    expect(viewFadeClass(true)).toBe("view-fade instant");
  });
});

describe("isPrimaryTab", () => {
  it("only treats the top-level views as tab pages", () => {
    expect(isPrimaryTab("kanban")).toBe(true);
    expect(isPrimaryTab("grid")).toBe(true);
    expect(isPrimaryTab("notifications")).toBe(true);
    expect(isPrimaryTab("settings")).toBe(true);
    expect(isPrimaryTab("wiki")).toBe(false);
    expect(isPrimaryTab("task")).toBe(false);
    expect(isPrimaryTab("session")).toBe(false);
  });
});

describe("primaryTabOf", () => {
  it("returns a primary view's own kind", () => {
    expect(primaryTabOf({ kind: "kanban" })).toBe("kanban");
    expect(primaryTabOf({ kind: "grid", gridViewId: "view-a" })).toBe("grid");
    expect(primaryTabOf({ kind: "notifications" })).toBe("notifications");
  });

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

  // Orbitron carries no `from`: the chord opens it from anywhere and it owns no tab. Walking
  // off the end of the chain threw inside App's render, so the whole window went blank the
  // moment the view opened — a crash, not a layout bug. Grid is the product default here.
  it("parks on the default tab for a view that nests back to nothing", () => {
    expect(primaryTabOf({ kind: "canvas" })).toBe("grid");
  });

  it("does not throw when gridViewIdOf walks a view with no from", () => {
    expect(gridViewIdOf({ kind: "canvas" })).toBeUndefined();
  });
});
