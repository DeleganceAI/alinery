import { MessageSquare, PanelRightClose } from "lucide-react";
import { type KeyboardEvent, type PointerEvent, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ArtifactComment, type ArtifactCommentAnchor, locateCommentAnchor } from "./ArtifactMarkdown";
import { formatAbsolute, formatAge } from "./shared";
import { usePointerDrag } from "./usePointerDrag";

const OPEN_KEY = "alinery.commentsPanel";
const WIDTH_KEY = "alinery.commentsPanelWidth";
const WIDTH_MIN = 240;
const WIDTH_MAX = 720;
const clampWidth = (width: number) => Math.round(Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, width)));

/** The panel's dragged width, remembered like its open state; null until it is first dragged, when CSS sizes it. */
function usePanelWidth(panelRef: RefObject<HTMLElement | null>) {
  const [width, setWidthState] = useState<number | null>(() => {
    try {
      const saved = Number(localStorage.getItem(WIDTH_KEY));
      return saved > 0 ? clampWidth(saved) : null;
    } catch {
      return null;
    }
  });
  const { start } = usePointerDrag();
  const current = () => panelRef.current?.getBoundingClientRect().width ?? width ?? WIDTH_MIN;
  const save = (next: number) => {
    const clamped = clampWidth(next);
    setWidthState(clamped);
    try {
      localStorage.setItem(WIDTH_KEY, String(clamped));
    } catch {}
  };
  const resizer = {
    role: "separator" as const,
    "aria-orientation": "vertical" as const,
    "aria-label": "Resize comments",
    "aria-valuemin": WIDTH_MIN,
    "aria-valuemax": WIDTH_MAX,
    "aria-valuenow": width ?? undefined,
    tabIndex: 0,
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = current();
      // The panel is on the right, so dragging left widens it.
      const at = (clientX: number) => startWidth + startX - clientX;
      start(event, { onMove: (move) => setWidthState(clampWidth(at(move.clientX))), onComplete: (done) => save(at(done.clientX)) });
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      const step = event.key === "ArrowLeft" ? 20 : event.key === "ArrowRight" ? -20 : 0;
      if (!step) return;
      event.preventDefault();
      save(current() + step);
    },
  };
  return { width, resizer };
}

/** Whether the comments panel is open (remembered across artifacts and launches) and which thread it should show. */
export function useCommentsPanel() {
  // Storage can be unavailable; the panel then just forgets its state.
  const [open, setOpenState] = useState(() => {
    try {
      return localStorage.getItem(OPEN_KEY) !== "closed";
    } catch {
      return true;
    }
  });
  // An object, so asking for the same thread twice scrolls to it twice.
  const [focused, setFocused] = useState<{ anchorId: string } | null>(null);
  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    try {
      localStorage.setItem(OPEN_KEY, next ? "open" : "closed");
    } catch {}
  }, []);
  const openThread = useCallback((anchorId: string) => {
    setOpenState(true);
    setFocused({ anchorId });
  }, []);
  return { open, setOpen, focused, openThread };
}

/** Escape in a composer: back to what opened it, or to the thread's quote when that was a Reply button the composer replaced. */
export function focusCommentOpener(opener: HTMLElement | null) {
  (opener?.isConnected ? opener : document.querySelector<HTMLElement>(".comment-thread.writing .comment-thread-quote"))?.focus();
}

export function CommentsPanelToggle({ open, count, onToggle }: { open: boolean; count: number; onToggle?: () => void }) {
  const label = `${open ? "Hide" : "Show"} comments`;
  return (
    <button
      type="button"
      className={`btn ghost small comments-toggle${open ? " on" : ""}`}
      aria-pressed={open}
      aria-label={label}
      title={label}
      disabled={!onToggle}
      onClick={onToggle}
    >
      <MessageSquare size={16} strokeWidth={1.5} aria-hidden="true" />
      {count > 0 && <span className="comments-toggle-count">{count}</span>}
    </button>
  );
}

