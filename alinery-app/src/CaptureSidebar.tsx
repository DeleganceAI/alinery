import { Check, Copy, Trash2, X } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { addCapture, type Capture, captureDropTargetAt, dropCapture, removeCapture, useCaptures } from "./captures";
import { confirmDanger } from "./confirm";
import { stagePastedImages } from "./pastedImages";
import { Dialog } from "./shared";
import { toast } from "./toast";
import { usePointerDrag } from "./usePointerDrag";

export const CAPTURE_SHORTCUT = "⌘⇧C";
export const INBOX_SHORTCUT = "⌘⇧I";
const COPIED_MS = 1200;
const DRAG_THRESHOLD = 4;

function Thumb({ file }: { file: File }) {
  const url = useMemo(() => URL.createObjectURL(file), [file]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return <img className="capture-thumb" src={url} alt={file.name} draggable={false} />;
}

const when = (at: number) => new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** True once the capture is stored. A failure is reported here, so callers only decide what to undo. */
function store(text: string, images: File[]): Promise<boolean> {
  return addCapture(text, images).then(
    () => true,
    (error) => {
      toast.error(`Couldn't save the capture: ${error}`);
      return false;
    },
  );
}

/** Files a pasted screenshot at once, as its own capture: nothing to confirm. Null when the paste held no image. */
function captureImages(clipboard: DataTransfer): Promise<boolean> | null {
  const { added, errors, hasImage } = stagePastedImages(clipboard, []);
  for (const error of errors) toast.error(error);
  for (const image of added) URL.revokeObjectURL(image.previewUrl);
  if (!hasImage) return null;
  if (!added.length) return Promise.resolve(false);
  return store(
    "",
    added.map((image) => image.file),
  );
}

/** Puts a capture on the system clipboard: its text, and its screenshot when that is a PNG (all WebKit will write). */
async function copyCapture(capture: Capture) {
  const png = capture.images.find((image) => image.type === "image/png");
  if (!png) {
    if (!capture.text) throw new Error("only PNG images can be copied");
    return navigator.clipboard.writeText(capture.text);
  }
  const parts: Record<string, Blob> = { "image/png": png };
  if (capture.text) parts["text/plain"] = new Blob([capture.text], { type: "text/plain" });
  return navigator.clipboard.write([new ClipboardItem(parts)]);
}

/** The one field everything goes into. Enter files the text; a pasted screenshot files itself. */
function CaptureBox({ fieldRef, onSaved, onClose }: { fieldRef?: RefObject<HTMLTextAreaElement | null>; onSaved?: () => void; onClose: () => void }) {
  const [text, setText] = useState("");
  const save = async () => {
    const body = text.trim();
    if (!body) return;
    setText("");
    if (await store(body, [])) onSaved?.();
    // A capture that was not stored must not look stored: the text goes back in the box.
    else setText((current) => current || body);
  };
  return (
    <div className="capture-box">
      <textarea
        ref={fieldRef}
        data-autofocus=""
        className="field-input"
        rows={2}
        value={text}
        placeholder="Capture anything…"
        aria-label="Capture"
        onChange={(event) => setText(event.target.value)}
        onPaste={(event) => {
          const saving = captureImages(event.clipboardData);
          if (!saving) return;
          if (!event.clipboardData.getData("text/plain")) event.preventDefault();
          void saving.then((saved) => saved && onSaved?.());
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void save();
          }
        }}
      />
      <p className="capture-hint">
        <b>↵</b> saves · a pasted screenshot saves itself
      </p>
    </div>
  );
}

/**
 * Capture with nothing else on screen: one field over the app, no list of what is already in the
 * inbox to pull attention. Saving closes it and puts the caret back where it was.
 */
export function QuickCapture({ onClose }: { onClose: () => void }) {
  return (
    <Dialog className="capture-quick" ariaLabel="Quick capture" onClose={onClose}>
      <CaptureBox
        onClose={onClose}
        onSaved={() => {
          toast.success("Captured", "short");
          onClose();
        }}
      />
    </Dialog>
  );
}

/**
 * The capture inbox: the box at the top takes anything typed or pasted and Enter files it, the
 * list below is everything ever captured. A row drags onto any composer; the drop copies it.
 */
