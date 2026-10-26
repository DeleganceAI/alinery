import { normalizeGridViews } from "./gridViews";
import type { GlobalSettings, StartupView, View } from "./types";

const TABS = [
  { value: "list", label: "Task List" },
  { value: "sessions", label: "Sessions" },
  { value: "kanban", label: "Kanban" },
  { value: "chat", label: "Chat" },
  { value: "notifications", label: "Notifications" },
  { value: "playbooks", label: "Playbooks" },
  { value: "settings", label: "Settings" },
] as const;

export function normalizeStartupView(value: string | undefined): StartupView {
  const saved = value?.trim() ?? "";
  const tab = TABS.find((tab) => tab.value === saved);
  if (tab) return tab.value;
  if (saved.startsWith("grid:") && saved.slice(5).trim()) return saved as `grid:${string}`;
  return "list";
}

export function startupViewOptions(global?: Pick<GlobalSettings, "experiments" | "grid_views">): { value: StartupView; label: string; view: View }[] {
  return [
    ...TABS.filter(
      (tab) => (tab.value !== "kanban" || global?.experiments?.show_original_kanban !== false) && (tab.value !== "chat" || global?.experiments?.show_chat === true),
    ).map((tab) => ({ ...tab, view: { kind: tab.value } })),
    ...normalizeGridViews(global?.grid_views).map((grid) => ({ value: `grid:${grid.id}` as const, label: grid.name, view: { kind: "grid" as const, gridViewId: grid.id } })),
  ];
}

export function resolveStartupView(value: string | undefined, global?: Pick<GlobalSettings, "experiments" | "grid_views">): View {
  const saved = normalizeStartupView(value);
  return startupViewOptions(global).find((option) => option.value === saved)?.view ?? { kind: "list" };
}
