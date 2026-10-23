import { ArrowUp, Folder, GitBranch, X } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { askConfirm } from "./confirm";
import * as ipc from "./ipc";
import { HOST_KEY_UNKNOWN, joinPath, parentPath } from "./remoteRepo";
import { Dialog, InlineStatus, LoadingState } from "./shared";
import type { RemoteDirEntry, RemoteHostView } from "./types";

type Step = "destination" | "connecting" | "browse";

/**
 * Add a repository that lives on another machine over SSH: choose the destination, connect
 * (the app installs its runtime on the host), browse to a folder and open it. Connecting
 * never stops anything running on the host, and neither does closing this dialog.
 */
export function RemoteRepoDialog({
  hostId: initialHostId,
  hosts,
  onClose,
  onOpened,
}: {
  /** Reconnect this host straight away instead of asking for a destination. */
  hostId?: string;
  hosts: RemoteHostView[];
  onClose: () => void;
  /** Receives the `alinery+ssh://` key of the repo to make active. */
  onOpened: (key: string) => void | Promise<void>;
}) {
  const [step, setStep] = useState<Step>(initialHostId ? "connecting" : "destination");
  const [destination, setDestination] = useState("");
  const [hostId, setHostId] = useState(initialHostId ?? "");
  const [phase, setPhase] = useState("Connecting");
  const [error, setError] = useState("");
  const [dir, setDir] = useState("");
  const [entries, setEntries] = useState<RemoteDirEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

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

  const connect = useCallback(
    async (id: string, trust: boolean) => {
      setStep("connecting");
      setError("");
      setPhase("Connecting");
      const poll = setInterval(() => {
        void ipc.remoteHosts().then((list) => {
          const mine = list.find((host) => host.host_id === id);
          if (alive.current && mine?.state === "connecting" && mine.phase) setPhase(mine.phase);
        });
      }, 500);
      try {
        await ipc.remoteConnect(id, trust);
        const home = (await ipc.remoteHosts()).find((host) => host.host_id === id)?.home ?? "/";
        if (!alive.current) return;
        setStep("browse");
        await load(id, home, false);
      } catch (e) {
        const message = String(e);
        if (message.includes(HOST_KEY_UNKNOWN)) {
          const choice = await askConfirm({
            title: "Trust this host?",
            body: `${hosts.find((host) => host.host_id === id)?.destination ?? id} has not been seen before. Its key will be added to your known hosts, and later connections must match it. Only continue if you expect to be connecting to this machine.`,
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
        if (alive.current) {
          setStep("destination");
          setError(message.replace(`${HOST_KEY_UNKNOWN}: `, ""));
        }
      } finally {
        clearInterval(poll);
      }
    },
    [hosts, load],
  );

  const started = useRef(false);
  useEffect(() => {
    if (initialHostId && !started.current) {
      started.current = true;
      void connect(initialHostId, false);
    }
  }, [initialHostId, connect]);

  const submitDestination = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      const host = await ipc.remoteAddHost(destination);
      setHostId(host.host_id);
      await connect(host.host_id, false);
    } catch (e) {
      setError(String(e));
    }
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

  const saved = hosts.filter((host) => host.destination);
  return (
    <Dialog onClose={onClose} ariaLabel="Add remote repository" className="remote-dialog">
      <div className="mh">
        <span className="mt">Add remote repository</span>
        <button type="button" className="x" aria-label="Close" title="Close" onClick={onClose}>
          <X size={14} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>

      {step === "destination" ? (
        <form onSubmit={(event) => void submitDestination(event)}>
          <div className="mb remote-body">
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
            <p className="dsc">
              Alinery connects without prompts, so your key must be in ssh-agent or passed with -i. Your provider sign-ins are copied to the host so its agents can run.
            </p>
            {saved.length > 0 ? (
              <ul className="remote-saved" aria-label="Saved hosts">
                {saved.map((host) => (
                  <li key={host.host_id}>
                    <button type="button" className="remote-saved-host" onClick={() => void connect(host.host_id, false)}>
                      <span>{host.label || host.destination}</span>
                      <span className="repo-opt-path">{host.destination}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {error ? (
              <p className="dsc field-error" role="alert">
                {error}
              </p>
            ) : null}
          </div>
          <div className="mfoot chat-new-foot">
            <button type="button" className="btn ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn" disabled={!destination.trim()}>
              Connect
            </button>
          </div>
        </form>
      ) : null}

      {step === "connecting" ? (
        <div className="mb remote-body">
          <LoadingState label={`${phase}…`} />
          <p className="dsc">Closing this dialog does not stop anything on the host.</p>
        </div>
      ) : null}

      {step === "browse" ? (
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
              {entries.map((entry) => (
                <li key={entry.name}>
                  <button type="button" className="remote-entry" disabled={busy} onClick={() => void load(hostId, joinPath(dir, entry.name), showHidden)}>
                    <Folder size={14} strokeWidth={1.5} aria-hidden="true" />
                    <span className="remote-entry-name">{entry.name}</span>
                    {entry.git ? (
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
            <button type="button" className="btn ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="btn" disabled={busy || !dir} onClick={() => void openFolder()} data-autofocus>
              Open this folder
            </button>
          </div>
        </>
      ) : null}
    </Dialog>
  );
}
