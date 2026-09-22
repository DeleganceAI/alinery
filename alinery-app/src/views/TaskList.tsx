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
} from "../shared";
import type { BoardNav, BoardTask, TaskActivitySession } from "../types";

export type TaskListRow = {
  task: BoardTask;
  depth: number;
  parentHidden: boolean;
};

function compareTaskRows(left: BoardTask, right: BoardTask): number {
  return left.created - right.created || left.repo_path.localeCompare(right.repo_path) || left.slug.localeCompare(right.slug);
}

function lineageKey(task: Pick<BoardTask, "repo_path" | "slug">): string {
  return `${task.repo_path}\u0000${task.slug}`;
}

export function flattenTaskRows(tasks: BoardTask[]): TaskListRow[] {
  const byKey = new Map(tasks.map((task) => [lineageKey(task), task]));
  const children = new Map<string, BoardTask[]>();
  for (const task of tasks) {
    if (!task.parent_task) continue;
    const parentKey = `${task.repo_path}\u0000${task.parent_task}`;
    const siblings = children.get(parentKey) ?? [];
    siblings.push(task);
    children.set(parentKey, siblings);
  }
  for (const siblings of children.values()) siblings.sort(compareTaskRows);

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
    .sort(compareTaskRows);
  for (const root of roots) append(root, 0, Boolean(root.parent_task));
  for (const task of tasks.slice().sort(compareTaskRows)) {
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
  const rows = flattenTaskRows(tasks);
  const activity = useBoardTaskActivity(rows.map((row) => row.task));
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
                <th className="name-col">Name</th>
                <th>Playbook</th>
                <th>Active session</th>
                <th className="status-col">Status</th>
                <th className="num-col">Sessions</th>
                <th className="age-col">Created</th>
                <th className="age-col">Updated</th>
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
                      {formatAge(t.created)}
                    </td>
                    <td className="age-cell age-col" title={formatAbsolute(updated)}>
                      {formatAge(updated)}
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
