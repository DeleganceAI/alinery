import { X } from "lucide-react";
import { useState } from "react";
import { Dialog } from "../shared";

/**
 * Names a concept at the moment it is drawn (POC `conceptModal`).
 *
 * The gesture creates nothing until this returns: Create hands back a trimmed name and Cancel
 * discards the rect, so a hull labelled "Untitled concept" is not a state the UI can produce.
 * That is the whole point of the step — a spatial tag whose name nobody chose is a tag nobody
 * can find again. Renaming later is inline on the label, not this dialog.
 */
export function ConceptNameDialog({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: (name: string) => void }) {
  const [name, setName] = useState("");
  const trimmed = name.trim();
  return (
    <Dialog onClose={onCancel} ariaLabel="Name concept" className="concept-name-modal">
      <div className="mh">
        <span className="mt">Name concept</span>
        <button type="button" className="x" aria-label="Close" title="Close" onClick={onCancel}>
          <X size={14} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>
      <div className="mb">
        <p className="dim">A concept is an Alinery-local tag with a place on the board. Tasks keep their own names and stay in Kanban.</p>
        <input
          className="field-input"
          data-autofocus=""
          aria-label="Concept name"
          placeholder="e.g. Authentication system"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            // Enter is the fast path, but only once there is a name — an empty Enter must not
            // create the unnamed hull this dialog exists to prevent.
            if (e.key === "Enter" && trimmed) onConfirm(trimmed);
          }}
        />
      </div>
      <div className="mfoot">
        <button type="button" className="btn small" disabled={!trimmed} onClick={() => onConfirm(trimmed)}>
          Create
        </button>
        <button type="button" className="btn ghost small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </Dialog>
  );
}
