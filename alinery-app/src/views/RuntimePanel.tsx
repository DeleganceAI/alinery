import { useEffect, useState } from "react";
import * as ipc from "../ipc";
import { machineOf } from "../remoteRepo";
import { repoName } from "../shared";
import { useLiveSessionsByRepo } from "../sync/hooks";
import type { RepoRuntime, RuntimeStatus } from "../types";
import { type McpStatusHandle, mcpStatusLabel } from "../useMcpStatus";

const REPO_STATE: Record<RepoRuntime["state"], string> = {
  current: "Current",
  build_drift: "Other build (usable)",
  conflict: "Needs a restart",
  not_attached: "Not running",
};

const short = (hash: string | null) => (hash ? hash.slice(0, 8) : "—");

/** Read-only view of what runs where. Loaded on open and on Refresh only: the shell answers from memory, never over ssh. */
export function RuntimePanel({ mcp }: { mcp: McpStatusHandle }) {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const load = () =>
    ipc.runtimeStatus().then(
      (next) => {
        setStatus(next);
        setFailed(false);
      },
      () => setFailed(true),
    );
  // biome-ignore lint/correctness/useExhaustiveDependencies: load once on open; Refresh reloads
  useEffect(() => {
    void load();
  }, []);
  const attached = status?.repos.filter((repo) => repo.state === "current" || repo.state === "build_drift").map((repo) => repo.repo) ?? [];
  const live = useLiveSessionsByRepo(attached);

  return (
    <section className="settings-nested" aria-labelledby="runtime-title">
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <h3 id="runtime-title">Runtime</h3>
        <button
          type="button"
          className="btn ghost small"
          onClick={() => {
            void load();
            mcp.refresh();
          }}
        >
          Refresh
        </button>
      </div>
      {failed && <div className="dim">Could not read the runtime status.</div>}
      {status && (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <tbody>
            {status.hosts.map((host) => {
              const stale = host.running !== null && host.bundled !== null && host.running !== host.bundled;
              return (
                <tr key={`host:${host.host_id}`}>
                  <td>{host.label}</td>
                  <td className="dim">host · {host.state}</td>
                  <td className="mono dim">
                    {short(host.running)}
                    {stale && ` → ${short(host.bundled)}`}
                  </td>
                  <td>{stale ? "Stale: restarting a daemon on this host installs the new runtime" : host.running ? "Current" : ""}</td>
                </tr>
              );
            })}
            {status.repos.map((repo) => (
              <tr key={`repo:${repo.repo}`}>
                <td title={repo.repo}>{repoName(repo.repo)}</td>
                <td className="dim">daemon · {machineOf(repo.repo) || "this computer"}</td>
                <td className="dim">{repo.repo in live ? `${live[repo.repo]} live` : ""}</td>
                <td title={repo.issues.join("\n") || undefined}>{REPO_STATE[repo.state]}</td>
              </tr>
            ))}
            <tr>
              <td>MCP</td>
              <td className="dim">managed · {mcp.repo ? repoName(mcp.repo) : "no repo"}</td>
              <td />
              <td>{mcpStatusLabel(mcp)}</td>
            </tr>
          </tbody>
        </table>
      )}
    </section>
  );
}
