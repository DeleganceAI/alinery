import "../onboarding.css";
import { ArrowUp, Check, Folder, FolderOpen, GitBranch, Server, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AddSshHostDialog, RefusalNotice } from "../AddSshHostDialog";
import { openFolderAsRepo } from "../folderSetup";
import { connectHost } from "../hostConnect";
import * as ipc from "../ipc";
import { BrandMark } from "../Logo";
import { RemoteCredentialsForm } from "../RemoteCredentials";
import { joinPath, machineOf, needsAccess, parentPath, repoDisplayPath, SETUP_PHASES } from "../remoteRepo";
import { Dialog, InlineStatus, LoadingState, repoName } from "../shared";
import type { AppConfig, RemoteDirEntry, RemoteHostView } from "../types";

export type SetupTab = "local" | "ssh";

/** What the screen says while the daemon comes up. The shell does both in one call, so they finish together. */
const DAEMON_STEPS = ["Starting the daemon", "Preparing the repository"];
const ADD_HOST = "__add__";

type Stage = "choose" | "connecting" | "access" | "starting";

/**
 * Where work starts: pick a host (this computer, a saved ssh host, or a new one), then a repository on it to add, open or
 * create. Opening a repository starts its daemon; the caller decides whether onboarding runs there. Nothing here stops
 * anything running on a host.
 */
