import { Fragment, useEffect, useState } from "react";
import { copyTextToClipboard } from "../chat/CopyMessage";
import { askConfirm, confirmDanger } from "../confirm";
import { backUpAndReset } from "../DaemonConflictBanner";
import * as ipc from "../ipc";
import { isRemoteRepo } from "../remoteRepo";
import { updateDaemon } from "../SyncLinks";
import { repoName } from "../shared";
import { type OfficeTools, readOfficeTools } from "../sync/agent";
import { useLiveSessionsByRepo } from "../sync/hooks";
import { McpState, type McpStatus, machineMcpStatus, machineMcpToken, restartMachineMcp, setMachineMcpHttp } from "../sync/mcp";
import { toast } from "../toast";
import type { HostRuntime, RepoRuntime, RuntimeStatus } from "../types";

const REPO_STATE: Record<RepoRuntime["state"], string> = {
  current: "Current",
  build_drift: "Other build (usable)",
  joined: "Joined (started by someone else)",
  conflict: "Needs a restart",
  not_attached: "Not running",
};

/** The release and wire protocol a daemon reported, the protocol read against this app's: "v0.601.0 · protocol 50 (latest)". */
export function daemonBuild(repo: RepoRuntime, appProtocol: number): string {
  const protocol = repo.protocol === null ? "" : `protocol ${repo.protocol}${repo.protocol === appProtocol ? " (latest)" : ` (app: ${appProtocol})`}`;
  return [repo.version ? `v${repo.version}` : "", protocol].filter(Boolean).join(" · ") || "daemon";
}

export const LIBREOFFICE_URL = "https://www.libreoffice.org/download/download-libreoffice/";
const short = (hash: string | null) => (hash ? hash.slice(0, 8) : "—");
/** This computer heads its own group; it has no installed runtime to compare, so those fields stay empty. */
const LOCAL_HOST: HostRuntime = {
  host_id: "local",
  label: "This computer",
  state: "connected",
  running: null,
  bundled: null,
  link: { calls: 0, bytes_up: 0, bytes_down: 0 },
  daemons: [],
};

/** One line on what the office skills will find: the Python, then LibreOffice and the PDF tools. */
export function officeSummary(office: OfficeTools): string {
  const found = (name: string) => office.tools.some((tool) => tool.name === name && tool.path);
  const python = office.bundledPython ? "Python bundled" : found("python3") ? "Python from this machine (not the bundled one)" : "No Python";
  const missing = ["soffice", "pdftoppm", "qpdf"].filter((name) => !found(name)).map((name) => (name === "soffice" ? "LibreOffice" : name));
  return missing.length ? `${python} · missing ${missing.join(", ")}` : `${python} · LibreOffice, pdftoppm and qpdf found`;
}

/** Down and held for sessions from an older Alinery: nothing runs to restart, and only Back up and reset opens it. */
export const isHeld = (repo: RepoRuntime) => !!repo.outdated && !repo.owner_lanes?.length && !isRemoteRepo(repo.repo);

/** Every running daemon gets Restart, a conflicted one most of all: on this computer `stop_daemon` replaces an older protocol
 *  on this build's lane (the usual conflict after an update), and refuses another build's owner, whose takeover is the repo's banner. */
export const canRestart = (repo: RepoRuntime) => repo.state !== "not_attached";

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

export const MCP_STATE: Record<McpState, string> = {
  [McpState.UNSPECIFIED]: "",
  [McpState.ABSENT]: "Starts on demand",
  [McpState.OK]: "Running",
  [McpState.BEHIND]: "Other build: restart to update",
  [McpState.STUCK]: "Not answering",
};

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** After the state: its clients and the daemons it reaches, and how many it refuses for speaking another protocol (M7). */
export function machineMcpDetail(status: McpStatus): string {
  if (status.state !== McpState.OK && status.state !== McpState.BEHIND) return "";
  const refused = status.daemons.filter((daemon) => !daemon.compatible).length;
  return [plural(status.clients, "client"), plural(status.daemons.length - refused, "daemon"), refused ? `${refused} incompatible` : ""].filter(Boolean).join(" · ");
}

