import type { Phase } from "./types";

export type KanbanColumn = { key: string; title: string; phaseKeys: string[] };
export const KANBAN_COLUMNS: KanbanColumn[] = [
  { key: "todo-draft", title: "Todo / Draft", phaseKeys: [""] },
  { key: "research-design", title: "Research & Design", phaseKeys: ["research-questions", "research", "design"] },
  { key: "planning", title: "Planning", phaseKeys: ["structure"] },
  { key: "implementation", title: "Implementation", phaseKeys: ["tdd", "implementation"] },
  { key: "in-review", title: "In Review", phaseKeys: ["review", "in-review"] },
];
export const DEFAULT_PHASE_TITLES: Record<string, string> = {
  "": "Draft",
  "research-questions": "Research Questions",
  research: "Research",
  design: "Design",
  structure: "Structure",
  tdd: "TDD",
  implementation: "Implementation",
  review: "Review",
  "in-review": "In Review",
};

export function kanbanColumnIndex(phase: string): number {
  return Math.max(
    0,
    KANBAN_COLUMNS.findIndex((col) => col.phaseKeys.includes(phase)),
  );
}

export function kanbanColumnKey(phase: string): string {
  return KANBAN_COLUMNS[kanbanColumnIndex(phase)]?.key ?? "todo-draft";
}

export function phaseLabel(phase: string, phases: Phase[] = []): string {
  return phases.find((p) => p.key === phase)?.title ?? DEFAULT_PHASE_TITLES[phase] ?? phase;
}
