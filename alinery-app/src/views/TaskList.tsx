import { useEffect, useRef, useState } from "react";
import { type ArchiveTaskPhase, archiveBoardTask } from "../archiveTask";
import { ORB_STATE } from "../Indicators";
import * as ipc from "../ipc";
import {
  ArchiveTaskModal,
  Checkbox,
  EMPTY_TASK_ACTIVITY,
  EmptyState,
  formatAbsolute,
  formatAge,
  InlineStatus,
  LoadingState,
  repoName,
  sameBoardTasks,
  TaskActivityIndicators,
  taskKey,
  useBoardTaskActivity,
  useMinuteNow,
} from "../shared";
import type { BoardNav, BoardTask, TaskActivitySession, TaskActivitySummary } from "../types";

export type TaskListRow = {
  task: BoardTask;
  depth: number;
  parentHidden: boolean;
};

const taskNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const STATUS_ORDER = ["waiting_for_input", "waiting_for_approval", "failed", "running", "completed"] as const;
const TASK_COLUMNS = [
  { field: "name", label: "Name", className: "name-col", value: (task: BoardTask) => task.name },
  { field: "playbook", label: "Playbook", className: "", value: (task: BoardTask) => task.playbook_title || task.playbook || "Playbook" },
  { field: "active", label: "Active session", className: "", value: (_task: BoardTask, activity: TaskActivitySummary) => activity.active_session?.step_title ?? null },
  {
    field: "status",
    label: "Status",
    className: "status-col",
    value: (_task: BoardTask, activity: TaskActivitySummary) => (activity.status ? STATUS_ORDER.indexOf(activity.status) : null),
  },
  { field: "sessions", label: "Sessions", className: "num-col", value: (task: BoardTask) => task.session_count },
  { field: "created", label: "Created", className: "age-col", value: (task: BoardTask) => task.created },
  { field: "updated", label: "Updated", className: "age-col", value: (task: BoardTask) => task.updated || task.created },
] as const;
type TaskSort = { column: (typeof TASK_COLUMNS)[number]; direction: "asc" | "desc" };
const TASK_SORT_STORAGE_KEY = "alinery:task-list:sort";

function compareTaskRows(left: BoardTask, right: BoardTask): number {
  return left.created - right.created || left.repo_path.localeCompare(right.repo_path) || left.slug.localeCompare(right.slug);
}

function lineageKey(task: Pick<BoardTask, "repo_path" | "slug">): string {
  return `${task.repo_path}\u0000${task.slug}`;
}

export function flattenTaskRows(tasks: BoardTask[], compare = compareTaskRows): TaskListRow[] {
  const byKey = new Map(tasks.map((task) => [lineageKey(task), task]));
  const children = new Map<string, BoardTask[]>();
  for (const task of tasks) {
    if (!task.parent_task) continue;
    const parentKey = `${task.repo_path}\u0000${task.parent_task}`;
    const siblings = children.get(parentKey) ?? [];
    siblings.push(task);
    children.set(parentKey, siblings);
  }
  for (const siblings of children.values()) siblings.sort(compare);

  const rows: TaskListRow[] = [];
  const visited = new Set<string>();
  const append = (task: BoardTask, depth: number, parentHidden: boolean) => {
    const key = lineageKey(task);
    if (visited.has(key)) return;
    visited.add(key);
    rows.push({ task, depth, parentHidden });
    for (const child of children.get(key) ?? []) append(child, depth + 1, false);
  };
  const roots = tasks
    .filter((task) => !task.parent_task || !byKey.has(`${task.repo_path}\u0000${task.parent_task}`))
    .slice()
    .sort(compare);
  for (const root of roots) append(root, 0, Boolean(root.parent_task));
  for (const task of tasks.slice().sort(compare)) {
    if (!visited.has(lineageKey(task))) append(task, 0, Boolean(task.parent_task));
  }
  return rows;
}

