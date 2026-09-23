import { ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ORB_STATE } from "../Indicators";
import * as ipc from "../ipc";
import { NameEditor } from "../NameEditor";
import {
  hasAcknowledgedExit,
  orderSessionListItems,
  PRIORITY_SESSION_SORT,
  type SessionSort,
  sameSessionObservationMaps,
  selectSessionSort,
  sessionListItemKey,
  sessionSortArrow,
  sessionStartedAt,
  sessionUpdatedAt,
} from "../sessionAttention";
import { Checkbox, EmptyState, harnessDisplayName, InlineStatus, KillButton, LoadingState, repoName, SessionTimestamp, StatusDot, sameSessionMetas, useMinuteNow } from "../shared";
import type { BoardNav, NameCommit, SessionListItem, SessionObservation, SessionStatusRef } from "../types";
import { useSessionSort } from "../useSessionSort";

const rowKey = sessionListItemKey;

function sameSessionListItems(left: SessionListItem[], right: SessionListItem[]) {
  return (
    sameSessionMetas(left, right) &&
    left.every((item, index) => {
      const other = right[index];
      return (
        item.task_slug === other.task_slug &&
        item.task_name === other.task_name &&
        item.subtask_name === other.subtask_name &&
        item.task_worktree === other.task_worktree &&
        item.repo_path === other.repo_path &&
        item.playbook_title === other.playbook_title &&
        item.step_title === other.step_title &&
        item.is_playbook_step === other.is_playbook_step
      );
    })
  );
}

