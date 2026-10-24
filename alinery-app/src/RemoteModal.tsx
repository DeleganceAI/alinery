import { ArrowUp, Check, Folder, GitBranch, X } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { askConfirm } from "./confirm";
import * as ipc from "./ipc";
import { RemoteCredentialsForm } from "./RemoteCredentials";
import { HOST_KEY_UNKNOWN, joinPath, machineOf, parentPath, SETUP_PHASES } from "./remoteRepo";
import { Dialog, InlineStatus, LoadingState } from "./shared";
import { toast } from "./toast";
import type { RemoteDirEntry, RemoteHostView, SshTarget } from "./types";

type View = "hosts" | "setup" | "connecting" | "access" | "pick";

/** How the modal was opened: from the + remote button, or by choosing a repo whose host is offline. */
export type RemoteModalEntry = { kind: "hosts" } | { kind: "reconnect"; hostId: string; repoKey: string };

const STEPS = ["Connect", "Access", "First repo"];
const STEP_OF_VIEW: Partial<Record<View, number>> = { setup: 0, connecting: 0, access: 1, pick: 2 };

function Steps({ current }: { current: number }) {
  return (
    <ol className="remote-steps" aria-label="Setup steps">
      {STEPS.map((label, index) => (
        <li key={label} className={index < current ? "done" : index === current ? "on" : ""} aria-current={index === current ? "step" : undefined}>
          {index < current ? <Check size={12} strokeWidth={2} aria-hidden="true" /> : <span aria-hidden="true">{index + 1}</span>}
          {label}
        </li>
      ))}
    </ol>
  );
}

const needsAccess = (host: RemoteHostView) => !host.sharing_reviewed || host.erased_sign_ins.length > 0;

function targetText(alias: string, target: SshTarget): string {
  const login = target.user ? `${target.user}@${target.hostname}` : target.hostname;
  return `${alias} connects to ${login}, port ${target.port}${target.jump ? `, through ${target.jump}` : ""}.`;
}

/**
 * Remote repositories: pick a host you have set up and a folder on it, or set up a new host.
 * Setting up connects, installs the runtime, asks what the host may use, and then offers a first
 * folder. The host is kept even when that last step is skipped. Nothing here stops anything
 * running on a host, and neither does closing the modal.
 */
