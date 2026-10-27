import { describe, expect, it } from "vitest";
import { DEFAULT_GRID_VIEW_ID } from "./gridViews";
import { resolveStartupView, startupViewOptions } from "./startupView";

describe("startup view", () => {
  it.each([undefined, "", "unknown", "grid:", "grid:deleted"])("opens Task List for missing or unavailable preference %s", (saved) => {
    expect(resolveStartupView(saved)).toEqual({ kind: "list" });
  });

  it("opens the configured canvas by ID after renaming or reordering it", () => {
    const global = {
      grid_views: [
        { id: "other", name: "Other", slot: 1 },
        { id: "work", name: "Renamed canvas", slot: 2 },
      ],
    };
    expect(resolveStartupView("grid:work", global)).toEqual({ kind: "grid", gridViewId: "work" });
    expect(startupViewOptions(global)).toContainEqual({ value: "grid:work", label: "Renamed canvas", view: { kind: "grid", gridViewId: "work" } });
    expect(resolveStartupView(`grid:${DEFAULT_GRID_VIEW_ID}`)).toEqual({ kind: "grid", gridViewId: DEFAULT_GRID_VIEW_ID });
  });

  it("only opens experimental tabs while enabled", () => {
    expect(resolveStartupView("chat")).toEqual({ kind: "list" });
    expect(resolveStartupView("chat", { experiments: { show_chat: true } })).toEqual({ kind: "chat" });
    expect(resolveStartupView("kanban")).toEqual({ kind: "kanban" });
    expect(resolveStartupView("kanban", { experiments: { show_original_kanban: false } })).toEqual({ kind: "list" });
  });

  it.each(["list", "sessions", "notifications", "playbooks", "settings"])("opens the selected %s view", (kind) => {
    expect(resolveStartupView(kind)).toEqual({ kind });
  });
});
