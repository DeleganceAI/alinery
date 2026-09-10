import { useCallback, useEffect, useState } from "react";
import * as ipc from "./ipc";
import type { UpdateStatus } from "./types";

// Fail-safe constant, same idiom as useDaemonStatus's OFFLINE: a check that never ran
// and a check that failed look identical to the caller — no update on offer.
export const NO_UPDATE: UpdateStatus = { current: "", available: null, checked_at: 0 };

const FIRST_CHECK_DELAY_MS = 30_000;
const RECHECK_INTERVAL_MS = 60 * 60 * 1000;

// Polls check_update() on a slow cadence — once shortly after launch, then every hour
// — and never renders a failure: check_update() itself never rejects (backend
// contract), but a transport-level rejection still falls back to NO_UPDATE rather than
// surfacing a toast or console noise, matching useDaemonStatus's silent-degrade shape.
//
// `opts.enabled === false` (dev builds) never calls the backend at all: the check is
// also refused server-side for any non-production app identity, but the frontend
// should not even ask, so a dev build can never be seen polling for an update it will
// always be refused.
export function useUpdateStatus(opts?: { enabled?: boolean }): {
  status: UpdateStatus;
  checking: boolean;
  checkNow: () => Promise<UpdateStatus>;
  clearOffer: () => void;
} {
  const enabled = opts?.enabled !== false;
  const [status, setStatus] = useState<UpdateStatus>(NO_UPDATE);
  const [checking, setChecking] = useState(false);

  const checkNow = useCallback(() => {
    setChecking(true);
    return ipc
      .checkUpdate()
      .catch(() => NO_UPDATE)
      .then((s) => {
        setStatus(s);
        return s;
      })
      .finally(() => setChecking(false));
  }, []);

  const clearOffer = useCallback(() => setStatus((s) => (s.available ? { ...s, available: null } : s)), []);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const tick = () =>
      ipc
        .checkUpdate()
        .catch(() => NO_UPDATE)
        .then((s) => alive && setStatus(s));
    const first = setTimeout(tick, FIRST_CHECK_DELAY_MS);
    const recurring = setInterval(tick, RECHECK_INTERVAL_MS);
    return () => {
      alive = false;
      clearTimeout(first);
      clearInterval(recurring);
    };
  }, [enabled]);

  return { status, checking, checkNow, clearOffer };
}