export function RemoteModal({
  entry,
  hosts,
  knownRepos,
  onClose,
  onOpened,
}: {
  entry: RemoteModalEntry;
  hosts: RemoteHostView[];
  knownRepos: string[];
  onClose: () => void;
  /** Receives the `alinery+ssh://` key of the repo to make active. */
  onOpened: (key: string) => void | Promise<void>;
}) {
  const [view, setView] = useState<View>(entry.kind === "reconnect" ? "connecting" : "hosts");
  const [wizard, setWizard] = useState(false);
  const [hostId, setHostId] = useState(entry.kind === "reconnect" ? entry.hostId : "");
  const [hostLabel, setHostLabel] = useState("");
  const [destination, setDestination] = useState("");
  const [label, setLabel] = useState("");
  const [aliases, setAliases] = useState<string[]>([]);
  const [aliasFilter, setAliasFilter] = useState("");
  const [target, setTarget] = useState<SshTarget | null>(null);
  const [phase, setPhase] = useState<string>(SETUP_PHASES[0]);
  const [error, setError] = useState("");
  const [dir, setDir] = useState("");
  const [entries, setEntries] = useState<RemoteDirEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const fromSetup = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (view !== "setup" || aliases.length > 0) return;
    void ipc.remoteSshAliases().then(
      (found) => alive.current && setAliases(found),
      () => undefined,
    );
  }, [view, aliases.length]);

  const chosen = destination.trim();
  useEffect(() => {
    if (view !== "setup" || !aliases.includes(chosen)) {
      setTarget(null);
      return;
    }
    let current = true;
    void ipc.remoteDescribeDestination(chosen).then(
      (found) => current && setTarget(found),
      () => current && setTarget(null),
    );
    return () => {
      current = false;
    };
  }, [view, aliases, chosen]);

  const load = useCallback(async (id: string, path: string, hidden: boolean) => {
    setBusy(true);
    setError("");
    try {
      const listing = await ipc.remoteListDir(id, path, hidden);
      if (!alive.current) return;
      setDir(listing.path);
      setEntries(listing.entries);
      setTruncated(listing.truncated);
    } catch (e) {
      if (alive.current) setError(String(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }, []);

  /** Past the host's credentials: reopen the repo that was chosen, or browse for a folder. */
  const proceed = useCallback(
    async (id: string) => {
      if (entry.kind === "reconnect") {
        await onOpened(entry.repoKey);
        if (alive.current) onClose();
        return;
      }
      const home = (await ipc.remoteHosts()).find((host) => host.host_id === id)?.home ?? "/";
      if (!alive.current) return;
      setView("pick");
      await load(id, home, false);
    },
    [entry, load, onClose, onOpened],
  );

  const connect = useCallback(
    async (id: string, trust: boolean) => {
      setHostId(id);
      setView("connecting");
      setError("");
      setPhase(SETUP_PHASES[0]);
      const poll = setInterval(() => {
        void ipc.remoteHosts().then((list) => {
          const mine = list.find((host) => host.host_id === id);
          if (alive.current && mine?.state === "connecting" && mine.phase) setPhase(mine.phase);
        });
      }, 500);
      try {
        await ipc.remoteConnect(id, trust);
        const connected = (await ipc.remoteHosts()).find((host) => host.host_id === id);
        if (!alive.current) return;
        setHostLabel(connected?.label || id);
        // A host that has not been told what it may use, or that lost sign-ins, asks first.
        if (connected && needsAccess(connected)) {
          setWizard(!connected.sharing_reviewed);
          setView("access");
          return;
        }
        await proceed(id);
      } catch (e) {
        const message = String(e);
        if (message.includes(HOST_KEY_UNKNOWN)) {
          const choice = await askConfirm({
            title: "Trust this host?",
            body: `${hosts.find((host) => host.host_id === id)?.destination ?? (destination.trim() || id)} has not been seen before. Its key will be added to your known hosts, and later connections must match it. Only continue if you expect to be connecting to this machine.`,
            choices: [
              { key: "trust", label: "Trust and connect" },
              { key: "cancel", label: "Cancel", tone: "ghost" },
            ],
          });
          if (choice === "trust" && alive.current) {
            clearInterval(poll);
            await connect(id, true);
            return;
          }
        }
        if (!alive.current) return;
        const reason = message.replace(`${HOST_KEY_UNKNOWN}: `, "");
        // A first setup that fails leaves no half-made host behind; a known host stays listed.
        if (fromSetup.current) {
          fromSetup.current = false;
          await ipc.remoteDiscardHost(id).catch(() => undefined);
          setView("setup");
        } else {
          setView("hosts");
        }
        setError(reason);
      } finally {
        clearInterval(poll);
      }
    },
    [destination, hosts, proceed],
  );

  const started = useRef(false);
  useEffect(() => {
    if (entry.kind === "reconnect" && !started.current) {
      started.current = true;
      void connect(entry.hostId, false);
    }
  }, [entry, connect]);

  const submitSetup = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      const host = await ipc.remoteAddHost(destination, label.trim() || undefined);
      fromSetup.current = true;
      setWizard(true);
      setHostLabel(host.label || host.host_id);
      await connect(host.host_id, false);
    } catch (e) {
      setError(String(e));
    }
  };

  /** A host from the list: straight to its folders when it is ready, otherwise connect or finish setup. */
  const chooseHost = async (host: RemoteHostView) => {
    setError("");
    setHostId(host.host_id);
    setHostLabel(host.label || host.host_id);
    if (host.state !== "connected") {
      await connect(host.host_id, false);
      return;
    }
    if (needsAccess(host)) {
      setWizard(!host.sharing_reviewed);
      setView("access");
      return;
    }
    await proceed(host.host_id);
  };

  const openFolder = async () => {
    setBusy(true);
    setError("");
    try {
      const found = await ipc.remoteClassify(hostId, dir);
      let root: string;
      if (found.kind === "checkout") {
        root = found.root;
      } else if (found.kind === "refused") {
        setError(found.message);
        return;
      } else {
        const choice = await askConfirm({
          title: "Initialize Git?",
          body: `${found.path} is not a Git repository. Initialize Git in this folder on the remote host before opening it? Cancel leaves the folder unchanged.`,
          choices: [
            { key: "init", label: "Initialize Git" },
            { key: "cancel", label: "Cancel", tone: "ghost" },
          ],
        });
        if (choice !== "init") return;
        root = (await ipc.remoteInit(hostId, found.path)).root;
      }
      const key = await ipc.remoteAddRepo(hostId, root);
      await onOpened(key);
      if (alive.current) onClose();
    } catch (e) {
      if (alive.current) setError(String(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const skipFirstRepo = () => {
    toast(`${hostLabel || "The remote"} is set up. Add a folder from it any time with the remote button.`, "success", "short");
    onClose();
  };

  const repoCount = (id: string) => knownRepos.filter((key) => machineOf(key) === id).length;
  const visibleAliases = aliases.filter((alias) => alias.toLowerCase().includes(aliasFilter.trim().toLowerCase()));
  const step = STEP_OF_VIEW[view];
  const title =
    view === "hosts"
      ? "Remote repositories"
      : view === "pick" && !wizard
        ? `Open a folder on ${hostLabel || hostId}`
        : wizard || view === "setup"
          ? "Set up a remote"
          : "Remote repositories";

  return (
    <Dialog onClose={onClose} ariaLabel={title} className="remote-dialog">
      <div className="mh">
        <span className="mt">{title}</span>
        <button type="button" className="x" aria-label="Close" title="Close" onClick={onClose}>
          <X size={14} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>
      {wizard && step !== undefined ? <Steps current={step} /> : null}

      {view === "hosts" ? (
        <>
          <div className="mb remote-body">
            <p className="dsc">Run sessions on another machine over SSH. Sessions keep running on the host when you disconnect.</p>
            {error ? <InlineStatus tone="error">{error}</InlineStatus> : null}
            {hosts.length === 0 ? (
              <div className="remote-empty">
                <strong>No remotes set up</strong>
                <p className="dsc">Add a Linux machine you can reach with ssh. Alinery installs what it needs there, and you choose which credentials it may use.</p>
                <button type="button" className="btn" onClick={() => setView("setup")} data-autofocus>
                  Set up a remote
                </button>
              </div>
            ) : (
              <ul className="remote-saved remote-host-list" aria-label="Remote hosts">
                {hosts.map((host) => {
                  const unfinished = !host.sharing_reviewed;
                  const connected = host.state === "connected";
                  const count = repoCount(host.host_id);
                  return (
                    <li key={host.host_id} className="remote-host-row">
                      <div className="remote-host-main">
                        <strong>{host.label || host.host_id}</strong>
                        <span className="repo-opt-path">{host.destination}</span>
                        <span className="remote-host-meta">
                          <span className={`remote-state ${host.state}`}>
                            {unfinished ? "Setup not finished" : connected ? "Connected" : host.state === "connecting" ? "Connecting" : "Not connected"}
                          </span>
                          {host.platform ? <span>{host.platform}</span> : null}
                          <span>{count === 1 ? "1 repository" : `${count} repositories`}</span>
                        </span>
                        {host.erased_sign_ins.length > 0 ? <span className="remote-host-warn">Sign-ins were removed from this host. Review its credentials.</span> : null}
                      </div>
                      <button type="button" className="btn small" disabled={host.state === "connecting"} onClick={() => void chooseHost(host)}>
                        {unfinished ? "Finish setup" : connected ? "Open a folder" : "Connect"}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <div className="mfoot chat-new-foot">
            <button type="button" className="btn ghost" onClick={onClose}>
              Close
            </button>
            {hosts.length > 0 ? (
              <button type="button" className="btn" onClick={() => setView("setup")} data-autofocus>
                Set up a new remote…
              </button>
            ) : null}
          </div>
        </>
      ) : null}

      {view === "setup" ? (
        <form onSubmit={(event) => void submitSetup(event)}>
          <div className="mb remote-body">
            {aliases.length > 0 ? (
              <div className="remote-field">
                <span className="remote-field-label">From your SSH config</span>
                {aliases.length > 8 ? (
                  <input
                    type="search"
                    className="remote-input"
                    aria-label="Filter SSH config hosts"
                    placeholder="Filter"
                    value={aliasFilter}
                    onChange={(event) => setAliasFilter(event.target.value)}
                    spellCheck={false}
                  />
                ) : null}
                <ul className="remote-saved remote-alias-list" aria-label="SSH config hosts">
                  {visibleAliases.map((alias) => (
                    <li key={alias}>
                      <button type="button" className={`remote-saved-host${chosen === alias ? " on" : ""}`} aria-pressed={chosen === alias} onClick={() => setDestination(alias)}>
                        <span>{alias}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                {target ? (
                  <p className="dsc" aria-live="polite">
                    {targetText(chosen, target)}
                  </p>
                ) : null}
              </div>
            ) : null}
            <label className="chat-dialog-field">
              <span>SSH destination</span>
              <input
                type="text"
                className="remote-input"
                value={destination}
                onChange={(event) => setDestination(event.target.value)}
                placeholder="me@host, or ssh -p 2222 -i ~/.ssh/key me@host"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                data-autofocus
              />
            </label>
            <label className="chat-dialog-field">
              <span>Name (optional)</span>
              <input type="text" className="remote-input" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Defaults to the host" spellCheck={false} />
            </label>
            <p className="dsc">
              Alinery connects without prompts, so your key must be in ssh-agent or passed with -i. The host needs Linux (x64 or arm64) and git. After it connects you choose which
              API keys and hosted models the host may use. Browser sign-ins are never copied.
            </p>
            {error ? (
              <p className="dsc field-error" role="alert">
                {error}
              </p>
            ) : null}
          </div>
          <div className="mfoot chat-new-foot">
            <button type="button" className="btn ghost" onClick={() => (hosts.length > 0 ? setView("hosts") : onClose())}>
              {hosts.length > 0 ? "Back" : "Cancel"}
            </button>
            <button type="submit" className="btn" disabled={!chosen}>
              Connect and set up
            </button>
          </div>
        </form>
      ) : null}

      {view === "connecting" ? (
        <div className="mb remote-body">
          <ol className="remote-progress" aria-label="Setup progress">
            {SETUP_PHASES.map((name, index) => {
              const at = Math.max(SETUP_PHASES.indexOf(phase), 0);
              return (
                <li key={name} className={index < at ? "done" : index === at ? "on" : ""} aria-current={index === at ? "step" : undefined}>
                  {index < at ? <Check size={12} strokeWidth={2} aria-hidden="true" /> : <span aria-hidden="true">·</span>}
                  {name}
                  {index === at ? "…" : ""}
                </li>
              );
            })}
          </ol>
          <LoadingState label={`${phase}…`} />
          <p className="dsc">Closing this dialog does not stop anything on the host.</p>
        </div>
      ) : null}

      {view === "access" ? (
        <RemoteCredentialsForm hostId={hostId} hostLabel={hostLabel || hostId} confirmLabel="Continue" onCancel={onClose} onDone={() => proceed(hostId)} />
      ) : null}

      {view === "pick" ? (
        <>
          <div className="mb remote-body">
            <div className="remote-path">
              <button
                type="button"
                className="iconbtn"
                title="Parent folder"
                aria-label="Parent folder"
                disabled={busy || dir === "/"}
                onClick={() => void load(hostId, parentPath(dir), showHidden)}
              >
                <ArrowUp size={14} strokeWidth={1.5} aria-hidden="true" />
              </button>
              <code className="remote-cwd" title={dir}>
                {dir}
              </code>
              <label className="remote-hidden">
                <input
                  type="checkbox"
                  checked={showHidden}
                  onChange={(event) => {
                    setShowHidden(event.target.checked);
                    void load(hostId, dir, event.target.checked);
                  }}
                />
                Hidden
              </label>
            </div>
            <ul className="remote-list" aria-label="Folders">
              {entries.map((item) => (
                <li key={item.name}>
                  <button type="button" className="remote-entry" disabled={busy} onClick={() => void load(hostId, joinPath(dir, item.name), showHidden)}>
                    <Folder size={14} strokeWidth={1.5} aria-hidden="true" />
                    <span className="remote-entry-name">{item.name}</span>
                    {item.git ? (
                      <span className="remote-git" title="Git repository">
                        <GitBranch size={12} strokeWidth={1.5} aria-hidden="true" /> git
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
            {entries.length === 0 && !busy ? <p className="dsc">No folders here.</p> : null}
            {truncated ? <p className="dsc">Showing the first {entries.length} folders.</p> : null}
            {error ? <InlineStatus tone="error">{error}</InlineStatus> : null}
          </div>
          <div className="mfoot chat-new-foot">
            {wizard ? (
              <button type="button" className="btn ghost" onClick={skipFirstRepo}>
                Skip for now
              </button>
            ) : (
              <button type="button" className="btn ghost" onClick={() => setView("hosts")}>
                Back
              </button>
            )}
            <button type="button" className="btn" disabled={busy || !dir} onClick={() => void openFolder()} data-autofocus>
              Open this folder
            </button>
          </div>
        </>
      ) : null}
    </Dialog>
  );
}