const yes = (title: string, body: string, label: string) =>
  askConfirm({
    title,
    body: <p>{body}</p>,
    choices: [
      { key: "confirm", label },
      { key: "cancel", label: "Cancel", tone: "ghost" },
    ],
    defaultKey: "cancel",
  }).then((key) => key === "confirm");

/** A host's machine MCP (docs/machine-mcp-plan.md), read and restarted through `repo`'s daemon on that host; its token below it.
 *  Force restart signals a process, so it is offered for this computer's only (M3). */
const LOOPBACK = "127.0.0.1";
const ALL = "0.0.0.0";

/** The URL a client on another machine (or this one, for loopback) uses; all interfaces names the first address. */
export function mcpHttpUrl(http: { bind: string; port: number; addresses: string[] }, fallbackHost: string): string {
  const host = http.bind === ALL ? (http.addresses[0] ?? fallbackHost) : http.bind;
  return `http://${host.includes(":") ? `[${host}]` : host}:${http.port}/mcp`;
}

/** M4, M10: the optional HTTP listener, edited here and saved through the host's daemon (which restarts the MCP). */
function McpHttpRow({ repo, status, token, hostLabel, onSaved }: { repo: string; status: McpStatus; token: string; hostLabel: string; onSaved: () => void }) {
  const http = status.http;
  const [draft, setDraft] = useState({ enabled: false, bind: LOOPBACK, port: 39470 });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (http) setDraft({ enabled: http.enabled, bind: http.bind, port: http.port });
  }, [http]);
  if (!http) return null;
  const changed = draft.enabled !== http.enabled || draft.bind !== http.bind || draft.port !== http.port;
  const exposed = draft.enabled && draft.bind !== LOOPBACK;
  const save = async () => {
    if (
      exposed &&
      !(await yes(
        "Serve the MCP beyond this machine?",
        "It speaks plain HTTP: the token and every tool call cross the network unencrypted unless you put TLS or a tunnel in front.",
        "Serve on the network",
      ))
    )
      return;
    setBusy(true);
    try {
      await setMachineMcpHttp(repo, draft);
      toast.success(draft.enabled ? "HTTP is on; the MCP restarted" : "HTTP is off; the MCP restarted");
    } catch (cause) {
      toast.error(String(cause));
    } finally {
      setBusy(false);
      onSaved();
    }
  };
  const url = mcpHttpUrl(http, hostLabel);
  return (
    <tr>
      <td />
      <td className="dim">HTTP</td>
      <td colSpan={2}>
        <label>
          <input type="checkbox" checked={draft.enabled} disabled={busy || (!token && !http.enabled)} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} /> On
        </label>{" "}
        <select aria-label="Bind address" value={draft.bind} disabled={busy} onChange={(e) => setDraft({ ...draft, bind: e.target.value })}>
          <option value={LOOPBACK}>Loopback only</option>
          <option value={ALL}>All interfaces</option>
          {http.addresses.map((address) => (
            <option key={address} value={address}>
              {address}
            </option>
          ))}
        </select>{" "}
        <input type="number" aria-label="Port" min={1} max={65535} value={draft.port} disabled={busy} onChange={(e) => setDraft({ ...draft, port: Number(e.target.value) })} />
        {!token && !http.enabled && <div className="dim">Require a token first: HTTP is never served without one.</div>}
        {exposed && <div className="t-warn">Plain HTTP: the token is sent unencrypted unless you put TLS in front.</div>}
        {http.enabled && http.error && <div className="t-warn">{http.error}</div>}
        {http.enabled && http.listening && (
          <div>
            <span className="mono">{url}</span>{" "}
            <button type="button" className="btn ghost small" onClick={() => void copyTextToClipboard(url).then(() => toast.success("Copied the URL"))}>
              Copy URL
            </button>
            <div className="dim">
              TLS, a tunnel and the firewall are yours to set up. Claude's custom connectors need a public HTTPS URL and take the token as a Bearer header; Claude Desktop's local
              config can reach this URL through mcp-remote.
            </div>
          </div>
        )}
      </td>
      <td>
        <button type="button" className="btn ghost small" disabled={busy || !changed} onClick={() => void save()}>
          Save
        </button>
      </td>
    </tr>
  );
}

