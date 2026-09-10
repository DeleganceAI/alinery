import { useCallback, useEffect, useState } from "react";
import * as ipc from "./ipc";
import type { OmpUpdateStatus } from "./types";

export const NO_OMP_UPDATE: OmpUpdateStatus = { installed: "", available: null, checked_at: 0, binary_path: "", config_dir: "" };

const FIRST_CHECK_DELAY_MS = 30_000;
const RECHECK_INTERVAL_MS = 60 * 60 * 1000;

let shared: OmpUpdateStatus = NO_OMP_UPDATE;
const listeners = new Set<(status: OmpUpdateStatus) => void>();

function publish(status: OmpUpdateStatus) {
  shared = status;
  for (const listener of listeners) listener(status);
}

// Same cadence as useUpdateStatus, but not gated on production identity: the
// alongside OMP binary is one global install in dev and prod.
//
// App (TopBar) and Settings each mount this hook. Status is process-wide so a
// Settings checkNow / clearOffer also drops the toolbar Package button.
export function useOmpUpdateStatus(): {
  status: OmpUpdateStatus;
  checking: boolean;
  checkNow: () => Promise<OmpUpdateStatus>;
  clearOffer: () => void;
} {
  const [status, setStatus] = useState<OmpUpdateStatus>(shared);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    listeners.add(setStatus);
    setStatus(shared);
    return () => {
      listeners.delete(setStatus);
      if (listeners.size === 0) shared = NO_OMP_UPDATE;
    };
  }, []);

  const checkNow = useCallback(() => {
    setChecking(true);
    return ipc
      .checkOmpUpdate()
      .catch(() => NO_OMP_UPDATE)
      .then((next) => {
        publish(next);
        return next;
      })
      .finally(() => setChecking(false));
  }, []);

  const clearOffer = useCallback(() => {
    if (shared.available) publish({ ...shared, available: null });
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = () =>
      ipc
        .checkOmpUpdate()
        .catch(() => NO_OMP_UPDATE)
        .then((next) => {
          if (alive) publish(next);
        });
    const first = setTimeout(tick, FIRST_CHECK_DELAY_MS);
    const recurring = setInterval(tick, RECHECK_INTERVAL_MS);
    return () => {
      alive = false;
      clearTimeout(first);
      clearInterval(recurring);
    };
  }, []);

  return { status, checking, checkNow, clearOffer };
}
