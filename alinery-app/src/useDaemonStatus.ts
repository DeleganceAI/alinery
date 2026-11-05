import { useCallback, useEffect, useRef, useState } from "react";
import { admin } from "./daemon/transport";
import * as ipc from "./ipc";
import type { DaemonStatus } from "./types";

const OFFLINE: DaemonStatus = {
  reachable: false,
  mode: "local",
  alive: 0,
  busy: 0,
  waiting_for_input: 0,
  waiting_for_approval: 0,
  idle: 0,
  unknown: 0,
  exited: 0,
  total: 0,
  extra_lanes: 0,
  stale_lanes: 0,
  repo: "",
  build_drift: false,
  conflict: null,
  repo_busy: false,
  host_guard_warning: false,
};

// What `Hello` reports once per repo open; null until it answers or when the daemon does not (the poll still runs).
export type DaemonHello = { protocol: number; buildId: string };
export type DaemonStatusHandle = DaemonStatus & { refresh: () => void; hello: DaemonHello | null };

// Each newer request supersedes older polls, including their failure responses.
export function useDaemonStatus(repo: string): DaemonStatusHandle {
  const [status, setStatus] = useState<DaemonStatus>(OFFLINE);
  const [hello, setHello] = useState<{ repo: string; hello: DaemonHello } | null>(null);
  const poll = useRef<() => void>(() => {});
  const refresh = useCallback(() => poll.current(), []);
  useEffect(() => {
    let alive = true;
    let generation = 0;
    const tick = () => {
      const request = ++generation;
      if (!repo) return;
      ipc
        .daemonStatus()
        .then((next) => {
          if (alive && request === generation && next.repo === repo) setStatus(next);
        })
        .catch(() => {
          if (alive && request === generation) setStatus({ ...OFFLINE, repo });
        });
    };
    setStatus({ ...OFFLINE, repo });
    if (repo) {
      Promise.resolve()
        .then(() => admin(repo).hello({}))
        .then((r) => alive && setHello({ repo, hello: { protocol: r.protocol, buildId: r.buildId } }))
        .catch(() => {});
    }
    poll.current = tick;
    tick();
    const timer = setInterval(tick, 1500);
    return () => {
      alive = false;
      poll.current = () => {};
      clearInterval(timer);
    };
  }, [repo]);
  return { ...(status.repo === repo ? status : { ...OFFLINE, repo }), refresh, hello: hello?.repo === repo ? hello.hello : null };
}
