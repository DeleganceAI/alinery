import { Eye, EyeOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { executionLineage } from "./executionLineage";
import type { SessionDisplayMeta, TaskExecutionState } from "./types";

type Visit = {
  scope: string;
  sessionId: string;
  readingHistory: boolean;
  executionId?: string;
  opening?: { sessionId: string; executionId: string };
};

/** Shared by the session page and a task's tabs so opening a successor carries the eye with it. */
export function useSessionFollow() {
  const visit = useRef<Visit | null>(null);
  const [enabled, setEnabled] = useState(true);
  const pause = useCallback(() => {
    if (visit.current) {
      delete visit.current.executionId;
      delete visit.current.opening;
    }
    setEnabled(false);
  }, []);
  return useMemo(() => ({ visit, enabled, setEnabled, pause }), [enabled, pause]);
}

export type SessionFollow = ReturnType<typeof useSessionFollow>;

type Props = {
  follow?: SessionFollow;
  scope: string;
  sessionId: string;
  active: boolean;
  readingHistory?: boolean;
  state?: TaskExecutionState;
  sessions: readonly SessionDisplayMeta[];
  onOpenSession?: (session: SessionDisplayMeta) => void;
};

export function useFollowNextSessionControl({ follow, scope, sessionId, active, readingHistory = false, state, sessions, onOpenSession }: Props) {
  const visit = follow?.visit;
  const source = Object.values(state?.executions ?? {}).find((record) => record.owner_session_id === sessionId);

  useEffect(() => {
    if (!active || !visit) return;
    return () => {
      // Returning to a tab that completed while we were away is a visit to history.
      if (visit.current?.scope === scope && visit.current.sessionId === sessionId) delete visit.current.executionId;
    };
  }, [active, scope, sessionId, visit]);

  useEffect(() => {
    if (!active || !follow) return;
    const { visit, enabled, setEnabled, pause } = follow;
    const prior = visit.current;
    const newScope = prior?.scope !== scope;
    if (!prior || newScope) {
      visit.current = { scope, sessionId, readingHistory };
      setEnabled(true);
    } else if (prior.sessionId !== sessionId) {
      const arriving = prior.opening?.sessionId === sessionId ? prior.opening : undefined;
      visit.current = { scope, sessionId, readingHistory, executionId: arriving?.executionId };
      if (!arriving) {
        pause();
        return;
      }
    } else if (prior.readingHistory !== readingHistory) {
      prior.readingHistory = readingHistory;
      if (readingHistory) {
        pause();
        return;
      }
    }
    const current = visit.current;
    if (!current || current.opening || !(newScope || enabled) || !state || state.history_only || !source || !onOpenSession) return;
    if (!current.executionId) {
      if (readingHistory || source.lifecycle === "completed") {
        pause();
        return;
      }
      if (source.lifecycle !== "running" && source.lifecycle !== "finishing") return;
      current.executionId = source.id;
    }
    if (current.executionId !== source.id || source.lifecycle !== "completed" || !source.receipt_id || !source.shutdown_confirmed) return;
    const { successors } = executionLineage(state, source);
    if (successors.length !== 1) return;
    const next = successors[0];
    if (next.lifecycle !== "running" && next.lifecycle !== "finishing" && next.lifecycle !== "completed") return;
    const owner = sessions.find((s) => s.id === next.owner_session_id && s.execution_id === next.id && !s.archived && s.started_at != null);
    if (!owner?.worktree || owner.id === sessionId) return;
    // Record the request before navigation. Repeated deltas and already-finished successors are both possible.
    current.opening = { sessionId: owner.id, executionId: next.id };
    onOpenSession(owner);
  }, [active, follow, onOpenSession, readingHistory, scope, sessionId, sessions, source, state]);

  if (!active || !follow || !source || state?.history_only) return null;
  const { enabled, setEnabled, pause } = follow;
  return (
    <button
      type="button"
      className={`btn ghost small${enabled ? " on" : ""}`}
      aria-label="Follow next session"
      aria-pressed={enabled}
      title={enabled ? "Following the next session. Click to stay here." : "Open the next session when a single successor starts."}
      disabled={!onOpenSession}
      onClick={() => {
        if (enabled) pause();
        else {
          follow.visit.current = { scope, sessionId, readingHistory, executionId: source.id };
          setEnabled(true);
        }
      }}
    >
      {enabled ? <Eye size={16} aria-hidden="true" /> : <EyeOff size={16} aria-hidden="true" />}
    </button>
  );
}
