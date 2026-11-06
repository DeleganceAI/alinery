import { useCallback, useMemo, useRef, useState } from "react";
import * as ipc from "./ipc";
import { filterSuppressedNoticeRows, notificationClearRefs, type SessionNoticeRow, sessionNoticeRows } from "./sessionAttention";
import { useSessionItems } from "./sync/board";
import { useSessionObservations } from "./sync/sessionObservation";
import type { SessionListItem, SessionObservation } from "./types";

export type SessionNoticeError = {
  source: "load" | "clear";
  detail: string;
};

export type SessionNoticeSnapshot = {
  items: SessionListItem[];
  loaded: boolean;
  error: SessionNoticeError | null;
  clearing: boolean;
  observations: Record<string, SessionObservation>;
  rows: SessionNoticeRow[];
  clear: () => Promise<void>;
  clearAll: () => Promise<void>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function currentRows(items: SessionListItem[], observations: Record<string, SessionObservation>): SessionNoticeRow[] {
  return filterSuppressedNoticeRows(sessionNoticeRows(items, observations), observations);
}

/**
 * Notice rows for every repo in `repos`. Items and status both arrive on the daemons' streams, so a
 * clear needs no refresh: the daemon rewrites the session and the stream carries the result back.
 */
export function useSessionNoticeSnapshot(repos: string[], enabled = true): SessionNoticeSnapshot {
  const { items, loaded } = useSessionItems(repos, false, enabled);
  const statusRefs = useMemo(() => items.map((item) => ({ repo_path: item.repo_path, task_slug: item.task_slug, id: item.id })), [items]);
  const observations = useSessionObservations(statusRefs, enabled);
  const rows = useMemo(() => currentRows(items, observations), [items, observations]);
  const liveRef = useRef({ rows, observations });
  liveRef.current = { rows, observations };
  const clearing = useRef(false);
  const [state, setState] = useState<{ clearing: boolean; error: SessionNoticeError | null }>({ clearing: false, error: null });

  const runClear = useCallback(async (suppressLive: boolean) => {
    if (clearing.current) return;
    const current = liveRef.current;
    if (current.rows.length === 0) return;
    clearing.current = true;
    setState((previous) => ({ ...previous, clearing: true }));
    try {
      await ipc.clearSessionNotifications(notificationClearRefs(current.rows, current.observations, suppressLive));
      setState({ clearing: false, error: null });
    } catch (clearError) {
      setState({ clearing: false, error: { source: "clear", detail: errorMessage(clearError) } });
    } finally {
      clearing.current = false;
    }
  }, []);

  const clear = useCallback(() => runClear(false), [runClear]);
  const clearAll = useCallback(() => runClear(true), [runClear]);

  return { items, loaded: enabled ? loaded : true, error: state.error, clearing: state.clearing, observations, rows, clear, clearAll };
}
