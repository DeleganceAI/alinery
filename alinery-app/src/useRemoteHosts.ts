import { useCallback, useEffect, useRef, useState } from "react";
import * as ipc from "./ipc";
import type { RemoteHostView } from "./types";

/** Connection state of every configured SSH host, polled like the daemon status. */
export function useRemoteHosts(enabled: boolean, intervalMs = 3000) {
  const [hosts, setHosts] = useState<RemoteHostView[]>([]);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const next = await ipc.remoteHosts();
      if (mine === generation.current) setHosts(next);
    } catch {
      // The list stays as it was; the next tick retries.
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const timer = setInterval(() => void refresh(), intervalMs);
    return () => clearInterval(timer);
  }, [enabled, intervalMs, refresh]);

  return { hosts, refresh };
}