function MachineMcpRows({ repo, label, local }: { repo: string | undefined; label: string; local: boolean }) {
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () => {
    if (!repo) return;
    machineMcpStatus(repo).then(setStatus, () => setStatus(null));
    machineMcpToken(repo, "read").then(setToken, () => {});
  };
  useEffect(load, [repo]);
  if (!repo)
    return (
      <tr>
        <td>{label}</td>
        <td />
        <td />
        <td className="dim">No daemon running here to ask</td>
        <td />
      </tr>
    );
  const run = (action: () => Promise<void>) => async () => {
    setBusy(true);
    try {
      await action();
    } catch (cause) {
      toast.error(String(cause));
    } finally {
      setBusy(false);
      load();
    }
  };
  const restart = run(async () => {
    const clients = status?.clients ?? 0;
    const lose = clients ? `Its ${plural(clients, "connected client")} lose any tool call in flight and reconnect.` : "No clients are connected.";
    if (!(await yes("Restart the machine MCP?", `${lose} Daemons register again on their own.`, "Restart MCP"))) return;
    const next = await restartMachineMcp(repo);
    if (next.state === McpState.STUCK) toast.error("The machine MCP did not leave when asked. Force restart ends it.");
    else toast.success("Restarted the machine MCP");
  });
  const force = run(async () => {
    const incarnation = await ipc.machineMcpPeer();
    const pid = incarnation.split(":")[0];
    const body = (
      <p>It does not answer. Alinery ends process {pid} with SIGTERM, and any client connected to it loses its tool calls. The next daemon to register starts a new one.</p>
    );
    if (!(await confirmDanger("Force restart the machine MCP?", body, "Force restart"))) return;
    await ipc.forceRestartMachineMcp(incarnation);
    toast.success("Ended the machine MCP; daemons start a new one");
  });
  const rotate = run(async () => {
    const accepted = token
      ? await yes("Rotate the machine MCP token?", "The old token keeps working for 10 minutes. Update every client you gave it to.", "Rotate token")
      : await yes(
          "Require a token for the machine MCP?",
          "Every caller then presents it. The bridge and the daemons read it themselves; a client you set up by hand needs it in its config.",
          "Require token",
        );
    if (accepted) setToken(await machineMcpToken(repo, "rotate"));
  });
  const clear = run(async () => {
    if (!(await confirmDanger("Stop requiring a token?", <p>Any process running as you can then use the machine MCP without one.</p>, "Clear token"))) return;
    setToken(await machineMcpToken(repo, "clear"));
  });
  const state = status?.state ?? McpState.UNSPECIFIED;
  return (
    <>
      <tr>
        <td>{label}</td>
        <td />
        <td className="dim">{status ? machineMcpDetail(status) : ""}</td>
        <td title={status?.socketPath}>{status ? MCP_STATE[state] : "Could not ask"}</td>
        <td>
          {status && (
            <button type="button" className="btn ghost small" disabled={busy} onClick={() => void restart()}>
              {state === McpState.ABSENT ? "Start MCP" : "Restart MCP"}
            </button>
          )}
          {local && state === McpState.STUCK && (
            <button type="button" className="btn ghost small" disabled={busy} onClick={() => void force()}>
              Force restart…
            </button>
          )}
        </td>
      </tr>
      <tr>
        <td />
        <td className="dim">token</td>
        <td colSpan={2}>
          {token ? (
            <>
              <span className="mono">{token.slice(0, 8)}…</span>{" "}
              <button type="button" className="btn ghost small" onClick={() => void copyTextToClipboard(token).then(() => toast.success("Copied the token"))}>
                Copy
              </button>
            </>
          ) : (
            <span className="dim">Not required</span>
          )}
        </td>
        <td>
          <button type="button" className="btn ghost small" disabled={busy} onClick={() => void rotate()}>
            {token ? "Rotate…" : "Require token…"}
          </button>
          {token && (
            <button type="button" className="btn ghost small" disabled={busy} onClick={() => void clear()}>
              Clear…
            </button>
          )}
        </td>
      </tr>
      {status && <McpHttpRow repo={repo} status={status} token={token} hostLabel={label} onSaved={load} />}
    </>
  );
}