export function SessionsList({
  allRepos,
  activeRepo,
  onOpen,
  registerNav,
  onCreateSession,
  onCreateTask,
  sessionSort: controlledSessionSort,
  onSessionSortChange,
  onNameCommitted,
}: {
  allRepos: boolean;
  activeRepo: string;
  onOpen: (item: SessionListItem) => void;
  registerNav: (n: BoardNav | null) => void;
  onCreateSession: () => void;
  onCreateTask: () => void;
  sessionSort?: SessionSort;
  onSessionSortChange?: (sort: SessionSort) => void;
  onNameCommitted?: (change: NameCommit) => void;
}) {
  const [items, setItems] = useState<SessionListItem[]>([]);
  const [observations, setObservations] = useState<Record<string, SessionObservation>>({});
  const [selectedKey, setSelectedKey] = useState("");
  const [err, setErr] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [sessionSort, setSessionSort] = useSessionSort(
    controlledSessionSort !== undefined && onSessionSortChange !== undefined ? { sort: controlledSessionSort, onChange: onSessionSortChange } : undefined,
  );
  const now = useMinuteNow();
  // Only consulted when there are no sessions, to pick the empty state's one
  // action. A session needs a task to live on, so with zero tasks "New session"
  // lands on a picker with nothing to pick — the real next step is a task.
  const [taskCount, setTaskCount] = useState<number | null>(null);
  const itemsRef = useRef<SessionListItem[]>([]);
  const statusRequest = useRef(0);
  const itemRequest = useRef(0);
  const scopeVersion = useRef(0);
  const scopeKey = `${allRepos}:${activeRepo}:${showArchived}`;
  const currentScope = useRef(scopeKey);
  if (currentScope.current !== scopeKey) {
    currentScope.current = scopeKey;
    scopeVersion.current += 1;
    itemRequest.current += 1;
    statusRequest.current += 1;
  }
  const [editingKey, setEditingKey] = useState("");
  const renameTrigger = useRef<HTMLButtonElement | null>(null);
  const editorVersion = useRef(0);
  const closeEditor = () => {
    editorVersion.current += 1;
    setEditingKey("");
    renameTrigger.current?.focus();
  };

  const refreshStatuses = (rows: SessionListItem[]) => {
    const statusRows = rows.filter((item) => !item.archived);
    const request = ++statusRequest.current;
    if (statusRows.length === 0) {
      setObservations((current) => (Object.keys(current).length === 0 ? current : {}));
      return Promise.resolve();
    }
    const refs: SessionStatusRef[] = statusRows.map((item) => ({
      repo_path: item.repo_path,
      task_slug: item.task_slug,
      id: item.id,
    }));
    return ipc
      .sessionListStatuses(refs)
      .catch(() => ({}) as Record<string, SessionObservation>)
      .then((observed) => {
        if (request !== statusRequest.current) return;
        setObservations((current) => (sameSessionObservationMaps(current, observed) ? current : observed));
      });
  };

  const load = async () => {
    const version = scopeVersion.current;
    const request = ++itemRequest.current;
    const current = () => version === scopeVersion.current && request === itemRequest.current;
    try {
      const listed = await ipc.listSessionItems(true, showArchived);
      const rows = allRepos ? listed : listed.filter((row) => row.repo_path === activeRepo);
      if (!current()) return;
      itemsRef.current = rows;
      setItems((previous) => (sameSessionListItems(previous, rows) ? previous : rows));
      setSelectedKey((prev) => (prev && rows.some((row) => rowKey(row) === prev) ? prev : rows[0] ? rowKey(rows[0]) : ""));
      setErr("");
      void refreshStatuses(rows);
    } catch (error) {
      if (current()) setErr(String(error));
    } finally {
      if (current()) setLoaded(true);
    }
  };

  const saveName = async (item: SessionListItem, name: string) => {
    const version = scopeVersion.current;
    const editor = editorVersion.current;
    const value = await ipc.renameSession({ repoPath: item.repo_path, taskSlug: item.task_slug, sessionId: item.id, name });
    if (version === scopeVersion.current) {
      itemRequest.current += 1;
      const rows = itemsRef.current.map((row) => (rowKey(row) === rowKey(item) ? { ...row, name: value.name, name_source: value.source, name_error: null } : row));
      itemsRef.current = rows;
      setItems(rows);
      if (editor === editorVersion.current) closeEditor();
      void load();
    }
    onNameCommitted?.({ kind: "session", repo_path: item.repo_path, task_slug: item.task_slug, session_id: item.id, value });
  };

  useEffect(() => {
    let alive = true;
    let timer = 0;
    setEditingKey("");
    setItems([]);
    itemsRef.current = [];
    setLoaded(false);
    setErr("");
    const poll = () => {
      load().finally(() => {
        if (alive) timer = window.setTimeout(poll, 3000);
      });
    };
    poll();
    return () => {
      alive = false;
      scopeVersion.current += 1;
      itemRequest.current += 1;
      statusRequest.current += 1;
      window.clearTimeout(timer);
    };
  }, [allRepos, activeRepo, showArchived]);

  const empty = loaded && items.length === 0;

  // Fetched once on reaching empty, not on the 3s poll — the answer only decides
  // which button the empty state offers, and there are no sessions to refresh.
  useEffect(() => {
    if (!empty) return;
    let alive = true;
    ipc
      .listBoardTasks(allRepos)
      .then((tasks) => alive && setTaskCount(tasks.filter((task) => !task.archived).length))
      .catch(() => alive && setTaskCount(null));
    return () => {
      alive = false;
    };
  }, [empty, allRepos, activeRepo]);

  useEffect(() => {
    let alive = true;
    let timer = 0;
    const poll = () => {
      refreshStatuses(itemsRef.current).finally(() => {
        if (alive) timer = window.setTimeout(poll, 1500);
      });
    };
    timer = window.setTimeout(poll, 1500);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, []);

  const orderedItems = orderSessionListItems(items, observations, sessionSort);
  const selectedIndex = orderedItems.findIndex((item) => rowKey(item) === selectedKey);
  const selectedItem = selectedIndex >= 0 ? orderedItems[selectedIndex] : null;
  const selectedRowRef = useRef<HTMLDivElement | null>(null);

  // Keyboard selection (j/k) must stay visible: follow it with the scroll position.
  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedKey]);

  useEffect(() => {
    registerNav({
      moveRow: (d) =>
        setSelectedKey((prev) => {
          if (!orderedItems.length) return "";
          const current = Math.max(
            0,
            orderedItems.findIndex((item) => rowKey(item) === prev),
          );
          const next = Math.max(0, Math.min(current + d, orderedItems.length - 1));
          return rowKey(orderedItems[next]);
        }),
      moveCol: () => {},
      openSelected: () => {
        if (selectedItem?.task_worktree && !selectedItem.archived) onOpen(selectedItem);
      },
      duplicateSelected: () => {},
      archiveSelected: () => {},
    });
    return () => registerNav(null);
  });

  const latestSessionByScope = items
    .filter((item) => !item.archived && item.phase)
    .reduce<Record<string, SessionListItem>>((latest, item) => {
      const scope = `${item.repo_path}\u0000${item.task_slug}\u0000${item.playbook}\u0000${item.phase}`;
      const current = latest[scope];
      if (!current || item.created > current.created || (item.created === current.created && item.id > current.id)) {
        latest[scope] = item;
      }
      return latest;
    }, {});

  return (
    <div className="listwrap">
      <div className="listhead">
        <h1 className="view-title">Sessions</h1>
        <fieldset className="session-sort-controls">
          <legend className="sr-only">Session sort</legend>
          <button
            type="button"
            className={`btn ghost small${sessionSort.field === "priority" ? " active" : ""}`}
            aria-pressed={sessionSort.field === "priority"}
            onClick={() => setSessionSort(PRIORITY_SESSION_SORT)}
          >
            Priority
          </button>
          {(["started", "updated"] as const).map((field) => {
            const active = sessionSort.field === field;
            const label = field === "started" ? "Started" : "Updated";
            const direction = active ? sessionSort.direction : "desc";
            return (
              <button
                key={field}
                type="button"
                className={`btn ghost small${active ? " active" : ""}`}
                aria-pressed={active}
                aria-label={`${label}: ${active ? (direction === "desc" ? "newest first; activate for oldest first" : "oldest first; activate for newest first") : "activate for newest first"}`}
                onClick={() => setSessionSort(selectSessionSort(sessionSort, field))}
              >
                {label} {sessionSortArrow(sessionSort, field)}
              </button>
            );
          })}
        </fieldset>
        <Checkbox checked={showArchived} onChange={setShowArchived} label="Show archived" />
      </div>
      {err && (
        <InlineStatus tone="error" detail={err}>
          Could not load sessions.
        </InlineStatus>
      )}
      {!loaded && <LoadingState label="Loading sessions" state={ORB_STATE} />}
      {empty ? (
        <div className="list list-empty">
          <EmptyState
            art
            title="No sessions yet."
            hint={
              taskCount === 0
                ? "A session runs a harness inside a task's worktree, so a task has to exist first."
                : taskCount === null
                  ? "A session runs one harness inside a task's worktree."
                  : "A session runs one harness inside a task's worktree. Start one from any task."
            }
            action={
              taskCount === null ? undefined : taskCount === 0 ? (
                <button type="button" className="btn" onClick={onCreateTask}>
                  New task
                </button>
              ) : (
                <button type="button" className="btn" onClick={onCreateSession}>
                  New session
                </button>
              )
            }
          />
        </div>
      ) : (
        <div className="list">
          {orderedItems.map((item, i) => {
            const openable = Boolean(item.task_worktree) && !item.archived;
            const resumedBy = items.find((other) => other.resume_of === item.id);
            const key = rowKey(item);
            const obs = observations[key];
            const isLive = obs ? obs.lifecycle.state === "live" : false;
            const scope = `${item.repo_path}\u0000${item.task_slug}\u0000${item.playbook}\u0000${item.phase}`;
            const superseded = !item.archived && !!item.phase && latestSessionByScope[scope]?.id !== item.id;
            const sessionType = item.subtask_manager
              ? "Sub-task manager"
              : item.is_playbook_step
                ? `${item.playbook_title} · ${item.step_title}`
                : item.generic
                  ? "Generic"
                  : item.step_title || item.phase || "No step";
            const sessionDetail = `${item.task_slug}${item.archived ? " · archived" : !item.task_worktree ? " · worktree removed" : ""}`;
            return (
              <div
                key={key}
                ref={i === selectedIndex ? selectedRowRef : undefined}
                className={`row session-list-row${i === selectedIndex ? " sel" : ""}${openable ? "" : " disabled"}`}
                role={openable ? "button" : undefined}
                tabIndex={openable ? 0 : undefined}
                onClick={() => {
                  setSelectedKey(key);
                  if (openable) onOpen(item);
                }}
                onKeyDown={(e) => {
                  if (!openable || (e.key !== "Enter" && e.key !== " ") || e.target !== e.currentTarget) return;
                  e.preventDefault();
                  setSelectedKey(key);
                  onOpen(item);
                }}
              >
                <span className="idx">{String(i + 1).padStart(2, "0")}</span>
                <div className="rt">
                  <div className="rtt" title={item.name || item.task_name}>
                    {item.name || item.task_name}
                  </div>
                  <div className="meta">
                    {item.name && <span>{item.task_name}</span>}
                    {item.subtask_manager && <span>{item.subtask_name || item.subtask_slug || "Sub-task setup"}</span>}
                    {item.archived && <span className="pill task-archived">Archived</span>}
                    {sessionType === "No step" ? (
                      <span className="pill">No step</span>
                    ) : (
                      <span className={`badge ${item.is_playbook_step ? "res" : "todo"}`} title={sessionType}>
                        {sessionType}
                      </span>
                    )}
                    <span className="pill" title={`${harnessDisplayName(item.harness)}${item.model ? ` · ${item.model}` : ""}`}>
                      {harnessDisplayName(item.harness)}
                      {item.model ? ` · ${item.model}` : ""}
                    </span>
                    {allRepos && <span className="repochip">{repoName(item.repo_path)}</span>}
                    <SessionTimestamp kind="started" value={sessionStartedAt(item)} now={now} />
                    <SessionTimestamp kind="updated" value={sessionUpdatedAt(item)} now={now} />
                    {!item.archived && (
                      <StatusDot
                        id={item.id}
                        slug={item.task_slug}
                        repoPath={item.repo_path}
                        observation={obs ?? null}
                        superseded={superseded}
                        exitCode={item.exit_code}
                        exitAcknowledged={hasAcknowledgedExit(item)}
                      />
                    )}
                    {!item.archived && <KillButton id={item.id} slug={item.task_slug} repoPath={item.repo_path} live={item.repo_path === activeRepo && isLive} onKilled={load} />}
                    {resumedBy && <span className="pill dim">Resumed</span>}
                  </div>
                  {item.name_error && (
                    <InlineStatus tone="error" detail={item.name_error}>
                      Could not read session name.
                    </InlineStatus>
                  )}
                  <button
                    type="button"
                    className="btn ghost small"
                    aria-label="Rename session"
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (editingKey === key) return;
                      renameTrigger.current = event.currentTarget;
                      editorVersion.current += 1;
                      setEditingKey(key);
                    }}
                  >
                    Rename
                  </button>
                  {editingKey === key && (
                    <NameEditor key={`${scopeKey}:${key}`} value={item.name || ""} label="Session name" onSave={(name) => saveName(item, name)} onCancel={closeEditor} />
                  )}
                  <div className="rts" title={sessionDetail}>
                    {sessionDetail}
                  </div>
                </div>
                {openable ? (
                  <span className="arrow" aria-hidden="true">
                    <ChevronRight size={16} strokeWidth={1.5} />
                  </span>
                ) : (
                  <span className="dim">{item.archived ? "Archived" : "Worktree removed"}</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
