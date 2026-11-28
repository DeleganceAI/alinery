import { useId, useState } from "react";
import type { QueuedPanelLine } from "./chatTranscript";

/** Accepted input waiting for delivery. Absent when nothing waits; collapse state dies with the panel, so a reload starts open. */
export function QueuedPanel({ items, onRemove }: { items: QueuedPanelLine[]; onRemove: (id: string) => void }) {
  const [collapsed, setCollapsed] = useState(false);
  const listId = useId();
  if (items.length === 0) return null;
  return (
    <section className="queued-panel" aria-label="Queued">
      <div className="queued-panel-head">
        <span className="queued-panel-title">Queued · {items.length}</span>
        <button type="button" className="btn ghost small" aria-expanded={!collapsed} aria-controls={listId} onClick={() => setCollapsed((value) => !value)}>
          {collapsed ? "Show" : "Hide"}
        </button>
      </div>
      {collapsed ? null : (
        <ol id={listId} className="queued-panel-list">
          {items.map((item) => {
            const names = imageNames(item);
            const identity = lineIdentity(item, names);
            return (
              <li key={item.id} className="queued-panel-line">
                <span className="queued-panel-text">{identity}</span>
                {item.text.trim() && names.length > 0 ? <span className="queued-panel-names">{names.join(", ")}</span> : null}
                <span className="queued-panel-marker">{markerOf(item.mode)}</span>
                <button type="button" className="btn ghost small" aria-label={`Remove ${identity}`} onClick={() => onRemove(item.id)}>
                  Remove
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function imageNames(item: QueuedPanelLine): string[] {
  return item.images.map((image) => image.name).filter((name) => name.length > 0);
}

/** The text, or the image names when there is no text, so an image-only line is never blank. */
function lineIdentity(item: QueuedPanelLine, names: string[]): string {
  const text = item.text.trim();
  if (text) return text;
  if (names.length > 0) return names.join(", ");
  return "Image";
}

/** Stable text. A follow-up waits out the turn; a steer cuts it. Anything else is shown as the harness sent it, not relabeled. */
function markerOf(mode: string): string {
  if (mode === "followUp") return "after this turn";
  if (mode === "steer") return "interrupts the running turn";
  return mode;
}
