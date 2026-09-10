import { useEffect, useState } from "react";
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

// Poll daemon_status() on a 1.5s interval (mirrors StatusDot's cadence). Powers the
// footer's live mode/running readout (plan §6.2a).
export function useDaemonStatus(): DaemonStatus {
  const [status, setStatus] = useState<DaemonStatus>(OFFLINE);
  useEffect(() => {
    let alive = true;
    const tick = () =>
      ipc
        .daemonStatus()
        .then((s) => alive && setStatus(s))
        .catch(() => alive && setStatus(OFFLINE));
    tick();
    const t = setInterval(tick, 1500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return status;
}
