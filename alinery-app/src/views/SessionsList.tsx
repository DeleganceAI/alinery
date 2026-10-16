import { ChevronRight, Pencil } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { ORB_STATE } from "../Indicators";
import * as ipc from "../ipc";
import { ArchiveFilter, ListToolbar } from "../ListToolbar";
import { awaitingSessionName, NameEditor, PendingSessionName } from "../NameEditor";
import {
  hasAcknowledgedExit,
  type ObservationDisplayKind,
  observationDisplayKind,
  orderSessionListItems,
  PRIORITY_SESSION_SORT,
  type SessionSort,
  sameSessionObservationMaps,
  selectSessionSort,
  sessionDisplayKind,
  sessionListItemKey,
  sessionSortArrow,
  sessionStartedAt,
  sessionUpdatedAt,
} from "../sessionAttention";
import {
  EmptyState,
  harnessDisplayName,
  InlineStatus,
  KillButton,
  LoadingState,
  notifySessionAttentionTransition,
  repoName,
  SessionTimestamp,
  StatusDot,
  sameSessionMetas,
  useMinuteNow,
} from "../shared";
import type { BoardNav, NameCommit, SessionListItem, SessionObservation, SessionStatusRef } from "../types";
import { useSessionSort } from "../useSessionSort";
import "./SessionsList.css";

const rowKey = sessionListItemKey;

function sessionTypeLabel(item: SessionListItem) {
  if (item.subtask_manager) return "Sub-task manager";
  if (item.is_playbook_step) return `${item.playbook_title} · ${item.step_title}`;
  if (item.generic) return "Generic";
  return item.step_title || item.phase || "No step";
}

type StatusFilter = "all" | "waiting" | "running" | "failed" | "completed" | "idle" | "ended" | "not_started" | "unknown" | "archived";

const STATUS_FILTER_OPTIONS: ReadonlyArray<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "All statuses" },
  { value: "waiting", label: "Needs input or approval" },
  { value: "running", label: "Running" },
  { value: "failed", label: "Failed" },
  { value: "completed", label: "Completed" },
  { value: "idle", label: "Idle" },
  { value: "ended", label: "Exited or stale" },
  { value: "not_started", label: "Not started" },
  { value: "unknown", label: "Unknown" },
];

