import { describe, expect, it } from "vitest";
import {
  DEFAULT_GRID_VIEW_ID,
  gridViewShortcut,
  MAX_GRID_VIEWS,
  nextGridViewName,
  normalizeGridViews,
  resolveGridTopLevelRoute,
  trailingTabDigit,
  withGridViewSlots,
} from "./gridViews";

describe("Grid view definitions", () => {
  it("seeds exactly one Kanban+ view for missing or invalid settings", () => {
    expect(normalizeGridViews(undefined)).toEqual([{ id: DEFAULT_GRID_VIEW_ID, name: "Kanban+", slot: 1 }]);
    expect(normalizeGridViews([{ id: "", name: "  ", slot: 0 }])).toEqual([{ id: DEFAULT_GRID_VIEW_ID, name: "Kanban+", slot: 1 }]);
  });

  it("sorts explicit slots, trims labels, removes duplicates, and caps at three", () => {
    const normalized = normalizeGridViews([
      { id: "third", name: " Third ", slot: 3 },
      { id: "first", name: "First", slot: 1 },
      { id: "second", name: "Second", slot: 2 },
      { id: "fourth", name: "Fourth", slot: 4 },
      { id: "duplicate", name: "first", slot: 5 },
    ]);

    expect(normalized).toEqual([
      { id: "first", name: "First", slot: 1 },
      { id: "second", name: "Second", slot: 2 },
      { id: "third", name: "Third", slot: 3 },
    ]);
    expect(normalized).toHaveLength(MAX_GRID_VIEWS);
  });

  it("reassigns slots on reorder without changing IDs and chooses a neutral new label", () => {
    const views = [
      { id: "b", name: "Planning", slot: 2 },
      { id: "a", name: "Kanban+", slot: 1 },
    ];
    expect(withGridViewSlots(views)).toEqual([
      { id: "b", name: "Planning", slot: 1 },
      { id: "a", name: "Kanban+", slot: 2 },
    ]);
    expect(nextGridViewName(views)).toBe("Grid view 2");
  });

  it("numbers Grid views ⌘1 / ⌘2 / ⌘3, then Tasks, Sessions, and Kanban", () => {
    expect([0, 1, 2].map(gridViewShortcut)).toEqual(["⌘1", "⌘2", "⌘3"]);
    expect(trailingTabDigit(1, "tasks")).toBe(2);
    expect(trailingTabDigit(3, "tasks")).toBe(4);
    expect(trailingTabDigit(3, "sessions")).toBe(5);
    expect(trailingTabDigit(3, "kanban")).toBe(6);
  });

  it("falls back safely for hidden classic Kanban and stale Grid IDs", () => {
    const views = [{ id: "first", name: "First", slot: 1 }];
    expect(resolveGridTopLevelRoute({ kind: "kanban" }, false, views)).toEqual({ kind: "grid", gridViewId: "first" });
    expect(resolveGridTopLevelRoute({ kind: "grid", gridViewId: "deleted" }, true, views)).toEqual({ kind: "grid", gridViewId: "first" });
    expect(resolveGridTopLevelRoute({ kind: "grid", gridViewId: "first" }, false, views)).toEqual({ kind: "grid", gridViewId: "first" });
    expect(resolveGridTopLevelRoute({ kind: "kanban" }, true, views)).toEqual({ kind: "kanban" });
  });
});
