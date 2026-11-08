import { Check, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { RefusalNotice } from "./AddSshHostDialog";
import { connectHost } from "./hostConnect";
import { RemoteCredentialsForm } from "./RemoteCredentials";
import { needsAccess, SETUP_PHASES } from "./remoteRepo";
import { Dialog, LoadingState } from "./shared";
import type { RemoteHostView } from "./types";

/** Opened by choosing a repo whose host is offline: bring the host back, then open that repo. */
export type RemoteModalEntry = { kind: "reconnect"; hostId: string; repoKey: string };

type View = "connecting" | "access" | "failed";

/**
 * Reconnect a saved host so one of its repositories can open. Picking a host and a folder on it is the setup screen's job;
 * this dialog only brings a known host back, asks about credentials the host still needs, and hands back the repo key.
 * Nothing here stops anything running on a host, and neither does closing it.
 */
export function RemoteModal({
  entry,
  hosts,
  onClose,
  onOpened,
}: {
  entry: RemoteModalEntry;
  hosts: RemoteHostView[];
  onClose: () => void;
  /** Receives the `alinery+ssh://` key of the repo to make active. */
  onOpened: (key: string) => void | Promise<void>;
}) {
  const [view, setView] = useState<View>("connecting");
  const [phase, setPhase] = useState<string>(SETUP_PHASES[0]);
  const [error, setError] = useState("");
  const [label, setLabel] = useState("");
  const alive = useRef(true);
  const started = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const open = useCallback(async () => {
    await onOpened(entry.repoKey);
    if (alive.current) onClose();
  }, [entry.repoKey, onClose, onOpened]);

  const connect = useCallback(async () => {
    setView("connecting");
    setError("");
    const known = hosts.find((host) => host.host_id === entry.hostId);
    try {
      const connected = await connectHost(entry.hostId, known?.destination ?? entry.hostId, setPhase, () => alive.current);
      if (!alive.current) return;
      setLabel(connected.label || entry.hostId);
      // A host that lost sign-ins, or was never told what it may use, asks first.
      if (needsAccess(connected)) setView("access");
      else await open();
    } catch (e) {
      if (!alive.current) return;
      setError(String(e instanceof Error ? e.message : e));
      setView("failed");
    }
  }, [entry.hostId, hosts, open]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void connect();
  }, [connect]);

  return (
    <Dialog onClose={onClose} ariaLabel="Reconnect to the remote" className="remote-dialog">
      <div className="mh">
        <span className="mt">Reconnect to the remote</span>
        <button type="button" className="x" aria-label="Close" title="Close" onClick={onClose}>
          <X size={14} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>

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

      {view === "access" ? <RemoteCredentialsForm hostId={entry.hostId} hostLabel={label || entry.hostId} confirmLabel="Continue" onCancel={onClose} onDone={open} /> : null}

      {view === "failed" ? (
        <>
          <div className="mb remote-body">
            <RefusalNotice message={error} />
          </div>
          <div className="mfoot chat-new-foot">
            <button type="button" className="btn ghost" onClick={onClose}>
              Close
            </button>
            <button type="button" className="btn" onClick={() => void connect()} data-autofocus>
              Try again
            </button>
          </div>
        </>
      ) : null}
    </Dialog>
  );
}