export type CommentsPanelDraft = ArtifactCommentAnchor & { body: string; stale?: boolean };

type Thread = { anchor: ArtifactCommentAnchor; comments: ArtifactComment[]; draft?: CommentsPanelDraft };

/** Comments that share an anchor are one conversation, oldest first: a reply is a comment at the same anchor. */
function threadsOf(comments: ArtifactComment[], drafts: CommentsPanelDraft[], active: ArtifactCommentAnchor | null): Thread[] {
  const threads = new Map<string, Thread>();
  const at = (anchor: ArtifactCommentAnchor) => {
    let thread = threads.get(anchor.anchor_id);
    if (!thread) {
      thread = { anchor, comments: [] };
      threads.set(anchor.anchor_id, thread);
    }
    return thread;
  };
  for (const comment of [...comments].sort((a, b) => a.created_at_ms - b.created_at_ms)) at(comment).comments.push(comment);
  for (const draft of drafts) at(draft).draft = draft;
  if (active) at(active);
  return [...threads.values()].sort((a, b) => a.anchor.line_start - b.anchor.line_start);
}

type Props = {
  comments: ArtifactComment[];
  /** Drafts left on other anchors than the open one. */
  drafts?: CommentsPanelDraft[];
  /** The anchor being written at, and its text. */
  active: ArtifactCommentAnchor | null;
  body: string;
  canSave: boolean;
  placeholder: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  focused: { anchorId: string } | null;
  onBodyChange: (body: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSave: () => void;
  onDiscard: () => void;
  /** Starts a reply or resumes a draft at an anchor. Absent on an artifact that takes no comments. */
  onOpen?: (anchor: ArtifactCommentAnchor) => void;
  onDiscardDraft?: (anchorId: string) => void;
  /** Absent while the panel cannot be put away (a comment that is not autosaved is being written). */
  onClose?: () => void;
};

/**
 * Every comment on the open artifact, beside it: one card per anchor in document order, replies one level deep, and the
 * composer inside the card it belongs to. It sits in an `.artifact-review` row next to the document, which is where a
 * click on a quote looks for the block to scroll to.
 */
export function ArtifactCommentsPanel({
  comments,
  drafts = [],
  active,
  body,
  canSave,
  placeholder,
  inputRef,
  focused,
  onBodyChange,
  onKeyDown,
  onSave,
  onDiscard,
  onOpen,
  onDiscardDraft,
  onClose,
}: Props) {
  const panelRef = useRef<HTMLElement>(null);
  const { width, resizer } = usePanelWidth(panelRef);
  const threads = useMemo(() => threadsOf(comments, drafts, active), [comments, drafts, active]);
  // Anchors a click could not find: the artifact changed under the comment.
  const [missing, setMissing] = useState<ReadonlySet<string>>(new Set());
  const shown = active?.anchor_id ?? focused?.anchorId;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `focused` is a new object per request, so the same thread scrolls again
  useEffect(() => {
    if (!shown) return;
    for (const card of panelRef.current?.querySelectorAll<HTMLElement>("[data-thread]") ?? []) {
      if (card.dataset.thread === shown) card.scrollIntoView?.({ block: "nearest" });
    }
  }, [shown, focused]);

  const locate = (anchorId: string) => {
    const review = panelRef.current?.closest(".artifact-review");
    // Raw view has no blocks to go to; that says nothing about the comment.
    if (!review?.querySelector("[data-anchor-id]")) return;
    const found = locateCommentAnchor(review, anchorId);
    setMissing((previous) => {
      if (previous.has(anchorId) !== found) return previous;
      const next = new Set(previous);
      if (found) next.delete(anchorId);
      else next.add(anchorId);
      return next;
    });
  };

  return (
    <aside className="comments-panel" aria-label="Comments" ref={panelRef} style={width ? { flexBasis: width } : undefined}>
      <div className="comments-panel-resizer" {...resizer} />
      <div className="comments-panel-head">
        <span className="comments-panel-title">Comments</span>
        {comments.length > 0 && <span className="comments-panel-count">{comments.length}</span>}
        {onClose && (
          <button type="button" className="btn ghost small comments-panel-close" aria-label="Hide comments" title="Hide comments" onClick={onClose}>
            <PanelRightClose size={16} strokeWidth={1.5} aria-hidden="true" />
          </button>
        )}
      </div>
      <div className="comments-panel-list">
        {threads.length === 0 && (
          <div className="comments-panel-empty">
            <div>No comments yet.</div>
            {onOpen && <div className="comments-panel-hint">Click a block, select text, or hold ⌥ and drag over an area.</div>}
          </div>
        )}
        {threads.map(({ anchor, comments: entries, draft }) => {
          const id = anchor.anchor_id;
          const writing = active?.anchor_id === id;
          const quote = (anchor.anchor_excerpt || anchor.anchor_label).replace(/\s+/g, " ").trim();
          return (
            <section key={id} data-thread={id} className={`comment-thread${writing ? " writing" : ""}${shown === id ? " shown" : ""}`}>
              <button type="button" className="comment-thread-quote" title="Show in the artifact" onClick={() => locate(id)}>
                {anchor.anchor_kind === "region" && <span className="comment-thread-kind">Area</span>}
                <span className="comment-thread-quote-text">{quote || "Rendered block"}</span>
              </button>
              {missing.has(id) && <div className="comment-thread-missing">This part of the artifact has changed.</div>}
              {entries.map((comment, index) => {
                const seconds = Math.floor(comment.created_at_ms / 1000);
                const name = comment.author ? comment.author.split("@")[0] : "You";
                return (
                  <div key={comment.id} className={`comment-entry${index > 0 ? " reply" : ""}`}>
                    <div className="comment-entry-head">
                      <span className="comment-avatar" aria-hidden="true">
                        {name.charAt(0).toUpperCase()}
                      </span>
                      <span className="comment-author" title={comment.author ?? undefined}>
                        {name}
                      </span>
                      {seconds > 0 && (
                        <time className="comment-time" dateTime={new Date(comment.created_at_ms).toISOString()} title={formatAbsolute(seconds)}>
                          {formatAge(seconds)}
                        </time>
                      )}
                    </div>
                    <div className="comment-body">{comment.body}</div>
                  </div>
                );
              })}
              {writing ? (
                <div className={`artifact-comment-composer${entries.length > 0 ? " reply" : ""}`}>
                  <textarea
                    ref={inputRef}
                    className="field-input artifact-comment-input"
                    value={body}
                    rows={2}
                    placeholder={entries.length > 0 ? "Reply..." : placeholder}
                    aria-label={entries.length > 0 ? "Reply" : "Comment"}
                    onChange={(event) => onBodyChange(event.target.value)}
                    onKeyDown={onKeyDown}
                  />
                  <div className="artifact-comment-actions">
                    <button type="button" className="btn small" disabled={!canSave} title="Save — ⌘↵" onClick={onSave}>
                      Save comment
                    </button>
                    <button type="button" className="btn ghost small" onClick={onDiscard}>
                      Discard draft
                    </button>
                  </div>
                </div>
              ) : draft ? (
                <div className="comment-thread-draft">
                  <span className="comment-thread-draft-body" title={draft.body}>
                    <span className="comment-thread-draft-label">Draft</span> {draft.body}
                  </span>
                  {draft.stale && <span className="comment-thread-draft-stale">Artifact changed</span>}
                  <div className="artifact-comment-actions">
                    {onOpen && (
                      <button type="button" className="btn ghost small" onClick={() => onOpen(draft)}>
                        Resume
                      </button>
                    )}
                    {onDiscardDraft && (
                      <button type="button" className="btn ghost small" onClick={() => onDiscardDraft(id)}>
                        Discard
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                onOpen && (
                  <button type="button" className="comment-reply-btn" onClick={() => onOpen(anchor)}>
                    Reply
                  </button>
                )
              )}
            </section>
          );
        })}
      </div>
    </aside>
  );
}