/** What runs where, with a restart per daemon and an update per stale host. Loaded on open and on Refresh only: the shell answers from memory, never over ssh. */
export function RuntimePanel() {
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
        <button type="button" className="btn ghost small" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      {failed && <div className="dim">Could not read the runtime status.</div>}
      {status && (
        <>
          <h4 className="settings-eyebrow">Daemons by host</h4>
          <table className="runtime-table">
            <tbody>
              {[LOCAL_HOST, ...status.hosts].map((host) => {
                const stale = host.running !== null && host.bundled !== null && host.running !== host.bundled;
                const repos = status.repos.filter((repo) => repo.host === host.host_id);
                return (
                  <Fragment key={`host:${host.host_id}`}>
                    <tr className="runtime-host">
                      <td>{host.label}</td>
                      <td className="dim">{host.host_id === "local" ? "" : `host · ${host.state}`}</td>
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
                    {repos.length === 0 && (
                      <tr>
                        <td className="runtime-indent dim" colSpan={5}>
                          No repository daemons
                        </td>
                      </tr>
                    )}
                    {repos.map((repo) => (
                      <Fragment key={`repo:${repo.repo}`}>
                        <tr>
                          <td className="runtime-indent" title={repo.repo}>
                            {repoName(repo.repo)}
                          </td>
                          <td className="dim">{daemonBuild(repo, status.protocol)}</td>
                          <td className="dim">{repo.repo in live ? `${live[repo.repo]} live` : ""}</td>
                          <td title={repo.issues.join("\n") || undefined}>{isHeld(repo) ? "Held: has sessions from an older Alinery" : REPO_STATE[repo.state]}</td>
                          <td>
                            {isHeld(repo) ? (
                              <button
                                type="button"
                                className="btn ghost small"
                                aria-label={`Back up and reset ${repoName(repo.repo)}`}
                                disabled={busy !== null}
                                onClick={() => void act(`repo:${repo.repo}`, () => backUpAndReset(repo.repo, true))}
                              >
                                Back up and reset…
                              </button>
                            ) : (
                              canRestart(repo) && (
                                <button
                                  type="button"
                                  className="btn ghost small"
                                  aria-label={`Restart the daemon for ${repoName(repo.repo)}`}
                                  disabled={busy !== null}
                                  onClick={() => void act(`repo:${repo.repo}`, () => updateDaemon(repo, live[repo.repo]))}
                                >
                                  Restart…
                                </button>
                              )
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
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          <h4 className="settings-eyebrow">Machine MCP by host</h4>
          <table className="runtime-table">
            <tbody>
              {[LOCAL_HOST, ...status.hosts.filter((host) => host.state === "connected")].map((host) => (
                <MachineMcpRows
                  key={`mcp:${host.host_id}`}
                  label={host.label}
                  local={host.host_id === "local"}
                  repo={status.repos.find((repo) => repo.host === host.host_id && (repo.state === "current" || repo.state === "build_drift"))?.repo}
                />
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