export function SetupScreen({
  appConfig,
  hosts,
  initialTab = "local",
  repoError,
  refreshHosts,
  onOpen,
  onRemoveRepo,
  onClose,
}: {
  appConfig: AppConfig;
  hosts: RemoteHostView[];
  initialTab?: SetupTab;
  repoError: string;
  refreshHosts: () => Promise<void>;
  /** Make the repository active and wait for its daemon. `hostConnected` vouches for a remote host the polled state has not caught up with. */
  onOpen: (repoKey: string, hostConnected: boolean) => Promise<boolean>;
  onRemoveRepo: (repoKey: string) => void;
  /** Given when the screen is a dialog over the board; the full screen has no way out. */
  onClose?: () => void;
}) {
  const [tab, setTab] = useState<SetupTab>(initialTab);
  const [hostId, setHostId] = useState("");
  const [adding, setAdding] = useState(false);
  const [stage, setStage] = useState<Stage>("choose");
  const [phase, setPhase] = useState<string>(SETUP_PHASES[0]);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [localFolder, setLocalFolder] = useState("");
  const [dir, setDir] = useState("");
  const [entries, setEntries] = useState<RemoteDirEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const addedHere = useRef(new Set<string>());

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const host = tab === "ssh" ? hosts.find((candidate) => candidate.host_id === hostId) : undefined;
  const ready = host !== undefined && host.state === "connected" && !needsAccess(host);
  const machine = tab === "local" ? "" : hostId;
  const known = appConfig.known_repos.filter((repo) => machineOf(repo) === machine && (tab === "local" || hostId !== ""));

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

  // A host that is ready lists its home folder, once.
  const home = host?.home ?? "/";
  useEffect(() => {
    if (ready && hostId) void load(hostId, home, false);
    else setDir("");
  }, [ready, hostId, home, load]);

  const pickLocal = async () => {
    setError("");
    try {
      const path = await ipc.pickRepoDialog();
      if (path && alive.current) setLocalFolder(path);
    } catch (e) {
      setError(String(e));
    }
  };

  const connectSelected = async () => {
    if (!host) return;
    setStage("connecting");
    setError("");
    try {
      const connected = await connectHost(host.host_id, host.destination, setPhase, () => alive.current);
      await refreshHosts();
      if (alive.current) setStage(needsAccess(connected) ? "access" : "choose");
    } catch (e) {
      // A first set-up that fails leaves no half-made host behind; a host that connected before stays listed.
      if (addedHere.current.delete(host.host_id)) {
        await ipc.remoteDiscardHost(host.host_id).catch(() => undefined);
        await refreshHosts();
        if (alive.current) setHostId("");
      }
      if (alive.current) {
        setError(String(e instanceof Error ? e.message : e));
        setStage("choose");
      }
    }
  };

  /** Daemon step: make the repository active. Returns to the choice with the reason when it does not open. */
  const start = async (repoKey: string) => {
    setStage("starting");
    const opened = await onOpen(repoKey, tab === "ssh");
    if (alive.current && !opened) setStage("choose");
  };

  const openRepository = async () => {
    setError("");
    setStage("starting");
    setChecking(true);
    try {
      const outcome = await openFolderAsRepo(tab === "ssh" ? hostId : null, tab === "ssh" ? dir : localFolder);
      if (!alive.current) return;
      setChecking(false);
      if (outcome.kind === "refused") {
        setError(outcome.message);
        setStage("choose");
        return;
      }
      if (outcome.kind === "cancelled") {
        setStage("choose");
        return;
      }
      await start(tab === "ssh" ? await ipc.remoteAddRepo(hostId, outcome.root) : outcome.root);
    } catch (e) {
      if (alive.current) {
        setChecking(false);
        setError(String(e));
        setStage("choose");
      }
    }
  };

  const chooseHost = (value: string) => {
    if (value === ADD_HOST) {
      setAdding(true);
      return;
    }
    setHostId(value);
    setError("");
  };

  const canOpen = tab === "local" ? localFolder !== "" : ready && dir !== "";
  const title = "Set up work";

  const body = (
    <div className="onboarding-body onboarding-body-focus" data-testid="setup-screen">
      <div className="onboarding-focus setup-focus">
        <h2>{title}</h2>
        <p className="onboarding-lede">
          Pick the computer your work runs on, then a repository on it. Alinery keeps tasks, artifacts, and playbook state in .alinery/ inside that repository.
        </p>

        <div className="setup-tabs" role="tablist" aria-label="Where the repository lives">
          {(
            [
              ["local", "This computer"],
              ["ssh", "SSH"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={`setup-tab${tab === id ? " active" : ""}`}
              disabled={stage !== "choose"}
              onClick={() => {
                setTab(id);
                setError("");
              }}
            >
              {id === "ssh" ? <Server size={14} strokeWidth={1.6} aria-hidden="true" /> : <FolderOpen size={14} strokeWidth={1.6} aria-hidden="true" />}
              {label}
            </button>
          ))}
        </div>

        {stage === "choose" && tab === "ssh" ? (
          <div className="remote-field">
            <label className="chat-dialog-field">
              <span>SSH host</span>
              <select className="remote-input" aria-label="SSH host" value={hostId} onChange={(event) => chooseHost(event.target.value)} data-autofocus>
                {hosts.length === 0 ? (
                  <option value="">No SSH hosts yet</option>
                ) : (
                  <>
                    <option value="">Choose a host</option>
                    {hosts.map((candidate) => (
                      <option key={candidate.host_id} value={candidate.host_id}>
                        {candidate.label || candidate.host_id} ({candidate.destination})
                      </option>
                    ))}
                  </>
                )}
                <option value={ADD_HOST}>Add SSH connection…</option>
              </select>
            </label>
            {host ? (
              <p className="dsc" aria-live="polite">
                {host.state === "connected" ? "Connected" : host.state === "connecting" ? "Connecting" : host.state === "reconnecting" ? "Reconnecting" : "Not connected"}
                {host.platform ? `, ${host.platform}` : ""}
              </p>
            ) : null}
          </div>
        ) : null}

        {stage === "choose" && tab === "local" ? (
          <div className="remote-field">
            <span className="remote-field-label">Folder</span>
            <div className="setup-folder-row">
              <code className="remote-cwd" title={localFolder}>
                {localFolder || "No folder chosen"}
              </code>
              <button type="button" className="btn ghost small" onClick={() => void pickLocal()} data-autofocus>
                Choose folder…
              </button>
            </div>
          </div>
        ) : null}

        {stage === "choose" && tab === "ssh" && host && !ready ? (
          <div className="setup-connect">
            {host.state === "connected" ? (
              <button type="button" className="btn" onClick={() => setStage("access")}>
                Review what {host.label || host.host_id} may use
              </button>
            ) : (
              <button type="button" className="btn" disabled={host.state === "connecting"} onClick={() => void connectSelected()}>
                Connect to {host.label || host.host_id}
              </button>
            )}
            <p className="dsc">
              The first connection installs the Alinery runtime on the host and asks which credentials it may use. Closing this screen does not stop anything running there.
            </p>
          </div>
        ) : null}

        {stage === "choose" && tab === "ssh" && ready ? (
          <div className="remote-field">
            <span className="remote-field-label">Folder on {host?.label || hostId}</span>
            <div className="remote-path">
              <button
                type="button"
                className="iconbtn"
                title="Parent folder"
                aria-label="Parent folder"
                disabled={busy || dir === "/" || dir === ""}
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
          </div>
        ) : null}

        {stage === "connecting" && host ? (
          <div className="remote-body">
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
          </div>
        ) : null}

        {stage === "access" && host ? (
          <RemoteCredentialsForm
            hostId={host.host_id}
            hostLabel={host.label || host.host_id}
            confirmLabel="Continue"
            onCancel={() => setStage("choose")}
            onDone={async () => {
              await refreshHosts();
              if (alive.current) setStage("choose");
            }}
          />
        ) : null}

        {stage === "starting" ? (
          <ol className="remote-progress" aria-label="Opening the repository">
            <li className={checking ? "on" : "done"}>
              {checking ? <span aria-hidden="true">·</span> : <Check size={12} strokeWidth={2} aria-hidden="true" />}
              Checking the folder{checking ? "…" : ""}
            </li>
            {DAEMON_STEPS.map((name, index) => (
              <li key={name} className={checking ? "" : index === 0 ? "on" : ""}>
                <span aria-hidden="true">·</span>
                {name}
                {!checking && index === 0 ? "…" : ""}
              </li>
            ))}
          </ol>
        ) : null}

        {stage === "choose" && known.length > 0 ? (
          <ul className="onboarding-repo-list" aria-label="Your repositories">
            {known.map((repo) => (
              <li key={repo} className="onboarding-repo-row">
                <button
                  type="button"
                  className={`onboarding-repo${repo === appConfig.active_repo ? " active" : ""}`}
                  title={repoDisplayPath(repo)}
                  onClick={() => void start(repo)}
                >
                  <strong>{repoName(repo)}</strong>
                  <span className="onboarding-repo-path">{repoDisplayPath(repo)}</span>
                </button>
                <button
                  type="button"
                  className="onboarding-repo-remove"
                  title={`Remove ${repoName(repo)} from Alinery (repo files are untouched)`}
                  aria-label={`Remove ${repoName(repo)}`}
                  onClick={() => onRemoveRepo(repo)}
                >
                  <X size={16} strokeWidth={1.5} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        {error ? <RefusalNotice message={error} /> : null}
        {repoError && stage === "choose" ? (
          <InlineStatus tone="error" detail={repoError}>
            Couldn't open the repository. Choose another folder or initialize Git when prompted.
          </InlineStatus>
        ) : null}

        <div className="onboarding-focus-actions">
          {onClose ? (
            <button type="button" className="btn ghost onboarding-add-repo" onClick={onClose} disabled={stage === "starting"}>
              Cancel
            </button>
          ) : null}
          <button type="button" className="btn onboarding-add-repo" disabled={stage !== "choose" || !canOpen} onClick={() => void openRepository()}>
            <FolderOpen size={16} strokeWidth={1.6} aria-hidden="true" />
            Open repository
          </button>
        </div>
      </div>
      {adding ? (
        <AddSshHostDialog
          onClose={() => setAdding(false)}
          onAdded={(saved) => {
            addedHere.current.add(saved.host_id);
            setAdding(false);
            setTab("ssh");
            setHostId(saved.host_id);
            void refreshHosts();
          }}
        />
      ) : null}
    </div>
  );

  if (onClose) {
    return (
      <Dialog className="onboarding-overlay" ariaLabel={title} onClose={onClose}>
        <div className="view scroll onboarding-view">
          <div className="onboarding-shell">{body}</div>
        </div>
      </Dialog>
    );
  }
  return (
    <div className="view scroll onboarding-view" data-testid="setup-screen-root">
      <div className="onboarding-shell">
        <header className="onboarding-header">
          <div className="onboarding-brand">
            <BrandMark />
            <span className="onboarding-brand-name">Alinery</span>
          </div>
          <div className="onboarding-header-actions">
            <span className="onboarding-header-caption">Pick a host and a repository to continue</span>
          </div>
        </header>
        {body}
      </div>
    </div>
  );
}
