import { useCallback, useEffect, useRef, useState } from "react";
import * as ipc from "./ipc";
import { applyNotificationClearProjection, filterSuppressedNoticeRows, notificationClearRefs, type SessionNoticeRow, sessionNoticeRows } from "./sessionAttention";
import type { SessionListItem, SessionObservation, SessionStatusRef } from "./types";

const REFRESH_DELAY_MS = 5_000;
export type SessionNoticeError = {
  source: "load" | "clear";
  detail: string;
};

type SnapshotData = {
  items: SessionListItem[];
  observations: Record<string, SessionObservation>;
  rows: SessionNoticeRow[];
  loaded: boolean;
  error: SessionNoticeError | null;
  clearing: boolean;
};

export type SessionNoticeSnapshot = SnapshotData & {
  requestRefresh: () => void;
  clear: () => Promise<void>;
  clearAll: () => Promise<void>;
};

const EMPTY_SNAPSHOT: SnapshotData = {
  items: [],
  observations: {},
  rows: [],
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
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
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
        const refs: SessionStatusRef[] = items.map((item) => ({ repo_path: item.repo_path, task_slug: item.task_slug, id: item.id }));
        let observations: Record<string, SessionObservation> = {};
        let error: SessionNoticeError | null = null;
        try {
          observations = await ipc.sessionListStatuses(refs);
        } catch (statusError) {
          error = { source: "load", detail: errorMessage(statusError) };
        }
        if (mounted.current && enabledRef.current) {
          setSnapshot((previous) => ({
            items,
            observations,
            rows: currentRows(items, observations),
            loaded: true,
            error,
            clearing: previous.clearing,
          }));
        }
      } catch (itemError) {
        if (mounted.current && enabledRef.current) {
          setSnapshot((previous) => ({
            items: [],
            observations: {},
            rows: [],
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
      const current = snapshotRef.current;
      if (current.rows.length === 0) return;
      clearing.current = true;
      setSnapshot((previous) => ({ ...previous, clearing: true }));
      try {
        await ipc.clearSessionNotifications(notificationClearRefs(current.rows, current.observations, suppressLive));
        if (!mounted.current) return;
        setSnapshot((previous) => {
          const items = applyNotificationClearProjection(previous.items, previous.rows, previous.observations, suppressLive);
          return {
            ...previous,
            items,
            rows: currentRows(items, previous.observations),
            error: null,
          };
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

  return { ...snapshot, requestRefresh, clear, clearAll };
}