// Groups a row by the status its StatusDot renders, from the same canonical
// observation and exit metadata. A row with no observation yet is Unknown —
// absence of evidence is never reported as Not started.
function sessionStatusGroup(item: SessionListItem, observation: SessionObservation | undefined, superseded: boolean): Exclude<StatusFilter, "all"> {
  if (item.archived) return "archived";
  const kind = sessionDisplayKind(observation, superseded, item.exit_code, hasAcknowledgedExit(item));
  switch (kind) {
    case "waiting_for_input":
    case "waiting_for_approval":
      return "waiting";
    case "busy":
    case "starting":
    case "unsupported":
      return "running";
    case "failed":
      return "failed";
    case "completed":
    case "ready_to_advance":
      return "completed";
    case "idle":
      return "idle";
    case "exited":
    case "stale":
      return "ended";
    case "never_started":
      return "not_started";
    default:
      return "unknown";
  }
}

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
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const statusFilterId = useId();
  const sortLabelId = useId();
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
      const rows = await ipc.listSessionItems(allRepos, showArchived, activeRepo);
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
    itemsRef.current = [];
    setItems([]);
    setObservations({});
    setSelectedKey("");
    setErr("");
    setLoaded(false);
    let alive = true;
    let timer = 0;
    setEditingKey("");
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

  // Attention follows the fetched collection, not rows that filters can unmount.
  const previousKinds = useRef(new Map<string, ObservationDisplayKind>());
  useEffect(() => {
    const next = new Map<string, ObservationDisplayKind>();
    for (const item of items) {
      if (item.archived) continue;
      const key = rowKey(item);
      const observation = observations[key];
      const kind = observation ? observationDisplayKind(observation) : "loading";
      notifySessionAttentionTransition(previousKinds.current.get(key) ?? null, kind, item.repo_path, item.task_slug);
      next.set(key, kind);
    }
    previousKinds.current = next;
  }, [items, observations]);

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
  const latestPhaseKeys = new Set(Object.values(latestSessionByScope).map(rowKey));
  const isSuperseded = (item: SessionListItem) => !item.archived && !!item.phase && !latestPhaseKeys.has(rowKey(item));

  const orderedItems = orderSessionListItems(items, observations, sessionSort);
  const queryTerms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = queryTerms.length > 0 || statusFilter !== "all";
  const visibleItems = filtered
    ? orderedItems.filter((item) => {
        if (statusFilter !== "all" && sessionStatusGroup(item, observations[rowKey(item)], isSuperseded(item)) !== statusFilter) return false;
        if (queryTerms.length === 0) return true;
        const text = [
          item.name,
          item.task_name,
          item.task_slug,
          item.subtask_name,
          item.subtask_slug,
          item.subtask_manager ? "Sub-task manager" : "",
          repoName(item.repo_path),
          item.playbook_title,
          item.playbook,
          item.step_title,
          item.phase,
          item.harness === "omp" ? "OMP" : harnessDisplayName(item.harness),
          item.model,
        ]
          .filter(Boolean)
          .join("\n")
          .toLowerCase();
        return queryTerms.every((term) => text.includes(term));
      })
    : orderedItems;
  const resetFilters = () => {
    setQuery("");
    setStatusFilter("all");
  };
  // Selection only ever lands on a rendered row. When a filter hides the selected
  // session, the first visible row takes over so keyboard open never reaches a
  // hidden session; with nothing visible the previous identity is kept.
  const selectedIndex =
    visibleItems.length === 0
      ? -1
      : Math.max(
          0,
          visibleItems.findIndex((item) => rowKey(item) === selectedKey),
        );
  const selectedItem = selectedIndex >= 0 ? visibleItems[selectedIndex] : null;
  const selectedVisibleKey = selectedItem ? rowKey(selectedItem) : "";
  const selectedRowRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (selectedVisibleKey && selectedVisibleKey !== selectedKey) setSelectedKey(selectedVisibleKey);
  }, [selectedVisibleKey, selectedKey]);

  // Keyboard selection (j/k) must stay visible: follow it with the scroll position.
  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedVisibleKey]);

  useEffect(() => {
    registerNav({
      moveRow: (d) =>
        setSelectedKey((prev) => {
          if (!visibleItems.length) return prev;
          const current = Math.max(
            0,
            visibleItems.findIndex((item) => rowKey(item) === prev),
          );
          const next = Math.max(0, Math.min(current + d, visibleItems.length - 1));
          return rowKey(visibleItems[next]);
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

  const statusOptions = showArchived ? [...STATUS_FILTER_OPTIONS, { value: "archived", label: "Archived" }] : STATUS_FILTER_OPTIONS;

  return (
    <section className="listwrap collection-view">
      <ListToolbar
        label="Sessions"
        heading={<h1 className="view-title">Sessions</h1>}
        query={query}
        onQueryChange={setQuery}
        shown={visibleItems.length}
        total={items.length}
        filtered={filtered}
        onReset={resetFilters}
      >
        <div className="sessions-filter">
          <label htmlFor={statusFilterId}>Status</label>
          <select id={statusFilterId} value={statusFilter} onChange={(event) => setStatusFilter(event.currentTarget.value as StatusFilter)}>
            {statusOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="session-sort-controls sessions-sort" role="group" aria-labelledby={sortLabelId}>
          <span id={sortLabelId} className="sessions-sort-label">
            Sort by
          </span>
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
        </div>
        <ArchiveFilter
          checked={showArchived}
          onChange={(value) => {
            setShowArchived(value);
            if (!value && statusFilter === "archived") setStatusFilter("all");
          }}
        />
      </ListToolbar>
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
      ) : items.length > 0 && visibleItems.length === 0 ? (
        <div className="list list-empty sessions-no-matches">
          <EmptyState title="No matching sessions." hint="Clear filters to show all sessions." />
        </div>
      ) : (
        <div className="list sessions-list">
          {visibleItems.map((item, i) => {
            const openable = Boolean(item.task_worktree) && !item.archived;
            const resumedBy = items.find((other) => other.resume_of === item.id);
            const key = rowKey(item);
            const obs = observations[key];
            const isLive = obs ? obs.lifecycle.state === "live" : false;
            const awaitingName = awaitingSessionName(item, obs);
            const sessionType = sessionTypeLabel(item);
            const subtaskLabel = item.subtask_name || item.subtask_slug || "Sub-task setup";
            const agent = `${item.harness === "omp" ? "OMP" : harnessDisplayName(item.harness)}${item.model ? ` · ${item.model}` : ""}`;
            const taskTitle = `Task: ${item.task_name} (${item.task_slug})`;
            const selected = i === selectedIndex;
            return (
              <div
                key={key}
                ref={selected ? selectedRowRef : undefined}
                className={`row session-list-row${selected ? " sel" : ""}${openable ? "" : " disabled"}`}
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
                <div className="session-row-main">
                  <div className="session-row-title">
                    <span className="rtt" title={item.name || (awaitingName ? "Waiting for session name" : taskTitle)}>
                      {item.name || (awaitingName ? <PendingSessionName /> : item.task_name)}
                    </span>
                    <button
                      type="button"
                      className="name-edit-button"
                      aria-label="Rename session"
                      title="Rename session"
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
                      <Pencil size={14} strokeWidth={1.5} aria-hidden="true" />
                    </button>
                    {!item.archived && !item.task_worktree && <span className="session-row-flag">Worktree removed</span>}
                    {resumedBy && <span className="session-row-flag">Resumed</span>}
                  </div>
                  <div className="session-row-meta">
                    {(item.name || awaitingName) && (
                      <span className="session-row-task" title={taskTitle}>
                        {item.task_name}
                      </span>
                    )}
                    {item.subtask_manager && <span title={`Sub-task: ${subtaskLabel}`}>{subtaskLabel}</span>}
                    <span title={sessionType}>{sessionType}</span>
                    <span className="session-row-agent" title={`Agent: ${agent}`}>
                      {agent}
                    </span>
                    {allRepos && (
                      <span className="session-row-repo" title={item.repo_path}>
                        {repoName(item.repo_path)}
                      </span>
                    )}
                  </div>
                  {item.name_error && (
                    <InlineStatus tone="error" detail={item.name_error}>
                      Could not read session name.
                    </InlineStatus>
                  )}
                  {editingKey === key && (
                    <NameEditor key={`${scopeKey}:${key}`} value={item.name || ""} label="Session name" onSave={(name) => saveName(item, name)} onCancel={closeEditor} />
                  )}
                </div>
                <div className="session-row-status">
                  {item.archived ? (
                    <span className="statusdot">Archived</span>
                  ) : (
                    <StatusDot
                      id={item.id}
                      slug={item.task_slug}
                      repoPath={item.repo_path}
                      observation={obs ?? null}
                      superseded={isSuperseded(item)}
                      exitCode={item.exit_code}
                      exitAcknowledged={hasAcknowledgedExit(item)}
                      notifyTransitions={false}
                    />
                  )}
                </div>
                <div className="session-row-times">
                  <SessionTimestamp kind="started" value={sessionStartedAt(item)} now={now} />
                  <SessionTimestamp kind="updated" value={sessionUpdatedAt(item)} now={now} />
                </div>
                <div className="session-row-actions">
                  {!item.archived && <KillButton id={item.id} slug={item.task_slug} repoPath={item.repo_path} live={item.repo_path === activeRepo && isLive} onKilled={load} />}
                </div>
                <span className="session-row-open" aria-hidden="true">
                  {openable && <ChevronRight size={16} strokeWidth={1.5} />}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