export function CaptureSidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const captures = useCaptures();
  const [copied, setCopied] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ capture: Capture; x: number; y: number } | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const pointer = usePointerDrag();

  useEffect(() => {
    if (!open) return;
    field.current?.focus();
    // With the inbox open, a paste that no text field takes is a capture: copy, ⌘V, done.
    const onPaste = (event: ClipboardEvent) => {
      if ((event.target as Element | null)?.closest?.("input,textarea,[contenteditable]") || !event.clipboardData) return;
      if (captureImages(event.clipboardData)) return;
      const pasted = event.clipboardData.getData("text/plain").trim();
      if (pasted) void store(pasted, []);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [open]);

  if (!open) return null;

  const copy = (capture: Capture) =>
    void copyCapture(capture).then(
      () => {
        setCopied(capture.id);
        window.setTimeout(() => setCopied((current) => (current === capture.id ? null : current)), COPIED_MS);
      },
      (error) => toast.error(`Couldn't copy: ${error}`),
    );

  const beginDrag = (event: ReactPointerEvent<HTMLElement>, capture: Capture) => {
    if (event.button !== 0 || (event.target as Element).closest("button")) return;
    const origin = { x: event.clientX, y: event.clientY };
    let moved = false;
    let over: Element | null = null;
    const hover = (next: Element | null) => {
      if (over === next) return;
      over?.removeAttribute("data-capture-over");
      next?.setAttribute("data-capture-over", "");
      over = next;
    };
    pointer.start(event, {
      onMove: (move) => {
        if (!moved && Math.hypot(move.clientX - origin.x, move.clientY - origin.y) < DRAG_THRESHOLD) return;
        if (!moved) {
          // WebKit starts a text selection under a moving pressed pointer, even from an unselectable row.
          document.documentElement.setAttribute("data-capture-dragging", "");
          getSelection()?.removeAllRanges();
        }
        moved = true;
        setDrag({ capture, x: move.clientX, y: move.clientY });
        hover(captureDropTargetAt(move.clientX, move.clientY));
      },
      onComplete: (end) => {
        const target = moved && end.type === "pointerup" ? captureDropTargetAt(end.clientX, end.clientY) : null;
        hover(null);
        document.documentElement.removeAttribute("data-capture-dragging");
        setDrag(null);
        if (target) dropCapture(target, capture);
        // A press that never moved is a click: the capture goes on the clipboard.
        else if (!moved && end.type === "pointerup") copy(capture);
      },
    });
  };

  return (
    <aside
      className="capture-sidebar"
      aria-label="Captures"
      // Pointing at the inbox is enough to type into it: no click before the first key.
      onPointerEnter={(event) => {
        if (event.buttons === 0 && !(document.activeElement as Element | null)?.closest(".capture-sidebar")) field.current?.focus();
      }}
    >
      <header className="capture-bar">
        <span className="capture-title">Captures</span>
        <button type="button" className="chat-icon-btn" aria-label="Hide captures" title={`Hide (${INBOX_SHORTCUT})`} onClick={onClose}>
          <X size={16} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </header>
      <CaptureBox fieldRef={field} onClose={onClose} />
      <ul className="capture-list">
        {captures.length === 0 && <li className="capture-empty">Nothing captured yet.</li>}
        {captures.map((capture) => (
          <li
            key={capture.id}
            className="capture-row"
            onPointerDown={(event) => beginDrag(event, capture)}
            // The press must not begin a selection; the buttons still get their click.
            onMouseDown={(event) => event.preventDefault()}
          >
            <div className="capture-meta">
              <time dateTime={new Date(capture.at).toISOString()}>{when(capture.at)}</time>
              <button
                type="button"
                className="chat-icon-btn capture-copy"
                data-copied={copied === capture.id || undefined}
                aria-label={copied === capture.id ? "Copied" : "Copy capture"}
                title="Copy"
                onClick={() => copy(capture)}
              >
                <Copy className="copy" size={14} strokeWidth={1.5} aria-hidden="true" />
                <Check className="check" size={14} strokeWidth={2} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="chat-icon-btn"
                aria-label="Delete capture"
                title="Delete"
                onClick={async () => {
                  if (!(await confirmDanger("Delete this capture?", "It is removed from the inbox for good. Anything you already dropped it into keeps its copy.", "Delete")))
                    return;
                  removeCapture(capture.id).catch((error) => toast.error(`Couldn't delete the capture: ${error}`));
                }}
              >
                <Trash2 size={14} strokeWidth={1.5} aria-hidden="true" />
              </button>
            </div>
            {capture.text && <p className="capture-text">{capture.text}</p>}
            {capture.images.length > 0 && (
              <div className="capture-thumbs">
                {capture.images.map((file, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: a capture's images never reorder
                  <Thumb key={index} file={file} />
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
      {drag && (
        <div className="capture-ghost" style={{ left: drag.x + 12, top: drag.y + 12 }} aria-hidden="true">
          {drag.capture.text || `${drag.capture.images.length} image${drag.capture.images.length === 1 ? "" : "s"}`}
        </div>
      )}
    </aside>
  );
}