type ErrState = { msg: string; detail: string } | null;
export function TaskList({
  allRepos,
  onOpen,
  onDuplicate,
  registerNav,
  onOpenActiveSession,
  onCreate,
}: {
  allRepos: boolean;
  onOpen: (task: BoardTask) => void;
  onDuplicate: (task: BoardTask) => void;
  registerNav: (n: BoardNav | null) => void;
  onOpenActiveSession: (task: BoardTask, session: TaskActivitySession) => void;
  onCreate: () => void;
}) {
  const [tasks, setTasks] = useState<BoardTask[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selectedKey, setSelectedKey] = useState("");
  const [err, setErr] = useState<ErrState>(null);
  const [pendingArchive, setPendingArchive] = useState<BoardTask | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [sort, setSort] = useState<TaskSort>(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(TASK_SORT_STORAGE_KEY) ?? "null");
      const column = TASK_COLUMNS.find((column) => column.field === saved?.field);
      if (column && (saved.direction === "asc" || saved.direction === "desc")) return { column, direction: saved.direction };
    } catch {
      // Invalid or unavailable storage must not prevent opening the task list.
    }
    return { column: TASK_COLUMNS[5], direction: "asc" };
  });
  const activity = useBoardTaskActivity(tasks);
  const now = useMinuteNow();
  // Sort roots and siblings, never separate children from their parent.
  const rows = flattenTaskRows(tasks, (left, right) => {
    const a = sort.column.value(left, activity[taskKey(left)] ?? EMPTY_TASK_ACTIVITY);
    const b = sort.column.value(right, activity[taskKey(right)] ?? EMPTY_TASK_ACTIVITY);
    // Tasks without activity stay last in either direction.
    if (a === null || b === null) return a === b ? compareTaskRows(left, right) : a === null ? 1 : -1;
    const compared = typeof a === "number" && typeof b === "number" ? a - b : taskNameCollator.compare(String(a), String(b));
    return (sort.direction === "asc" ? compared : -compared) || compareTaskRows(left, right);
  });
  const bodyRef = useRef<HTMLTableSectionElement | null>(null);

  const load = () =>
    ipc
      .listBoardTasks(allRepos)
      .then((ts) => {
        const visible = ts.filter((task) => showArchived || !task.archived);
        setTasks((current) => (sameBoardTasks(current, visible) ? current : visible));
        const flattened = flattenTaskRows(visible);
        setSelectedKey((previous) => (previous && flattened.some((row) => taskKey(row.task) === previous) ? previous : flattened[0] ? taskKey(flattened[0].task) : ""));
        setErr(null);
      })
      .catch((e) => setErr({ msg: "Couldn't load tasks.", detail: String(e) }))
      .finally(() => setLoaded(true));

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 3000);
    return () => window.clearInterval(timer);
  }, [allRepos, showArchived]);

  useEffect(() => {
    void import("../views/TaskDetail");
  }, []);

  const selectedIndex = rows.findIndex((row) => taskKey(row.task) === selectedKey);
  const selectedTask = selectedIndex >= 0 ? rows[selectedIndex].task : null;
  const empty = loaded && rows.length === 0;

  // Keyboard selection (j/k, arrows) must stay visible in long lists.
  useEffect(() => {
    bodyRef.current?.querySelector("tr.sel")?.scrollIntoView?.({ block: "nearest" });
  }, [selectedKey]);

  useEffect(() => {
    registerNav({
      moveRow: (d) =>
        setSelectedKey((prev) => {
          if (!rows.length) return "";
          const current = Math.max(
            0,
            rows.findIndex((row) => taskKey(row.task) === prev),
          );
          const next = Math.max(0, Math.min(current + d, rows.length - 1));
          return taskKey(rows[next].task);
        }),
      moveCol: () => {},
      openSelected: () => selectedTask && onOpen(selectedTask),
      duplicateSelected: () => selectedTask && onDuplicate(selectedTask),
      archiveSelected: () => {
        if (selectedTask) setPendingArchive(selectedTask);
      },
    });
    return () => registerNav(null);
  });

  const confirmArchive = async (removeWt: boolean, onPhase: (phase: ArchiveTaskPhase) => void) => {
    const pending = pendingArchive;
    if (!pending) return;
    const failure = await archiveBoardTask(pending, removeWt, onPhase);
    setPendingArchive(null);
    if (failure) {
      setErr(failure);
      return;
    }
    void load();
  };

  return (
    <div className="listwrap">
      <div className="listhead">
        <h1 className="view-title">Tasks</h1>
        {!empty && (
          <button type="button" className="btn small" onClick={onCreate}>
            New task
          </button>
        )}
        {!allRepos && <Checkbox checked={showArchived} onChange={setShowArchived} label="Show archived" />}
      </div>
      {err && (
        <InlineStatus tone="error" detail={err.detail}>
          {err.msg}
        </InlineStatus>
      )}
      {!loaded && <LoadingState label="Loading tasks" state={ORB_STATE} />}
      {empty ? (
        <div className="list list-empty">
          <EmptyState
            art
            title={showArchived ? "No tasks in this repository." : "No tasks yet."}
            hint={showArchived ? undefined : "A task owns one branch and worktree, and holds every agent session you run on it."}
            action={
              <button type="button" className="btn" onClick={onCreate}>
                New task
              </button>
            }
          />
        </div>
      ) : (
        <div className="list task-table-wrap">
          <table className="task-table sticky-head">
            <thead>
              <tr>
                {TASK_COLUMNS.map((column) => {
                  const { field, label, className } = column;
                  const active = sort.column === column;
                  const nextDirection = active ? (sort.direction === "asc" ? "desc" : "asc") : field === "created" || field === "updated" || field === "sessions" ? "desc" : "asc";
                  return (
                    <th key={field} scope="col" className={className} aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : undefined}>
                      <button
                        type="button"
                        className={`task-sort-header${active ? " active" : ""}`}
                        aria-label={`Sort by ${label}`}
                        title={`Sort ${label} ${nextDirection === "asc" ? "ascending" : "descending"}`}
                        onClick={() => {
                          setSort({ column, direction: nextDirection });
                          try {
                            window.localStorage.setItem(TASK_SORT_STORAGE_KEY, JSON.stringify({ field, direction: nextDirection }));
                          } catch {
                            // Sorting still works in memory when storage is unavailable.
                          }
                        }}
                      >
                        {label} <span aria-hidden="true">{active ? (sort.direction === "asc" ? "↑" : "↓") : "↕"}</span>
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody ref={bodyRef}>
              {rows.map(({ task: t, depth, parentHidden }, i) => {
                const updated = t.updated || t.created;
                const summary = activity[taskKey(t)] ?? EMPTY_TASK_ACTIVITY;
                const activeSession = summary.active_session;
                return (
                  <tr
                    key={taskKey(t)}
                    className={`${i === selectedIndex ? "sel" : ""}${t.archived ? " row-archived" : ""}`}
                    tabIndex={i === selectedIndex ? 0 : -1}
                    aria-current={i === selectedIndex || undefined}
                    onFocus={() => setSelectedKey(taskKey(t))}
                    onKeyDown={(e) => {
                      if (e.key === " ") {
                        e.preventDefault();
                        onOpen(t);
                      }
                    }}
                    onClick={() => {
                      setSelectedKey(taskKey(t));
                      onOpen(t);
                    }}
                  >
                    <td className={`task-name-cell${depth ? " nested" : ""}`} style={{ ["--task-depth" as string]: depth }}>
                      <span className="task-name-line" title={t.name}>
                        <span className="task-name-text">{t.name}</span>
                        {t.archived && <span className="pill task-archived">Archived</span>}
                        {t.draft && <span className="pill">Draft</span>}
                        {parentHidden && <span className="pill task-parent-hidden">Child of {t.parent_task}</span>}
                      </span>
                      <span className="task-subline">
                        {t.branch}
                        {allRepos ? ` · ${repoName(t.repo_path)}` : ""}
                      </span>
                    </td>
                    <td>
                      <span className="pill task-playbook">{t.playbook_title || t.playbook || "Playbook"}</span>
                    </td>
                    <td>
                      {activeSession ? (
                        <button
                          type="button"
                          className="badge res active-session-action"
                          onClick={(event) => {
                            event.stopPropagation();
                            onOpenActiveSession(t, activeSession);
                          }}
                        >
                          {activeSession.step_title}
                        </button>
                      ) : (
                        <span className="dim">—</span>
                      )}
                    </td>
                    <td className="status-col">
                      <TaskActivityIndicators activity={summary} />
                    </td>
                    <td className="num-col">{t.session_count}</td>
                    <td className="age-cell age-col" title={formatAbsolute(t.created)}>
                      {formatAge(t.created, now)}
                    </td>
                    <td className="age-cell age-col" title={formatAbsolute(updated)}>
                      {formatAge(updated, now)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <ArchiveTaskModal task={pendingArchive} onCancel={() => setPendingArchive(null)} onConfirm={confirmArchive} />
    </div>
  );
}
