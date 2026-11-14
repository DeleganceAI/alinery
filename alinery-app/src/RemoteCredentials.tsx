import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import * as ipc from "./ipc";
import { providerLabel, tokenLifetime } from "./remoteRepo";
import { Dialog, InlineStatus, LoadingState } from "./shared";
import type { RemoteSharingView } from "./types";

const HOSTED = "hosted-models";
const CUSTOM = "custom-providers";
const GROK = "grok";
const keyItem = (provider: string) => `key:${provider}`;

/**
 * What a host may use, chosen by the user: API keys one by one, the hosted-model token, and a
 * note that browser sign-ins are made on the host instead. Nothing is copied until `onDone`
 * runs, and saving applies to the connected host at once.
 */
export function RemoteCredentialsForm({
  hostId,
  hostLabel,
  confirmLabel,
  onDone,
  onCancel,
}: {
  hostId: string;
  hostLabel: string;
  confirmLabel: string;
  onDone: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const [view, setView] = useState<RemoteSharingView | null>(null);
  const [shared, setShared] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    void ipc.remoteSharing(hostId).then(
      (loaded) => {
        if (!alive.current) return;
        setView(loaded);
        setShared(new Set(loaded.shared));
      },
      (e) => alive.current && setError(String(e)),
    );
    return () => {
      alive.current = false;
    };
  }, [hostId]);

  const toggle = (item: string, on: boolean) =>
    setShared((current) => {
      const next = new Set(current);
      if (on) next.add(item);
      else next.delete(item);
      return next;
    });

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await ipc.remoteSetSharing(hostId, [...shared]);
      await onDone();
    } catch (e) {
      if (alive.current) setError(String(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  if (!view) {
    return (
      <div className="mb remote-body">
        {error ? <InlineStatus tone="error">{error}</InlineStatus> : <LoadingState label="Reading your credentials…" />}
        {error ? (
          <div className="mfoot chat-new-foot">
            <button type="button" className="btn ghost" onClick={onCancel}>
              Close
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  const keyItems = view.keys.map(keyItem);
  const allKeys = keyItems.length > 0 && keyItems.every((item) => shared.has(item));
  const lifetime = view.hosted_expires_at ? tokenLifetime(view.hosted_expires_at) : null;
  return (
    <>
      <div className="mb remote-body">
        <p className="dsc">
          Choose what <strong>{hostLabel}</strong> may use. Each item is copied into a private folder on the host that only your user can read, so its agents keep working while
          your Mac is closed. Nothing is copied until you continue, and you can change this later in Settings, under Connections.
        </p>
        {view.erased_sign_ins.length > 0 ? (
          <InlineStatus tone="warning">
            Sign-ins for {view.erased_sign_ins.map(providerLabel).join(", ")} were removed from this host, because sign-ins are no longer copied from your Mac. Sessions that used
            them will ask you to sign in again. Use an API key below, or sign in on the host from Settings, under Providers and accounts, while a repository on this host is open.
          </InlineStatus>
        ) : null}

        <fieldset className="remote-share">
          <legend>
            API keys <span className="remote-share-tag">Recommended</span>
          </legend>
          <p className="dsc">API keys are the most reliable way to keep a host running for a long time. They do not expire, rotate or need renewing.</p>
          {view.keys.length > 0 ? (
            <>
              <ul className="remote-share-list">
                {view.keys.map((provider) => (
                  <li key={provider}>
                    <label>
                      <input type="checkbox" checked={shared.has(keyItem(provider))} onChange={(event) => toggle(keyItem(provider), event.target.checked)} />
                      <span>{providerLabel(provider)}</span>
                    </label>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="btn ghost small"
                onClick={() =>
                  setShared((current) => {
                    const next = new Set(current);
                    for (const item of keyItems) {
                      if (allKeys) next.delete(item);
                      else next.add(item);
                    }
                    return next;
                  })
                }
              >
                {allKeys ? "Select none" : "Select all"}
              </button>
            </>
          ) : (
            <p className="dsc">No API keys are saved on this Mac. Add one under Settings, Providers and accounts, or sign in on the host.</p>
          )}
          {view.custom_providers || view.grok ? (
            <ul className="remote-share-list">
              {view.grok ? (
                <li>
                  <label>
                    <input type="checkbox" checked={shared.has(GROK)} onChange={(event) => toggle(GROK, event.target.checked)} />
                    <span>Grok API key</span>
                  </label>
                </li>
              ) : null}
              {view.custom_providers ? (
                <li>
                  <label>
                    <input type="checkbox" checked={shared.has(CUSTOM)} onChange={(event) => toggle(CUSTOM, event.target.checked)} />
                    <span>Custom endpoints and their keys</span>
                  </label>
                </li>
              ) : null}
            </ul>
          ) : null}
        </fieldset>

        <fieldset className="remote-share">
          <legend>Alinery hosted models</legend>
          {view.hosted ? (
            <>
              <label className="remote-share-row">
                <input type="checkbox" checked={shared.has(HOSTED)} onChange={(event) => toggle(HOSTED, event.target.checked)} />
                <span>Let this host use Alinery hosted models</span>
              </label>
              <p className="dsc">
                The host receives an access token {lifetime ? `valid ${lifetime}` : "that expires"}. It is renewed each time you connect to this host from this Mac, so connect from
                a Mac before it runs out. After that, hosted models stop working on the host until you do.
              </p>
            </>
          ) : (
            <p className="dsc">Sign in to Alinery on this Mac with a paid plan to use hosted models on a host.</p>
          )}
        </fieldset>

        <fieldset className="remote-share">
          <legend>Sign-ins</legend>
          <p className="dsc">
            Browser sign-ins are not copied. They renew themselves with rotating tokens, and two copies would sign each other out. Sign in on the host instead, from Settings, under
            Providers and accounts, while a repository on this host is open. A sign-in can need renewing, so prefer an API key for a host that runs on its own.
          </p>
          {view.sign_ins.length > 0 ? <p className="dsc">Signed in on this Mac and not copied: {view.sign_ins.map(providerLabel).join(", ")}.</p> : null}
        </fieldset>
        {error ? <InlineStatus tone="error">{error}</InlineStatus> : null}
      </div>
      <div className="mfoot chat-new-foot">
        <button type="button" className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void save()} data-autofocus>
          {confirmLabel}
        </button>
      </div>
    </>
  );
}

/** The same choices, opened from Settings for a connected host. */
export function RemoteCredentialsDialog({ hostId, hostLabel, onClose }: { hostId: string; hostLabel: string; onClose: () => void }) {
  return (
    <Dialog onClose={onClose} ariaLabel={`Credentials for ${hostLabel}`} className="remote-dialog">
      <div className="mh">
        <span className="mt">Credentials for {hostLabel}</span>
        <button type="button" className="x" aria-label="Close" title="Close" onClick={onClose}>
          <X size={14} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>
      <RemoteCredentialsForm hostId={hostId} hostLabel={hostLabel} confirmLabel="Save" onDone={onClose} onCancel={onClose} />
    </Dialog>
  );
}
