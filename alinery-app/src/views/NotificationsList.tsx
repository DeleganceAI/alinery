import { useEffect, useMemo, useRef, useState } from "react";
import { IdleDot, StateIcon } from "../Indicators";
import { type SessionNotice, type SessionNoticeRow, sessionListItemKey } from "../sessionAttention";
import { EmptyState, InlineStatus, LoadingState, repoName } from "../shared";
import type { BoardNav, SessionListItem } from "../types";
import type { SessionNoticeError } from "../useSessionNoticeSnapshot";

const NOTICE_LABEL: Record<SessionNotice, string> = {
  waiting_for_input: "Needs input",
  waiting_for_approval: "Needs approval",
  failure: "Failed",
  unread_completion: "Completed",
};

function NoticeBadge({ notice }: { notice: SessionNotice }) {
  if (notice === "unread_completion") {
    return (
      <span className="statusdot statusdot-badge statusdot-completed">
        <IdleDot />
        {NOTICE_LABEL[notice]}
      </span>
    );
  }
  const state = notice === "failure" ? "failed" : notice;
  return (
    <span className={`statusdot statusdot-badge statusdot-${state}`}>
      <StateIcon state={state} />
      {NOTICE_LABEL[notice]}
    </span>
  );
}

export function NotificationsList({
  allRepos,
  activeRepo,
  rows,
  loaded,
  error,
  busy,
  onClear,
  onClearAll,
  onOpen,
  registerNav,
}: {
  allRepos: boolean;
  activeRepo: string;
  rows: SessionNoticeRow[];
  loaded: boolean;
  error: SessionNoticeError | null;
  busy: boolean;
  onClear: () => void | Promise<void>;
  onClearAll: () => void | Promise<void>;
  onOpen: (item: SessionListItem) => void;
  registerNav: (nav: BoardNav | null) => void;
}) {
  const [selectedKey, setSelectedKey] = useState("");
  const displayedRows = useMemo(() => (allRepos ? rows : rows.filter((row) => row.item.repo_path === activeRepo)), [activeRepo, allRepos, rows]);
  const rowsRef = useRef(displayedRows);
  rowsRef.current = displayedRows;

  useEffect(() => {
    if (displayedRows.length === 0) {
      setSelectedKey("");
      return;
    }
    if (!displayedRows.some((row) => sessionListItemKey(row.item) === selectedKey)) {
      setSelectedKey(sessionListItemKey(displayedRows[0].item));
    }
  }, [displayedRows, selectedKey]);

  useEffect(() => {
    const moveRow = (delta: number) => {
      const currentRows = rowsRef.current;
      if (currentRows.length === 0) return;
      const index = currentRows.findIndex((row) => sessionListItemKey(row.item) === selectedKey);
      const next = Math.max(0, Math.min(currentRows.length - 1, (index < 0 ? 0 : index) + delta));
      setSelectedKey(sessionListItemKey(currentRows[next].item));
    };
    const openSelected = () => {
      const selected = rowsRef.current.find((row) => sessionListItemKey(row.item) === selectedKey) ?? rowsRef.current[0];
      if (selected) onOpen(selected.item);
    };
    registerNav({ moveRow, moveCol: () => {}, openSelected, duplicateSelected: () => {}, archiveSelected: () => {} });
    return () => registerNav(null);
  }, [onOpen, registerNav, selectedKey]);

  if (!loaded) return <LoadingState label="Loading notifications" />;

  const actionsDisabled = busy || rows.length === 0;
  return (
    <div className="listwrap">
      <div className="listhead">
        <h1 className="view-title">Notifications</h1>
        <span className="dim">{displayedRows.length === 1 ? "1 notice" : `${displayedRows.length} notices`}</span>
        <div className="notification-actions">
          <button type="button" className="btn ghost small" disabled={actionsDisabled} onClick={() => void onClear()}>
            Clear
          </button>
          <button type="button" className="btn ghost small" disabled={actionsDisabled} onClick={() => void onClearAll()}>
            Clear all
          </button>
        </div>
      </div>
      {error && (
        <InlineStatus tone="error" detail={error.detail}>
          {error.source === "load" ? "Could not load notifications." : "Could not clear notifications."}
        </InlineStatus>
      )}
      {!error && displayedRows.length === 0 ? (
        <div className="list list-empty">
          <EmptyState title="No notifications" hint="Sessions waiting for you, failures, and unread completions appear here." />
        </div>
      ) : (
        <div className="list notification-list">
          {displayedRows.map(({ item, notice }) => {
            const key = sessionListItemKey(item);
            return (
              <button key={key} type="button" className={`row notification-row${key === selectedKey ? " sel" : ""}`} onClick={() => onOpen(item)}>
                <span className="notification-condition">
                  <NoticeBadge notice={notice} />
                </span>
                <span className="notification-identity">
                  <strong>{item.task_name}</strong>
                  <span className="mono">{item.id}</span>
                </span>
                <span className="notification-context">
                  <span>{item.playbook_title || item.playbook}</span>
                  <span>{item.step_title || item.phase || "Generic"}</span>
                  {allRepos && <span className="repochip">{repoName(item.repo_path)}</span>}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
