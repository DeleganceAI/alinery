import type { GridViewDefinition } from "./types";

export const MAX_GRID_VIEWS = 3;
export const ACTIVE_GRID_VIEW_STORAGE_KEY = "alinery:navigation:active-grid-view";
export const DEFAULT_GRID_VIEW_ID = "default-kanban-plus";
export const DEFAULT_GRID_VIEWS: readonly GridViewDefinition[] = [{ id: DEFAULT_GRID_VIEW_ID, name: "Kanban+", slot: 1 }];

export function normalizeGridViews(views: readonly GridViewDefinition[] | null | undefined): GridViewDefinition[] {
  const ids = new Set<string>();
  const names = new Set<string>();
  const normalized: GridViewDefinition[] = [];
  const candidates = [...(views ?? [])];
  const completeSlots = new Set(candidates.map((view) => view.slot)).size === candidates.length && candidates.every((view) => view.slot > 0 && view.slot <= candidates.length);
  if (completeSlots) candidates.sort((a, b) => a.slot - b.slot);

  for (const view of candidates) {
    const id = view.id.trim();
    const name = view.name.trim();
    const nameKey = name.toLowerCase();
    if (!id || !name || ids.has(id) || names.has(nameKey)) continue;
    ids.add(id);
    names.add(nameKey);
    normalized.push({ id, name, slot: normalized.length + 1 });
    if (normalized.length === MAX_GRID_VIEWS) break;
  }

  return normalized.length > 0 ? normalized : DEFAULT_GRID_VIEWS.map((view) => ({ ...view }));
}

/** Top-bar shortcut digits run left to right: Grid view 1 is ⌘1, view 2 is ⌘2, view 3 is ⌘3.
 *  Tasks, Sessions, and classic Kanban take the digits after the last Grid view
 *  (`trailingTabDigit`), and ⌘8 / ⌘9 stay Notifications and Settings. */
export function gridViewShortcutDigit(index: number): number {
  return index + 1;
}

/** The digit of a tab that follows the Grid views. `gridCount` is how many Grid views are shown;
 *  Chat comes last, so its digit moves up by one only while classic Kanban is on the bar. */
export function trailingTabDigit(gridCount: number, tab: "tasks" | "sessions" | "kanban" | "chat", showKanban = true): number {
  if (tab === "chat") return gridCount + (showKanban ? 4 : 3);
  return gridCount + { tasks: 1, sessions: 2, kanban: 3 }[tab];
}

export function gridViewShortcut(index: number): string {
  return `⌘${gridViewShortcutDigit(index)}`;
}

export function createGridViewId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return `grid-${crypto.randomUUID()}`;
  return `grid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function nextGridViewName(views: readonly GridViewDefinition[]): string {
  const names = new Set(views.map((view) => view.name.trim().toLowerCase()));
  for (let number = 2; ; number += 1) {
    const candidate = `Grid view ${number}`;
    if (!names.has(candidate.toLowerCase())) return candidate;
  }
}

export function withGridViewSlots(views: readonly GridViewDefinition[]): GridViewDefinition[] {
  return views.map((view, index) => ({ ...view, slot: index + 1 }));
}

type GridTopLevelRoute = { kind: "kanban" } | { kind: "grid"; gridViewId: string };

/** Grid is always available; classic Kanban is opt-in via `showOriginalKanban`. */
export function resolveGridTopLevelRoute(route: GridTopLevelRoute, showOriginalKanban: boolean, gridViews: readonly GridViewDefinition[]): GridTopLevelRoute {
  const firstGridViewId = gridViews[0]?.id ?? DEFAULT_GRID_VIEW_ID;
  if (route.kind === "grid") {
    if (gridViews.some((view) => view.id === route.gridViewId) === false) return { kind: "grid", gridViewId: firstGridViewId };
  }
  if (route.kind === "kanban" && showOriginalKanban === false) return { kind: "grid", gridViewId: firstGridViewId };
  return route;
}
