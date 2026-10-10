import { useState } from "react";
import { DEFAULT_TASK_SESSION_SORT, PRIORITY_SESSION_SORT, type SessionSort } from "./sessionAttention";

const TASK_SESSION_SORT_KEY = "alinery.taskSessionSort";

type SessionSortControl = { sort: SessionSort; onChange: (sort: SessionSort) => void };

export function useSessionSort(control?: SessionSortControl, fallback: SessionSort = PRIORITY_SESSION_SORT): [SessionSort, (sort: SessionSort) => void] {
  const [localSort, setLocalSort] = useState<SessionSort>(fallback);
  return control ? [control.sort, control.onChange] : [localSort, setLocalSort];
}

/** Absent or unreadable storage is Updated descending. One install-wide value, not per task. */
export function readStoredTaskSessionSort(): SessionSort {
  try {
    const raw = localStorage.getItem(TASK_SESSION_SORT_KEY);
    if (raw === "priority") return PRIORITY_SESSION_SORT;
    const [field, direction] = raw?.split(":") ?? [];
    if ((field === "started" || field === "updated") && (direction === "desc" || direction === "asc")) return { field, direction };
    return DEFAULT_TASK_SESSION_SORT;
  } catch {
    return DEFAULT_TASK_SESSION_SORT;
  }
}

export function writeStoredTaskSessionSort(sort: SessionSort): void {
  try {
    localStorage.setItem(TASK_SESSION_SORT_KEY, sort.field === "priority" ? "priority" : `${sort.field}:${sort.direction}`);
  } catch {
    // A storage failure must not break sorting.
  }
}
