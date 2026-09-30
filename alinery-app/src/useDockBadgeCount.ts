import { useEffect, useMemo, useRef } from "react";
import * as ipc from "./ipc";
import type { SessionNoticeRow } from "./sessionAttention";
import type { NotificationPrefs } from "./types";

const BADGE_RETRY_DELAY_MS = 5_000;

const BADGE_PREF_BY_NOTICE: Record<SessionNoticeRow["notice"], keyof NotificationPrefs> = {
  waiting_for_input: "dock_badge_input_waits",
  waiting_for_approval: "dock_badge_approval_waits",
  failure: "dock_badge_failures",
  interrupted: "dock_badge_interruptions",
  unread_completion: "dock_badge_completions",
};

export function dockBadgeCount(rows: ReadonlyArray<SessionNoticeRow>, prefs: NotificationPrefs): number {
  if (!prefs.enabled || !prefs.dock_badge) return 0;
  return rows.reduce((count, row) => count + (prefs[BADGE_PREF_BY_NOTICE[row.notice]] ? 1 : 0), 0);
}

export function useDockBadgeCount(rows: ReadonlyArray<SessionNoticeRow>, prefs: NotificationPrefs | undefined, loaded: boolean): void {
  const count = useMemo(() => (prefs ? dockBadgeCount(rows, prefs) : 0), [rows, prefs]);
  const desired = useRef(0);
  const delivered = useRef<number | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(false);
  const retryTimer = useRef<number | undefined>(undefined);
  const publish = useRef<() => void>(() => undefined);

  publish.current = () => {
    if (!mounted.current || inFlight.current) return;
    if (retryTimer.current !== undefined) {
      window.clearTimeout(retryTimer.current);
      retryTimer.current = undefined;
    }
    if (desired.current === delivered.current) return;

    const sending = desired.current;
    inFlight.current = true;
    void (async () => {
      let succeeded = false;
      try {
        await ipc.setDockBadgeCount(sending);
        succeeded = true;
      } catch {
        // A failed unchanged value is retried below.
      }

      inFlight.current = false;
      if (!mounted.current) return;
      if (succeeded) delivered.current = sending;
      if (desired.current === delivered.current) return;
      if (desired.current !== sending) {
        publish.current();
        return;
      }
      retryTimer.current = window.setTimeout(publish.current, BADGE_RETRY_DELAY_MS);
    })();
  };

  useEffect(() => {
    mounted.current = true;
    desired.current = 0;
    publish.current();
    return () => {
      mounted.current = false;
      if (retryTimer.current !== undefined) window.clearTimeout(retryTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!loaded) return;
    desired.current = count;
    publish.current();
  }, [count, loaded]);
}
