import { useCallback, useEffect, useState } from "react";
import { admin } from "./daemon/transport";
import * as ipc from "./ipc";
import { DAEMON_STATUS_KEY, REPO_SCOPE, useEntity, useLink, useScope } from "./sync/hooks";
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

// What `Hello` reports once per repo open; null until it answers or when the daemon does not .
export type DaemonHello = { protocol: number; buildId: string };
export type DaemonStatusHandle = DaemonStatus & { refresh: () => void; hello: DaemonHello | null };

// The daemon's half (live count, agent counts) arrives on the `daemon/_/status` entity and `reachable`
// comes from the replica's run loop, so neither needs a timer. The shell's half (build drift, conflict,
// repo busy, host guard) stays on its command until P5; it is read when the repo opens, on `refresh`, when
// the link flips and when the window regains focus, and each newer request supersedes older ones.
export function useDaemonStatus(repo: string): DaemonStatusHandle {
  const replica = useScope(repo, REPO_SCOPE);
  const { reachable } = useLink(replica);
  const live = useEntity(replica, DAEMON_STATUS_KEY);
  const [shell, setShell] = useState<DaemonStatus>(OFFLINE);
  const [hello, setHello] = useState<{ repo: string; hello: DaemonHello } | null>(null);
  const [nudge, setNudge] = useState(0);
  const refresh = useCallback(() => setNudge((n) => n + 1), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: nudge and reachable only re-trigger the read
  useEffect(() => {
    if (!repo) return setShell(OFFLINE);
    let alive = true;
    let generation = 0;
    const read = () => {
      const request = ++generation;
      ipc
        .daemonStatus()
        .then((next) => {
          if (alive && request === generation && next.repo === repo) setShell(next);
        })
        .catch(() => {
          if (alive && request === generation) setShell({ ...OFFLINE, repo });
        });
    };
    read();
    window.addEventListener("focus", read);
    return () => {
      alive = false;
      window.removeEventListener("focus", read);
    };
  }, [repo, reachable, nudge]);
  useEffect(() => {
    if (!repo) return;
    let alive = true;
    setHello(null);
    Promise.resolve()
      .then(() => admin(repo).hello({}))
      .then((r) => alive && setHello({ repo, hello: { protocol: r.protocol, buildId: r.buildId } }))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [repo]);
  const d = live?.value.case === "daemonStatus" ? live.value.value : undefined;
  const base = shell.repo === repo ? shell : { ...OFFLINE, repo };
  return {
    ...base,
    reachable,
    alive: d?.liveSessions ?? 0,
    busy: d?.busy ?? 0,
    waiting_for_input: d?.waitingForInput ?? 0,
    waiting_for_approval: d?.waitingForApproval ?? 0,
    // The entity carries no idle/unknown/exited/total; nothing reads them.
    idle: 0,
    unknown: 0,
    exited: 0,
    total: d?.liveSessions ?? 0,
    refresh,
    hello: hello?.repo === repo ? hello.hello : null,
  };
}
