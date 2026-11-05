import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as ipc from "./ipc";
import { applyNotificationClearProjection, filterSuppressedNoticeRows, notificationClearRefs, type SessionNoticeRow, sessionNoticeRows } from "./sessionAttention";
import { useSessionObservations } from "./sync/sessionObservation";
import type { SessionListItem, SessionObservation } from "./types";

const REFRESH_DELAY_MS = 5_000;
export type SessionNoticeError = {
  source: "load" | "clear";
  detail: string;
};

type SnapshotData = {
  items: SessionListItem[];
  loaded: boolean;
  error: SessionNoticeError | null;
  clearing: boolean;
};

export type SessionNoticeSnapshot = SnapshotData & {
  observations: Record<string, SessionObservation>;
  rows: SessionNoticeRow[];
  requestRefresh: () => void;
  clear: () => Promise<void>;
  clearAll: () => Promise<void>;
};

const EMPTY_SNAPSHOT: SnapshotData = {
  items: [],
  loaded: false,
  error: null,
  clearing: false,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function currentRows(items: SessionListItem[], observations: Record<string, SessionObservation>): SessionNoticeRow[] {
  return filterSuppressedNoticeRows(sessionNoticeRows(items, observations), observations);
}

export function useSessionNoticeSnapshot(enabled = true): SessionNoticeSnapshot {
  const [snapshot, setSnapshot] = useState<SnapshotData>(EMPTY_SNAPSHOT);
  // Status is live from the daemons' streams; only the item list is fetched (and refetched).
  const statusRefs = useMemo(() => snapshot.items.map((item) => ({ repo_path: item.repo_path, task_slug: item.task_slug, id: item.id })), [snapshot.items]);
  const observations = useSessionObservations(statusRefs, enabled);
  const rows = useMemo(() => currentRows(snapshot.items, observations), [snapshot.items, observations]);
  const liveRef = useRef({ rows, observations });
  liveRef.current = { rows, observations };
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const queued = useRef(false);
  const clearing = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const runRefresh = useRef<() => void>(() => undefined);

  const requestRefresh = useCallback(() => {
    if (inFlight.current) {
      queued.current = true;
      return;
    }
    runRefresh.current();
  }, []);

  runRefresh.current = () => {
    if (!mounted.current || !enabledRef.current || inFlight.current) return;
    if (timer.current !== undefined) {
      window.clearTimeout(timer.current);
      timer.current = undefined;
    }
    inFlight.current = true;
    void (async () => {
      try {
        const items = await ipc.listSessionItems(true, false);
        if (mounted.current && enabledRef.current) {
          setSnapshot((previous) => ({
            items,
            loaded: true,
            error: null,
            clearing: previous.clearing,
          }));
        }
      } catch (itemError) {
        if (mounted.current && enabledRef.current) {
          setSnapshot((previous) => ({
            items: [],
            loaded: true,
            error: { source: "load", detail: errorMessage(itemError) },
            clearing: previous.clearing,
          }));
        }
      } finally {
        inFlight.current = false;
        if (mounted.current && enabledRef.current) {
          if (queued.current) {
            queued.current = false;
            runRefresh.current();
          } else {
            timer.current = window.setTimeout(requestRefresh, REFRESH_DELAY_MS);
          }
        }
      }
    })();
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      queued.current = false;
      window.clearTimeout(timer.current);
    };
  }, []);

  useEffect(() => {
    if (enabled) {
      requestRefresh();
      return;
    }
    queued.current = false;
    window.clearTimeout(timer.current);
    timer.current = undefined;
    setSnapshot({ ...EMPTY_SNAPSHOT, loaded: true });
  }, [enabled, requestRefresh]);

  const runClear = useCallback(
    async (suppressLive: boolean) => {
      if (clearing.current) return;
      const current = liveRef.current;
      if (current.rows.length === 0) return;
      clearing.current = true;
      setSnapshot((previous) => ({ ...previous, clearing: true }));
      try {
        await ipc.clearSessionNotifications(notificationClearRefs(current.rows, current.observations, suppressLive));
        if (!mounted.current) return;
        setSnapshot((previous) => {
          return { ...previous, items: applyNotificationClearProjection(previous.items, current.rows, current.observations, suppressLive), error: null };
        });
        requestRefresh();
      } catch (clearError) {
        if (mounted.current) setSnapshot((previous) => ({ ...previous, error: { source: "clear", detail: errorMessage(clearError) } }));
      } finally {
        clearing.current = false;
        if (mounted.current) setSnapshot((previous) => ({ ...previous, clearing: false }));
      }
    },
    [requestRefresh],
  );

  const clear = useCallback(() => runClear(false), [runClear]);
  const clearAll = useCallback(() => runClear(true), [runClear]);

  return { ...snapshot, observations, rows, requestRefresh, clear, clearAll };
}
