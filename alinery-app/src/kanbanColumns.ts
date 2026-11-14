// The board's columns. They are product configuration, not playbook data: the same four for every repository, so the page holds them
// (the shell's `list_kanban_columns` returned this list, S4.6).
import type { KanbanColumn } from "./types";

export const KANBAN_COLUMNS: KanbanColumn[] = [
  { key: "research-design", title: "Research & Design" },
  { key: "planning", title: "Planning" },
  { key: "implementation", title: "Implementation" },
  { key: "review", title: "Review" },
];
