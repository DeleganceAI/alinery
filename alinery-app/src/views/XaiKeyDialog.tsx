import { X } from "lucide-react";
import { useState } from "react";
import * as ipc from "../ipc";
import { Dialog, InlineStatus } from "../shared";

export function XaiKeyDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const trimmed = key.trim();

  const save = () => {
    if (!trimmed || busy) return;
    setBusy(true);
    setErr(null);
    ipc
      .setOrbitronXaiKey(trimmed)
      .then(() => onSaved())
      .catch(() => setErr("Couldn't save the xAI key."))
      .finally(() => setBusy(false));
  };

  return (
    <Dialog onClose={onClose} ariaLabel="xAI API key" className="concept-name-modal">
      <div className="mh">
        <span className="mt">xAI API key</span>
        <button type="button" className="x" aria-label="Close" title="Close" onClick={onClose}>
          <X size={14} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>
      <div className="mb">
        <p className="dim">The Orbitron agent uses this key to reach xAI. It stays on this machine and is never sent anywhere else.</p>
        <input
          className="field-input"
          type="password"
          data-autofocus=""
          autoComplete="off"
          aria-label="xAI API key"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && trimmed) save();
          }}
        />
        {err && <InlineStatus tone="error">{err}</InlineStatus>}
      </div>
      <div className="mfoot">
        <button type="button" className="btn small" disabled={!trimmed || busy} onClick={save}>
          Save
        </button>
        <button type="button" className="btn ghost small" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Dialog>
  );
}
