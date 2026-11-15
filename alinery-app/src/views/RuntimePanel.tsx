import { Fragment, useEffect, useState } from "react";
import { askConfirm } from "../confirm";
import * as ipc from "../ipc";
import { isRemoteRepo, machineOf } from "../remoteRepo";
import { updateDaemon } from "../SyncLinks";
import { repoName } from "../shared";
import { type OfficeTools, readOfficeTools } from "../sync/agent";
import { useLiveSessionsByRepo } from "../sync/hooks";
import { toast } from "../toast";
import type { HostRuntime, RepoRuntime, RuntimeStatus } from "../types";
import { type McpStatusHandle, mcpStatusLabel } from "../useMcpStatus";

const REPO_STATE: Record<RepoRuntime["state"], string> = {
  current: "Current",
  build_drift: "Other build (usable)",
  joined: "Joined (started by someone else)",
  conflict: "Needs a restart",
  not_attached: "Not running",
};

export const LIBREOFFICE_URL = "https://www.libreoffice.org/download/download-libreoffice/";
const short = (hash: string | null) => (hash ? hash.slice(0, 8) : "—");

/** One line on what the office skills will find: the Python, then LibreOffice and the PDF tools. */
export function officeSummary(office: OfficeTools): string {
  const found = (name: string) => office.tools.some((tool) => tool.name === name && tool.path);
  const python = office.bundledPython ? "Python bundled" : found("python3") ? "Python from this machine (not the bundled one)" : "No Python";
  const missing = ["soffice", "pdftoppm", "qpdf"].filter((name) => !found(name)).map((name) => (name === "soffice" ? "LibreOffice" : name));
  return missing.length ? `${python} · missing ${missing.join(", ")}` : `${python} · LibreOffice, pdftoppm and qpdf found`;
}

/** A daemon this panel can restart: one that runs, and not this computer's conflicted one (its takeover is on the repo's banner). */
export const canRestart = (repo: RepoRuntime) => repo.state !== "not_attached" && (repo.state !== "conflict" || isRemoteRepo(repo.repo));

/** Reconnecting installs the bundled runtime and a new repo service from it; running daemons are reused, never stopped. */
export async function updateHost(host: HostRuntime): Promise<boolean> {
  const answer = await askConfirm({
    title: `Install the new runtime on ${host.label}?`,
    body: (
      <p>Alinery reconnects to {host.label} and installs this app's runtime there. Running daemons and their sessions keep going on the old runtime until each one is restarted.</p>
    ),
    choices: [
      { key: "confirm", label: "Reconnect and install" },
      { key: "cancel", label: "Cancel", tone: "ghost" },
    ],
    defaultKey: "cancel",
  });
  if (answer !== "confirm") return false;
  await ipc.remoteConnect(host.host_id, false).then(
    () => toast.success(`Installed the new runtime on ${host.label}`),
    (cause: unknown) => toast.error(`Couldn't update ${host.label}: ${String(cause)}`),
  );
  return true;
}

/** What runs where, with a restart per daemon and an update per stale host. Loaded on open and on Refresh only: the shell answers from memory, never over ssh. */
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
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (key: string, run: () => Promise<boolean>) => {
    setBusy(key);
    try {
      if (await run()) await load();
    } finally {
      setBusy(null);
    }
  };
  const [office, setOffice] = useState<Record<string, OfficeTools>>({});
  const attachedKey = attached.join("\n");
  // biome-ignore lint/correctness/useExhaustiveDependencies: reread when the attached daemons change (open and Refresh)
  useEffect(() => {
    for (const repo of attached)
      readOfficeTools(repo).then(
        (tools) => setOffice((all) => ({ ...all, [repo]: tools })),
        () => {},
      );
  }, [attachedKey, status]);

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
                  <td>
                    {stale && host.state === "connected" && (
                      <button type="button" className="btn ghost small" disabled={busy !== null} onClick={() => void act(`host:${host.host_id}`, () => updateHost(host))}>
                        Update host…
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {status.repos.map((repo) => (
              <Fragment key={`repo:${repo.repo}`}>
                <tr>
                  <td title={repo.repo}>{repoName(repo.repo)}</td>
                  <td className="dim">daemon · {machineOf(repo.repo) || "this computer"}</td>
                  <td className="dim">{repo.repo in live ? `${live[repo.repo]} live` : ""}</td>
                  <td title={repo.issues.join("\n") || undefined}>{REPO_STATE[repo.state]}</td>
                  <td>
                    {canRestart(repo) && (
                      <button
                        type="button"
                        className="btn ghost small"
                        aria-label={`Restart the daemon for ${repoName(repo.repo)}`}
                        disabled={busy !== null}
                        onClick={() => void act(`repo:${repo.repo}`, () => updateDaemon(repo, live[repo.repo]))}
                      >
                        Restart…
                      </button>
                    )}
                  </td>
                </tr>
                {office[repo.repo] && (
                  <tr>
                    <td />
                    <td className="dim">office tools</td>
                    <td colSpan={3} title={office[repo.repo].tools.map((tool) => `${tool.name}: ${tool.path || "not found"}`).join("\n")}>
                      {officeSummary(office[repo.repo])}
                      {!office[repo.repo].tools.some((tool) => tool.name === "soffice" && tool.path) && (
                        <>
                          {" · "}
                          <a
                            href={LIBREOFFICE_URL}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(event) => {
                              event.preventDefault();
                              void ipc.openUrl(LIBREOFFICE_URL).catch((cause: unknown) => toast(String(cause), "error"));
                            }}
                          >
                            Get LibreOffice
                          </a>
                        </>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            <tr>
              <td>MCP</td>
              <td className="dim">managed · {mcp.repo ? repoName(mcp.repo) : "no repo"}</td>
              <td />
              <td>{mcpStatusLabel(mcp)}</td>
              <td />
            </tr>
          </tbody>
        </table>
      )}
    </section>
  );
}
