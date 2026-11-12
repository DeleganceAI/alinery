import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { confirmDanger } from "./confirm";
import { runtimeStatus, stopDaemon } from "./ipc";
import { repoName } from "./shared";
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

async function updateDaemon(repo: RepoRuntime) {
  const ok = await confirmDanger(
    `Restart the daemon for ${repoName(repo.repo)}?`,
    <p className="confirm-loss">It is replaced with this app's build. Any live sessions in this repository are stopped, and their in-flight work is lost.</p>,
    "Restart daemon",
  );
  if (ok) await stopDaemon(repo.repo).catch(() => {});
}

/**
 * The footer popover's sync links: one row per daemon host (this computer, then each ssh host) with whether the link is
 * up and its traffic rate, and under it each repository's daemon with the version it reports. Samples while mounted.
 */
export function SyncLinks({ appVersion }: { appVersion: string }) {
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
            {repos.map((repo) => (
              <div className="sync-link-repo" key={repo.repo} title={repo.repo}>
                <span className="sync-link-repo-name">{repoName(repo.repo)}</span>
                <span className="sync-link-version">{repo.state === "conflict" ? "conflict" : repo.version ? `v${repo.version}` : repo.version === "" ? "older daemon" : "…"}</span>
                {daemonIsOld(repo, appVersion) && (
                  <button
                    type="button"
                    className="sync-link-update"
                    aria-label={`Update the daemon for ${repoName(repo.repo)}`}
                    title="Restart with this app's daemon"
                    onClick={() => void updateDaemon(repo)}
                  >
                    <RefreshCw size={11} strokeWidth={2} aria-hidden="true" />
                  </button>
                )}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
