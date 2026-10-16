import { useEffect, useRef, useState } from "react";
import { type ArchiveTaskPhase, archiveBoardTask } from "../archiveTask";
import { ORB_STATE } from "../Indicators";
import * as ipc from "../ipc";
import { ListToolbar } from "../ListToolbar";
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
import type { BoardNav, BoardTask, TaskActivitySession, TaskActivityStatus, TaskActivitySummary } from "../types";
import "./TaskList.css";

export type TaskListRow = {
  task: BoardTask;
  depth: number;
  parentHidden: boolean;
};

const taskNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const STATUS_ORDER = ["waiting_for_input", "waiting_for_approval", "failed", "running", "completed"] as const;
// Filter wording matches the accessible names TaskActivityIndicators gives each status icon.
const STATUS_LABELS: Record<TaskActivityStatus, string> = {
  waiting_for_input: "Needs input",
  waiting_for_approval: "Needs approval",
  failed: "Failed",
  running: "Running",
  completed: "Completed",
};
const NO_ACTIVITY = "none";
const playbookLabel = (task: BoardTask) => task.playbook_title || task.playbook || "Playbook";
const TASK_COLUMNS = [
  { field: "name", label: "Name", className: "task-col-name name-col", value: (task: BoardTask) => task.name },
  {
    field: "status",
    label: "Status",
    className: "task-col-status status-col",
    value: (_task: BoardTask, activity: TaskActivitySummary) => (activity.status ? STATUS_ORDER.indexOf(activity.status) : null),
  },
  {
    field: "active",
    label: "Active session",
    className: "task-col-active",
    value: (_task: BoardTask, activity: TaskActivitySummary) => activity.active_session?.step_title ?? null,
  },
  { field: "playbook", label: "Playbook", className: "task-col-playbook", value: playbookLabel },
  { field: "sessions", label: "Sessions", className: "task-col-sessions num-col", value: (task: BoardTask) => task.session_count },
  { field: "created", label: "Created", className: "task-col-created age-col", value: (task: BoardTask) => task.created },
  { field: "updated", label: "Updated", className: "task-col-updated age-col", value: (task: BoardTask) => task.updated || task.created },
] as const;
type TaskColumn = (typeof TASK_COLUMNS)[number];
type SortDirection = "asc" | "desc";
type TaskSort = { column: TaskColumn; direction: SortDirection };
const TASK_SORT_STORAGE_KEY = "alinery:task-list:sort";
const firstSortDirection = (field: TaskColumn["field"]): SortDirection => (field === "created" || field === "updated" || field === "sessions" ? "desc" : "asc");

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
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [playbookFilter, setPlaybookFilter] = useState("");
  const [sort, setSort] = useState<TaskSort>(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(TASK_SORT_STORAGE_KEY) ?? "null");
      const column = TASK_COLUMNS.find((column) => column.field === saved?.field);
      if (column && (saved.direction === "asc" || saved.direction === "desc")) return { column, direction: saved.direction };
    } catch {
      // Invalid or unavailable storage must not prevent opening the task list.
    }
    return { column: TASK_COLUMNS[6], direction: "desc" };
  });
  const activity = useBoardTaskActivity(tasks);
  const now = useMinuteNow();
  const summaryOf = (task: BoardTask) => activity[taskKey(task)] ?? EMPTY_TASK_ACTIVITY;

  // Filters narrow the fetched rows only; polling replaces `tasks` and the filters re-apply.
  const filtered = query.trim() !== "" || statusFilter !== "" || playbookFilter !== "";
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const visibleTasks = filtered
    ? tasks.filter((task) => {
        if (statusFilter) {
          const observed = activity[taskKey(task)];
          if (!observed || (observed.status ?? NO_ACTIVITY) !== statusFilter) return false;
        }
        if (playbookFilter && playbookLabel(task) !== playbookFilter) return false;
        const haystack = [task.name, task.branch, repoName(task.repo_path), task.playbook_title, task.playbook].join("\n").toLowerCase();
        return terms.every((term) => haystack.includes(term));
      })
    : tasks;
  // Keep a chosen playbook listed even after its last task leaves, so the select never shows a value it lacks.
  const playbookOptions = [...new Set([...tasks.map(playbookLabel), ...(playbookFilter ? [playbookFilter] : [])])].sort(taskNameCollator.compare);
  const taskNames = new Map(tasks.map((task) => [lineageKey(task), task.name]));
  const resetFilters = () => {
    setQuery("");
    setStatusFilter("");
    setPlaybookFilter("");
  };

  // Sort roots and siblings, never separate children from their parent. A child whose parent is
  // filtered out becomes a root and carries an explicit hint instead of borrowing a hidden row.
  const rows = flattenTaskRows(visibleTasks, (left, right) => {
    const a = sort.column.value(left, summaryOf(left));
    const b = sort.column.value(right, summaryOf(right));
    // Tasks without activity stay last in either direction.
    if (a === null || b === null) return a === b ? compareTaskRows(left, right) : a === null ? 1 : -1;
    const compared = typeof a === "number" && typeof b === "number" ? a - b : taskNameCollator.compare(String(a), String(b));
    return (sort.direction === "asc" ? compared : -compared) || compareTaskRows(left, right);
  });
  const chooseSort = (column: TaskColumn, direction: SortDirection) => {
    setSort({ column, direction });
    try {
      window.localStorage.setItem(TASK_SORT_STORAGE_KEY, JSON.stringify({ field: column.field, direction }));
    } catch {
      // Sorting still works in memory when storage is unavailable.
    }
  };
  const bodyRef = useRef<HTMLTableSectionElement | null>(null);

  const load = () =>
    ipc
      .listBoardTasks(allRepos)
      .then((ts) => {
        const visible = ts.filter((task) => showArchived || !task.archived);
        setTasks((current) => (sameBoardTasks(current, visible) ? current : visible));
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

  // Selection only ever names a visible row: when filters or a poll remove it, the first visible
  // row takes over, so open/duplicate/archive can never reach a task the user cannot see.
  const keptIndex = rows.findIndex((row) => taskKey(row.task) === selectedKey);
  const selectedIndex = keptIndex >= 0 ? keptIndex : rows.length ? 0 : -1;
  const selectedTask = selectedIndex >= 0 ? rows[selectedIndex].task : null;
  const visibleSelectedKey = selectedTask ? taskKey(selectedTask) : "";
  useEffect(() => {
    if (visibleSelectedKey && visibleSelectedKey !== selectedKey) setSelectedKey(visibleSelectedKey);
  }, [visibleSelectedKey, selectedKey]);
  const empty = loaded && tasks.length === 0;
  const noMatches = loaded && !empty && rows.length === 0;

  // Keyboard selection (j/k, arrows) must stay visible in long lists.
  useEffect(() => {
    bodyRef.current?.querySelector("tr.sel")?.scrollIntoView?.({ block: "nearest" });
  }, [visibleSelectedKey]);

  useEffect(() => {
    registerNav({
      moveRow: (d) =>
        setSelectedKey((prev) => {
          if (!rows.length) return prev;
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

  const heading = (
    <>
      <h1 className="view-title">Tasks</h1>
      {!empty && (
        <button type="button" className="btn small" onClick={onCreate}>
          New task
        </button>
      )}
    </>
  );

  return (
    <section className="listwrap collection-view task-list-view">
      {loaded && (!empty || filtered) ? (
        <ListToolbar
          label="Tasks"
          heading={heading}
          query={query}
          onQueryChange={setQuery}
          shown={visibleTasks.length}
          total={tasks.length}
          filtered={filtered}
          onReset={resetFilters}
        >
          <label>
            <span>Status</span>
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.currentTarget.value)}>
              <option value="">All statuses</option>
              {STATUS_ORDER.map((status) => (
                <option key={status} value={status}>
                  {STATUS_LABELS[status]}
                </option>
              ))}
              <option value={NO_ACTIVITY}>No activity</option>
            </select>
          </label>
          <label>
            <span>Playbook</span>
            <select value={playbookFilter} onChange={(event) => setPlaybookFilter(event.currentTarget.value)}>
              <option value="">All playbooks</option>
              {playbookOptions.map((playbook) => (
                <option key={playbook} value={playbook}>
                  {playbook}
                </option>
              ))}
            </select>
          </label>
          {/* Compact widths fold four columns into each row's metadata; these keep all seven sorts reachable. */}
          <label className="task-compact-sort">
            <span>Sort</span>
            <select
              value={sort.column.field}
              onChange={(event) => {
                const column = TASK_COLUMNS.find((candidate) => candidate.field === event.currentTarget.value);
                if (column) chooseSort(column, firstSortDirection(column.field));
              }}
            >
              {TASK_COLUMNS.map((column) => (
                <option key={column.field} value={column.field}>
                  {column.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn ghost small task-compact-sort"
            aria-label={`Sort ${sort.column.label} ${sort.direction === "asc" ? "descending" : "ascending"}`}
            title={`Sort ${sort.direction === "asc" ? "descending" : "ascending"}`}
            onClick={() => chooseSort(sort.column, sort.direction === "asc" ? "desc" : "asc")}
          >
            <span aria-hidden="true">{sort.direction === "asc" ? "↑" : "↓"}</span>
          </button>
          {!allRepos && <Checkbox checked={showArchived} onChange={setShowArchived} label="Show archived" />}
        </ListToolbar>
      ) : (
        <div className="collection-heading">
          {heading}
          {!allRepos && <Checkbox checked={showArchived} onChange={setShowArchived} label="Show archived" />}
        </div>
      )}
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
      ) : noMatches ? (
        <div className="list list-empty task-list-no-matches">
          <EmptyState title="No tasks match these filters." hint={`Clear filters to show all ${tasks.length} ${tasks.length === 1 ? "task" : "tasks"}.`} />
        </div>
      ) : (
        <div className="list task-table-wrap">
          <table className="task-table sticky-head">
            <thead>
              <tr>
                {TASK_COLUMNS.map((column) => {
                  const { field, label, className } = column;
                  const active = sort.column === column;
                  const nextDirection = active ? (sort.direction === "asc" ? "desc" : "asc") : firstSortDirection(field);
                  return (
                    <th key={field} scope="col" className={className} aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : undefined}>
                      <button
                        type="button"
                        className={`task-sort-header${active ? " active" : ""}`}
                        aria-label={`Sort by ${label}`}
                        title={`Sort ${label} ${nextDirection === "asc" ? "ascending" : "descending"}`}
                        onClick={() => chooseSort(column, nextDirection)}
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
                const summary = summaryOf(t);
                const activeSession = summary.active_session;
                const playbook = playbookLabel(t);
                const parentName = parentHidden && t.parent_task ? taskNames.get(lineageKey({ repo_path: t.repo_path, slug: t.parent_task })) : undefined;
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
                    <td className={`task-col-name task-name-cell${depth ? " nested" : ""}`} style={{ ["--task-depth" as string]: depth }}>
                      <span className="task-name-line" title={t.name}>
                        <span className="task-name-text">{t.name}</span>
                        {t.archived && <span className="pill task-archived">Archived</span>}
                        {t.draft && <span className="pill">Draft</span>}
                      </span>
                      <span className="task-subline">
                        {t.branch}
                        {allRepos ? ` · ${repoName(t.repo_path)}` : ""}
                        {parentHidden && (
                          <>
                            {" · "}
                            <span title={`Parent task: ${parentName ?? t.parent_task}`}>Child of {parentName ?? t.parent_task}</span>
                          </>
                        )}
                        <span
                          className="task-compact-meta"
                          title={`${playbook} · ${t.session_count} sessions · Created ${formatAbsolute(t.created)} · Updated ${formatAbsolute(updated)}`}
                        >
                          {` · ${playbook} · ${t.session_count} ${t.session_count === 1 ? "session" : "sessions"} · created ${formatAge(t.created, now)} · updated ${formatAge(updated, now)}`}
                        </span>
                      </span>
                    </td>
                    <td className="task-col-status status-col">
                      <TaskActivityIndicators activity={summary} />
                    </td>
                    <td className="task-col-active">
                      {activeSession ? (
                        <button
                          type="button"
                          className="badge res active-session-action"
                          title={`Open ${activeSession.step_title} session`}
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
                    <td className="task-col-playbook">
                      <span className="task-playbook" title={playbook}>
                        {playbook}
                      </span>
                    </td>
                    <td className="task-col-sessions num-col">{t.session_count}</td>
                    <td className="age-cell task-col-created age-col" title={formatAbsolute(t.created)}>
                      {formatAge(t.created, now)}
                    </td>
                    <td className="age-cell task-col-updated age-col" title={formatAbsolute(updated)}>
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
    </section>
  );
}
