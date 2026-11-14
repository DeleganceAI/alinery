import { ArrowRight, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { confirmDanger } from "./confirm";
import { confirmRestartingOthers, otherStarter } from "./DaemonConflictBanner";
import { runtimeStatus, stopDaemon } from "./ipc";
import { parseRemoteRepo } from "./remoteRepo";
import { repoName } from "./shared";
import { toast } from "./toast";
import type { LinkTraffic, RepoRuntime, RuntimeStatus } from "./types";

const SAMPLE_MS = 1000;

/** Bytes per second, short. */
export function formatRate(bytesPerSecond: number): string {
  if (bytesPerSecond < 1024) return `${Math.round(bytesPerSecond)} B/s`;
  if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
}

/** The rate between two samples of one link's counters, `seconds` apart. */
export function linkRate(before: LinkTraffic | undefined, after: LinkTraffic, seconds: number) {
  if (!before || seconds <= 0) return null;
  return {
    ops: (after.calls - before.calls) / seconds,
    up: (after.bytes_up - before.bytes_up) / seconds,
    down: (after.bytes_down - before.bytes_down) / seconds,
  };
}

/** A daemon to offer an update for: built from another app release, or a different build of this one. */
export const daemonIsOld = (repo: RepoRuntime, appVersion: string) =>
  repo.state === "build_drift" || (!!repo.version && !!appVersion && repo.version !== appVersion) || repo.version === "";

type Link = { id: string; label: string; up: boolean; state: string; traffic: LinkTraffic; runtimeStale: boolean };

function links(status: RuntimeStatus): Link[] {
  return [
    { id: "local", label: "This computer", up: true, state: "up", traffic: status.local_link, runtimeStale: false },
    ...status.hosts.map((host) => ({
      id: host.host_id,
      label: host.label,
      up: host.state === "connected",
      state: host.state === "connected" ? "up" : host.state === "idle" ? "not connected" : host.state,
      traffic: host.link,
      runtimeStale: !!host.running && !!host.bundled && host.running !== host.bundled,
    })),
  ];
}

/** Who started a daemon, for its row: nothing when it is this person's own or the daemon does not say. */
export const starterNote = (repo: Pick<RepoRuntime, "started_by" | "os_user" | "mine">) =>
  repo.mine || !repo.started_by ? "" : `${repo.started_by}${repo.os_user ? ` (as ${repo.os_user})` : ""}`;

async function updateDaemon(repo: RepoRuntime) {
  const name = repoName(repo.repo);
  const ok = await confirmDanger(
    `Restart the daemon for ${name}?`,
    <p className="confirm-loss">It is replaced with this app's build. Any live sessions in this repository are stopped, and their in-flight work is lost.</p>,
    "Restart daemon",
  );
  if (!ok || !(await confirmRestartingOthers(otherStarter(repo), name))) return;
  await stopDaemon(repo.repo).then(
    () => toast.success(`Restarted the daemon for ${repoName(repo.repo)}`),
    (cause) => toast.error(`Couldn't restart the daemon for ${repoName(repo.repo)}: ${String(cause)}`),
  );
}

/**
 * The footer popover's sync links: one row per daemon host (this computer, then each ssh host) with whether the link is
 * up and its traffic rate, and under it each repository's daemon with the version it reports. Samples while mounted.
 */
export function SyncLinks({ appVersion, onOpenRepo }: { appVersion: string; onOpenRepo?: (repo: string) => void }) {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [rates, setRates] = useState<Record<string, ReturnType<typeof linkRate>>>({});
  const previous = useRef<{ at: number; links: Record<string, LinkTraffic> } | null>(null);

  useEffect(() => {
    let alive = true;
    const sample = () =>
      runtimeStatus()
        .then((next) => {
          if (!alive) return;
          const at = performance.now();
          const now = Object.fromEntries(links(next).map((link) => [link.id, link.traffic]));
          const last = previous.current;
          if (last) setRates(Object.fromEntries(Object.entries(now).map(([id, traffic]) => [id, linkRate(last.links[id], traffic, (at - last.at) / 1000)])));
          previous.current = { at, links: now };
          setStatus(next);
        })
        .catch(() => {});
    void sample();
    const timer = setInterval(sample, SAMPLE_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  if (!status) return <span className="dim">Reading sync links…</span>;
  return (
    <div className="sync-links">
      {links(status).map((link) => {
        const rate = rates[link.id];
        const repos = status.repos.filter((repo) => repo.host === link.id && repo.state !== "not_attached");
        // The host's other daemons: repositories this app has not opened, whoever started them.
        const others = (status.hosts.find((host) => host.host_id === link.id)?.daemons ?? []).filter(
          (daemon) => !repos.some((repo) => parseRemoteRepo(repo.repo)?.path === daemon.repo),
        );
        return (
          <div className="sync-link" key={link.id}>
            <div className="sync-link-head">
              <span className={`live ${link.up ? "ok" : "down"}`} aria-hidden="true" />
              <b>{link.label}</b>
              <span className="sync-link-state">{link.state}</span>
            </div>
            {link.up && (
              <div className="sync-link-rate" title="Calls and bytes through the sync link, per second">
                <span>{rate ? `${rate.ops.toFixed(rate.ops < 10 ? 1 : 0)} ops/s` : "– ops/s"}</span>
                <span>↑ {rate ? formatRate(rate.up) : "–"}</span>
                <span>↓ {rate ? formatRate(rate.down) : "–"}</span>
              </div>
            )}
            {link.runtimeStale && <div className="sync-link-note">Host runtime is older than this app's; reconnect to install the new one.</div>}
            {repos.map((repo) => {
              const conflict = repo.state === "conflict";
              const name = repoName(repo.repo);
              const starter = starterNote(repo);
              const title = [conflict && repo.issues.length ? repo.issues.join("\n") : repo.repo, starter && `Started by ${starter}`].filter(Boolean).join("\n");
              return (
                <div className="sync-link-repo" key={repo.repo} title={title}>
                  <span className="sync-link-repo-name">
                    {name}
                    {starter && <span className="sync-link-starter"> · {repo.started_by}</span>}
                  </span>
                  <span className="sync-link-version">
                    {conflict ? "conflict" : repo.version ? `v${repo.version}` : repo.version === "" ? "older daemon" : "…"}
                    {repo.state === "joined" && " · joined"}
                  </span>
                  {conflict
                    ? // The selected repo's banner holds the confirmed takeover (or a remote restart); stop_daemon cannot reach another lane's owner.
                      onOpenRepo && (
                        <button
                          type="button"
                          className="sync-link-update"
                          aria-label={`Open ${name} to resolve its daemon conflict`}
                          title="Open this repository to take over or join its daemon"
                          onClick={() => onOpenRepo(repo.repo)}
                        >
                          <ArrowRight size={11} strokeWidth={2} aria-hidden="true" />
                        </button>
                      )
                    : daemonIsOld(repo, appVersion) && (
                        <button
                          type="button"
                          className="sync-link-update"
                          aria-label={`Update the daemon for ${name}`}
                          title="Restart with this app's daemon"
                          onClick={() => void updateDaemon(repo)}
                        >
                          <RefreshCw size={11} strokeWidth={2} aria-hidden="true" />
                        </button>
                      )}
                </div>
              );
            })}
            {others.map((daemon) => (
              <div className="sync-link-repo sync-link-other" key={`${daemon.repo}\0${daemon.lane}`} title={`${daemon.repo}\nPID ${daemon.pid}`}>
                <span className="sync-link-repo-name">
                  {repoName(daemon.repo)}
                  <span className="sync-link-starter"> · {daemon.started_by || daemon.os_user || "someone"}</span>
                </span>
                <span className="sync-link-version">{daemon.version ? `v${daemon.version}` : "older daemon"}</span>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
