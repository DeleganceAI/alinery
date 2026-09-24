import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { type ArchiveTaskPhase, archiveBoardTask } from "../archiveTask";
import { ORB_STATE } from "../Indicators";
import * as ipc from "../ipc";
import { PullRequestIndicator } from "../PullRequestIndicator";
import {
  ArchiveTaskModal,
  Checkbox,
  EMPTY_TASK_ACTIVITY,
  formatAbsolute,
  formatAge,
  InlineStatus,
  LoadingState,
  repoName,
  sameBoardBuckets,
  sameKanbanColumns,
  TaskActivityIndicators,
  taskKey,
  useBoardTaskActivity,
} from "../shared";
import type { BoardNav, BoardTask, KanbanColumn, TaskActivitySession } from "../types";
import { useTaskPullRequests } from "../useTaskPullRequests";

type ErrState = { msg: string; detail: string } | null;

/** Shown over a board with nothing to place on it. Sits over the lanes rather
 *  than replacing them: the columns behind are what the card is talking about,
 *  so showing them dimmed explains more than a sentence would. The phase pills
 *  carry the rest, which is why the copy stays to two lines. */
function BoardGate({ columns, onCreate }: { columns: KanbanColumn[]; onCreate: () => void }) {
  return (
    <div className="board-gate">
      <div className="gate-card">
        <h2 className="gate-title">The board starts with a task</h2>
        <p className="gate-copy">Create one and watch it move through these phases.</p>
        {columns.length > 0 && (
          <div className="gate-phases" aria-hidden="true">
            {columns.map((col) => (
              <span key={col.key || "backlog"} className="gate-phase">
                {col.title}
              </span>
            ))}
          </div>
        )}
        <button type="button" className="btn" onClick={onCreate}>
          New task
        </button>
      </div>
    </div>
  );
}

export function Kanban({
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
  const [columns, setColumns] = useState<KanbanColumn[]>([]);
  const [byColumn, setByColumn] = useState<Record<string, BoardTask[]>>({});
  const [selectedTaskKey, setSelectedTaskKey] = useState("");
  const [pendingArchive, setPendingArchive] = useState<BoardTask | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [showChildren, setShowChildren] = useState(false);
  const [showEmptyColumns, setShowEmptyColumns] = useState(true);
  // Every task in scope, archived included. The gate asks "does a task exist at all",
  // which is not the same question as "is the board showing anything" — a repo whose
  // only tasks are archived has work to come back to, so it is not gated.
  const [taskTotal, setTaskTotal] = useState(0);
  const [err, setErr] = useState<ErrState>(null);
  const [loaded, setLoaded] = useState(false);
  const boardRef = useRef<HTMLDivElement | null>(null);

  // Keyboard selection (j/k/h/l, arrows) must stay visible while columns scroll.
  useEffect(() => {
    boardRef.current?.querySelector(".card.sel")?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [selectedTaskKey]);

  const load = () =>
    (async () => {
      try {
        const [baseColumns, allTasks] = await Promise.all([ipc.listKanbanColumns(allRepos), ipc.listBoardTasks(allRepos)]);
        const tasks = allTasks.filter((task) => showArchived || !task.archived);
        setTaskTotal(allTasks.length);
        const cols = [...baseColumns];
        tasks.forEach((t) => {
          if (!cols.some((c) => c.key === t.current_column_key)) cols.push({ key: t.current_column_key, title: t.current_column_title || t.current_column_key || "Other" });
        });
        const buckets: Record<string, BoardTask[]> = Object.fromEntries(cols.map((col) => [col.key, []]));
        tasks.forEach((t) => {
          buckets[t.current_column_key] ||= [];
          buckets[t.current_column_key].push(t);
        });
        setColumns((current) => (sameKanbanColumns(current, cols) ? current : cols));
        setByColumn((current) => (sameBoardBuckets(current, buckets) ? current : buckets));
        setSelectedTaskKey((prev) => (prev && tasks.some((task) => taskKey(task) === prev) ? prev : tasks[0] ? taskKey(tasks[0]) : ""));
        setErr(null);
      } catch (e) {
        setErr({ msg: "Couldn't load the board.", detail: String(e) });
      } finally {
        setLoaded(true);
      }
    })();

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 3000);
    return () => window.clearInterval(timer);
  }, [allRepos, showArchived]);

  useEffect(() => {
    void import("../views/TaskDetail");
  }, []);

  const confirmArchive = async (removeWt: boolean, onPhase: (phase: ArchiveTaskPhase) => void) => {
    const pending = pendingArchive;
    if (!pending) return;
    const failure = await archiveBoardTask(pending, removeWt, onPhase);
    setPendingArchive(null);
    if (failure) {
      // Errors must outlive a toast; the inline status above the board is persistent.
      setErr(failure);
      return;
    }
    void load();
  };

  const cardsIn = (columnIndex: number) => (byColumn[columns[columnIndex]?.key] ?? []).filter((task) => showChildren || !task.parent_task);
  const visibleTasks = columns.flatMap((_, columnIndex) => cardsIn(columnIndex));
  const activity = useBoardTaskActivity(visibleTasks);
  const pullRequests = useTaskPullRequests(visibleTasks.filter((task) => !task.draft).map((task) => ({ repoPath: task.repo_path, taskSlug: task.slug })));
  // Gated on `loaded` so the gate cannot flash over a board that is still fetching.
  const locked = loaded && taskTotal === 0;

  useEffect(() => {
    setSelectedTaskKey((previous) => (previous && visibleTasks.some((task) => taskKey(task) === previous) ? previous : visibleTasks[0] ? taskKey(visibleTasks[0]) : ""));
  }, [showChildren, byColumn, columns]);
  const selectedCard = () => {
    for (let col = 0; col < columns.length; col += 1) {
      const cards = cardsIn(col);
      const row = cards.findIndex((card) => taskKey(card) === selectedTaskKey);
      if (row >= 0) return { col, row, card: cards[row] };
    }
    return null;
  };

  // Register the nav API every render so its closures see the latest selection/data.
  useLayoutEffect(() => {
    const locate = (key: string) => {
      for (let col = 0; col < columns.length; col += 1) {
        const cards = cardsIn(col);
        const row = cards.findIndex((card) => taskKey(card) === key);
        if (row >= 0) return { col, row };
      }
      return null;
    };
    const clampRow = (col: number, row: number) => Math.max(0, Math.min(row, cardsIn(col).length - 1));
    registerNav({
      moveRow: (d) =>
        setSelectedTaskKey((prev) => {
          const found = locate(prev);
          const col = found?.col ?? columns.findIndex((_, ci) => cardsIn(ci).length > 0);
          if (col < 0) return "";
          const cards = cardsIn(col);
          const row = found ? found.row : 0;
          return taskKey(cards[(row + d + cards.length) % cards.length]);
        }),
      moveCol: (d) =>
        setSelectedTaskKey((prev) => {
          const found = locate(prev);
          const startCol = found?.col ?? columns.findIndex((_, ci) => cardsIn(ci).length > 0);
          if (startCol < 0) return "";
          const startRow = found?.row ?? 0;
          for (let i = 0; i < columns.length; i++) {
            const c = (startCol + d * (i + 1) + columns.length * 10) % columns.length;
            const cards = cardsIn(c);
            if (cards.length) return taskKey(cards[clampRow(c, startRow)]);
          }
          return prev;
        }),
      openSelected: () => {
        const selected = selectedCard();
        if (selected) onOpen(selected.card);
      },
      duplicateSelected: () => {
        const selected = selectedCard();
        if (selected) onDuplicate(selected.card);
      },
      archiveSelected: () => {
        setPendingArchive(selectedCard()?.card ?? null);
      },
    });
    return () => registerNav(null);
  });

  return (
    <>
      <div className="listhead">
        <h1 className="view-title">Kanban</h1>
        <Checkbox checked={showArchived} onChange={setShowArchived} label="Show archived" />
        <Checkbox checked={showChildren} onChange={setShowChildren} label="Show children" />
        <Checkbox checked={showEmptyColumns} onChange={setShowEmptyColumns} label="Show empty columns" />
      </div>
      {err && (
        <InlineStatus tone="error" detail={err.detail}>
          {err.msg}
        </InlineStatus>
      )}
      {!loaded && <LoadingState label="Loading board" state={ORB_STATE} />}
      <div className="board" ref={boardRef}>
        {locked && <BoardGate columns={columns} onCreate={onCreate} />}
        {columns.map((col, ci) => {
          const cards = cardsIn(ci);
          if (!showEmptyColumns && cards.length === 0) return null;
          return (
            <div key={col.key || "backlog"} className="col">
              <div className="col-hd">
                <span className="name">{col.title}</span>
                <span className="cnt">{cards.length}</span>
              </div>
              <div className="col-body">
                {/* Nothing renders for an empty lane. The header already carries the
                    phase name and a count reading 0; "No tasks in this phase." repeated
                    that once per column, and any placeholder mark decorates an empty
                    state more heavily than a populated one (DESIGN.md §Empty). */}
                {cards.map((t) => {
                  const isSel = taskKey(t) === selectedTaskKey;
                  const updated = t.updated || t.created;
                  const state = activity[taskKey(t)] ?? EMPTY_TASK_ACTIVITY;
                  const activeSession = state.active_session;
                  return (
                    <div
                      key={taskKey(t)}
                      className={`card${isSel ? " sel" : ""}${t.archived ? " row-archived" : ""}`}
                      role="button"
                      tabIndex={isSel ? 0 : -1}
                      aria-current={isSel || undefined}
                      onFocus={() => setSelectedTaskKey(taskKey(t))}
                      onKeyDown={(e) => {
                        if (e.target === e.currentTarget && (e.key === " " || e.key === "Enter")) {
                          e.preventDefault();
                          onOpen(t);
                        }
                      }}
                      onClick={() => {
                        setSelectedTaskKey(taskKey(t));
                        onOpen(t);
                      }}
                    >
                      <div className="card-hd">
                        <div className="t">{t.name}</div>
                        <div className="card-status">
                          <PullRequestIndicator snapshot={pullRequests[taskKey(t)]} compact />
                          <TaskActivityIndicators activity={state} />
                          <span className="age" title={formatAbsolute(updated)} style={{ marginLeft: 0 }}>
                            {formatAge(updated)}
                          </span>
                        </div>
                      </div>
                      <div className="meta">
                        {t.archived && <span className="pill task-archived">Archived</span>}
                        {t.draft && <span className="pill">Draft</span>}
                        {t.parent_task && <span className="pill task-child-badge">↳ Child</span>}
                        {t.active_subtask && <span className="pill task-active-child-badge">Active child · {t.active_subtask}</span>}
                        <span className="pill task-playbook playbook-chip">{t.playbook_title || t.playbook || "Playbook"}</span>
                        {activeSession && (
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
                        )}
                        {allRepos && <span className="repochip">{repoName(t.repo_path)}</span>}
                        <span className="pill">
                          {t.session_count} {t.session_count === 1 ? "session" : "sessions"}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <ArchiveTaskModal task={pendingArchive} onCancel={() => setPendingArchive(null)} onConfirm={confirmArchive} />
    </>
  );
}
