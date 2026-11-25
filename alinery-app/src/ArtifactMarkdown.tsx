import { Maximize2, MessageSquarePlus } from "lucide-react";
import type { Mermaid } from "mermaid";
import type { ComponentProps, MouseEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { createContext, createElement, isValidElement, memo, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useAttachmentImageSrc } from "./AttachmentPreview";
import { APPEARANCE_EVENT } from "./appearance";
import { DiagramZoomOverlay } from "./DiagramZoomOverlay";
import { buildRenderedDiff, diffStatusForNode, hashText, isDiffCodeBlock, type MarkdownPositionNode, type RenderedDiff, type RenderedDiffStatus, takeChars } from "./diff";
import { LoadingState } from "./shared";

/** Delay mermaid single-click → comment so a following dblclick can cancel and open zoom (#133). */
const MERMAID_CLICK_DELAY_MS = 280;

function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trimStart();
}

function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function initMermaidTheme(mermaid: Mermaid) {
  const fontFamily = cssVar("--font-reading", "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif");
  const surface = cssVar("--surface", "#08090b");
  const surfaceSubtle = cssVar("--surface-subtle", "#1b1d21");
  const canvas = cssVar("--canvas", "#000104");
  const accent = cssVar("--accent", "#587aff");
  const text = cssVar("--text", "#f4f1ea");
  const textMuted = cssVar("--text-muted", "#9b9b97");

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    theme: "base",
    flowchart: { htmlLabels: true, useMaxWidth: true, curve: "basis" },
    themeVariables: {
      background: canvas,
      mainBkg: surfaceSubtle,
      primaryColor: surfaceSubtle,
      primaryBorderColor: textMuted,
      primaryTextColor: text,
      secondaryColor: surface,
      secondaryBorderColor: accent,
      secondaryTextColor: text,
      tertiaryColor: canvas,
      tertiaryBorderColor: textMuted,
      tertiaryTextColor: text,
      lineColor: textMuted,
      textColor: text,
      nodeBorder: textMuted,
      clusterBkg: surface,
      clusterBorder: textMuted,
      edgeLabelBackground: surface,
      fontFamily,
    },
  });
}

function removeMermaidTempNodes(id: string): void {
  for (const nodeId of [id, `d${id}`, `i${id}`]) {
    document.getElementById(nodeId)?.remove();
  }
}

const mermaidSvgCache = new Map<string, string>();
// Rendered SVGs bake theme colors in; an appearance change invalidates them all.
// Mounted diagrams re-render through the same event (see MermaidDiagram).
if (typeof window !== "undefined") {
  window.addEventListener(APPEARANCE_EVENT, () => mermaidSvgCache.clear());
}

let mermaidPromise: Promise<Mermaid> | null = null;
function loadMermaid(): Promise<Mermaid> {
  if (!mermaidPromise) mermaidPromise = import("mermaid").then((m) => m.default);
  return mermaidPromise;
}

function MermaidDiagram({ chart, onOpenZoom }: { chart: string; onOpenZoom: (svgHtml: string) => void }) {
  const reactId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [svg, setSvg] = useState(() => mermaidSvgCache.get(chart) ?? "");
  const [err, setErr] = useState("");
  // Bumped on appearance changes so a mounted diagram re-renders with the new
  // theme (the module-level listener has already cleared the SVG cache).
  const [themeEpoch, setThemeEpoch] = useState(0);
  useEffect(() => {
    const bump = () => setThemeEpoch((n) => n + 1);
    window.addEventListener(APPEARANCE_EVENT, bump);
    return () => window.removeEventListener(APPEARANCE_EVENT, bump);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const id = `artifact-mermaid-${reactId}`;
    const render = async () => {
      setErr("");
      const cached = mermaidSvgCache.get(chart);
      if (cached) {
        setSvg(cached);
        return;
      }
      try {
        const mermaid = await loadMermaid();
        initMermaidTheme(mermaid);
        const out = await mermaid.render(id, chart);
        mermaidSvgCache.set(chart, out.svg);
        if (!cancelled) setSvg(out.svg);
      } catch (e) {
        removeMermaidTempNodes(id);
        if (!cancelled) setErr(String(e));
      }
    };
    render();
    return () => {
      cancelled = true;
      removeMermaidTempNodes(id);
    };
  }, [chart, reactId, themeEpoch]);

  if (err) {
    return (
      <div className="mermaid-error">
        <div>Could not render Mermaid diagram.</div>
        <pre>{chart}</pre>
      </div>
    );
  }
  if (!svg) return <LoadingState label="Rendering diagram" state="composing" />;
  return (
    <div className="mermaid-diagram mermaid-diagram-zoomable" onDoubleClick={() => onOpenZoom(svg)}>
      <button
        type="button"
        className="mermaid-expand-btn btn ghost small"
        title="Expand diagram"
        aria-label="Expand diagram"
        onClick={(e) => {
          e.stopPropagation();
          onOpenZoom(svg);
        }}
      >
        <Maximize2 size={16} strokeWidth={1.5} aria-hidden="true" />
      </button>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: this is the only way to mount
          a mermaid diagram. `svg` is not user HTML — it is the output of mermaid.render(),
          which runs with securityLevel: "strict" (see mermaid.initialize above), so the
          markup is sanitised before it reaches here. */}
      <div dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
  );
}

type MarkdownCodeElement = { className?: string; children?: ReactNode };

export type ArtifactComment = {
  id: string;
  artifact: string;
  anchor_id: string;
  anchor_kind: string;
  anchor_label: string;
  anchor_excerpt: string;
  line_start: number;
  line_end: number;
  body: string;
  created_at_ms: number;
  /** Who wrote it, on a teammate's shared artifact. A local comment is always the user's own. */
  author?: string | null;
};

export type ArtifactCommentAnchor = {
  anchor_id: string;
  anchor_kind: string;
  anchor_label: string;
  anchor_excerpt: string;
  line_start: number;
  line_end: number;
};

/**
 * A comment on a selection or a dragged area still belongs to a block: its anchor id is `<kind>:<detail>@<block anchor id>`,
 * so the block shows its marker and the wire needs no new field. Comments that share an anchor id are one thread.
 */
export function commentBlockId(anchorId: string): string {
  const at = anchorId.indexOf("@");
  return at < 0 ? anchorId : anchorId.slice(at + 1);
}

/** The anchor of every rendered commentable block, for the gestures that start from the DOM (selection, area drag). */
const blockAnchors = new WeakMap<Element, ArtifactCommentAnchor>();
const BLOCK_SELECTOR = "[data-anchor-id]";
/** Marker chrome inside a block: never part of its text. */
const BLOCK_CHROME = ".comment-count-badge, .comment-draft-badge, .comment-region-box";

function findBlock(root: ParentNode, blockId: string): HTMLElement | null {
  for (const el of root.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)) if (el.dataset.anchorId === blockId) return el;
  return null;
}

/** Scrolls the document to a comment's block and marks it for a moment. False when the artifact no longer has that block. */
export function locateCommentAnchor(root: ParentNode | null | undefined, anchorId: string): boolean {
  const el = root ? findBlock(root, commentBlockId(anchorId)) : null;
  if (!el) return false;
  el.scrollIntoView?.({ block: "center", behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  el.classList.add("comment-located");
  window.setTimeout(() => el.classList.remove("comment-located"), 1400);
  return true;
}

/** `region:x,y,w,h@block`: an area of one block (a diagram, an image), in percent of the block's box. */
function regionBox(anchorId: string): { left: string; top: string; width: string; height: string } | null {
  const m = /^region:(\d+),(\d+),(\d+),(\d+)@/.exec(anchorId);
  return m ? { left: `${m[1]}%`, top: `${m[2]}%`, width: `${m[3]}%`, height: `${m[4]}%` } : null;
}

/** Opens a block's thread in the comments panel. Context, so the twenty block renderers need no extra prop. */
const OpenThreadContext = createContext<((anchorId: string) => void) | undefined>(undefined);

function hasTextSelection(): boolean {
  const selection = typeof window === "undefined" ? null : window.getSelection();
  return Boolean(selection && !selection.isCollapsed);
}

/** Set at mousedown while text is selected: that click only puts the selection away (the browser has collapsed it by `click`). */
let clickClearsSelection = false;

type CommentableTag = "h1" | "h2" | "h3" | "h4" | "p" | "li" | "blockquote" | "pre" | "div";

function textFromReactNode(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textFromReactNode).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textFromReactNode(node.props.children);
  return "";
}

function diffSourceRangeForNode(node: MarkdownPositionNode | undefined, diff: RenderedDiff): { line_start: number; line_end: number } {
  const start = node?.position?.start?.line ?? 0;
  const end = node?.position?.end?.line ?? 0;
  let line_start = 0;
  let line_end = 0;

  for (let line = start; line <= end; line += 1) {
    const sourceLine = diff.sourceLineByLine.get(line) ?? 0;
    if (sourceLine <= 0) continue;
    if (line_start === 0) line_start = sourceLine;
    line_end = sourceLine;
  }
  return { line_start, line_end: line_end || line_start };
}

function diffAnchorFromNode(kind: string, children: ReactNode, node: MarkdownPositionNode | undefined, diff: RenderedDiff, status: RenderedDiffStatus): ArtifactCommentAnchor {
  const normalized = textFromReactNode(children).replace(/\s+/g, " ").trim();
  const text = normalized || kind;
  const { line_start, line_end } = diffSourceRangeForNode(node, diff);
  return {
    anchor_id: `${kind}:${line_start}-${line_end}:${hashText(`${status}:${text}`)}`,
    anchor_kind: kind,
    anchor_label: takeChars(text, 120),
    anchor_excerpt: takeChars(text, 500),
    line_start,
    line_end,
  };
}

type DiffMarkdownBlockProps = {
  tag: CommentableTag;
  anchorKind: string;
  diff: RenderedDiff;
  node?: MarkdownPositionNode;
  comments: ArtifactComment[];
  draftAnchorIds: string[];
  onAddComment?: (anchor: ArtifactCommentAnchor) => void;
  className?: string;
  children?: ReactNode;
} & Record<string, unknown>;

function DiffMarkdownBlock({ tag, anchorKind, diff, node, comments, draftAnchorIds, onAddComment, className, children, ...props }: DiffMarkdownBlockProps) {
  const status = diffStatusForNode(node, diff);
  const statusClass = status === "context" ? "" : `diff-${status}`;
  return (
    <CommentableMarkdownBlock
      tag={tag}
      anchorKind={anchorKind}
      anchor={diffAnchorFromNode(anchorKind, children, node, diff, status)}
      comments={comments}
      draftAnchorIds={draftAnchorIds}
      onAddComment={onAddComment}
      className={["artifact-diff-node", statusClass, className].filter(Boolean).join(" ")}
      {...props}
    >
      {children}
    </CommentableMarkdownBlock>
  );
}

type DiffTableRowProps = ComponentProps<"tr"> & {
  node?: MarkdownPositionNode;
  diff: RenderedDiff;
  comments: ArtifactComment[];
  draftAnchorIds: string[];
  onAddComment?: (anchor: ArtifactCommentAnchor) => void;
};

function DiffTableRow({ node, diff, comments, draftAnchorIds, onAddComment, className, children, ...props }: DiffTableRowProps) {
  const { onClick: originalOnClick, ...rowProps } = props;
  const status = diffStatusForNode(node, diff);
  const statusClass = status === "context" ? "" : `diff-${status}`;
  const anchor = diffAnchorFromNode("diff-line", children, node, diff, status);
  const matchingComments = comments.filter((comment) => commentBlockId(comment.anchor_id) === anchor.anchor_id);
  const hasDraft = draftAnchorIds.some((id) => commentBlockId(id) === anchor.anchor_id);
  const classes = [
    "artifact-diff-table-row",
    onAddComment ? "can-comment" : "",
    matchingComments.length > 0 ? "has-comments" : "",
    hasDraft ? "has-draft" : "",
    statusClass,
    className,
  ]
    .filter(Boolean)
    .join(" ");
  const handleClick = (event: MouseEvent<HTMLTableRowElement>) => {
    if (typeof originalOnClick === "function") {
      originalOnClick(event);
    }
    if (!onAddComment || event.defaultPrevented || event.altKey || clickClearsSelection || hasTextSelection() || ignoresBlockCommentClick(event.target)) return;
    event.stopPropagation();
    onAddComment(anchor);
  };

  const handleRowKeyDown = (event: ReactKeyboardEvent<HTMLTableRowElement>) => {
    if (!onAddComment || (event.key !== "Enter" && event.key !== " ") || event.target !== event.currentTarget) return;
    event.preventDefault();
    onAddComment(anchor);
  };

  return (
    <tr
      {...rowProps}
      className={classes}
      data-anchor-id={anchor.anchor_id}
      ref={(el) => {
        if (el) blockAnchors.set(el, anchor);
      }}
      onClick={handleClick}
      {...(onAddComment ? { tabIndex: 0, onKeyDown: handleRowKeyDown } : {})}
    >
      {children}
    </tr>
  );
}

function RenderedDiffBlock({
  text,
  node,
  comments,
  draftAnchorIds,
  onAddComment,
}: {
  text: string;
  node?: MarkdownPositionNode;
  comments: ArtifactComment[];
  draftAnchorIds: string[];
  onAddComment?: (anchor: ArtifactCommentAnchor) => void;
}) {
  const diff = useMemo(() => buildRenderedDiff(text, node), [text, node]);
  const components = useMemo<Components>(
    () => ({
      h1: ({ node, ...props }) => (
        <DiffMarkdownBlock
          tag="h1"
          anchorKind="h1"
          node={node as MarkdownPositionNode | undefined}
          diff={diff}
          comments={comments}
          draftAnchorIds={draftAnchorIds}
          onAddComment={onAddComment}
          {...props}
        />
      ),
      h2: ({ node, ...props }) => (
        <DiffMarkdownBlock
          tag="h2"
          anchorKind="h2"
          node={node as MarkdownPositionNode | undefined}
          diff={diff}
          comments={comments}
          draftAnchorIds={draftAnchorIds}
          onAddComment={onAddComment}
          {...props}
        />
      ),
      h3: ({ node, ...props }) => (
        <DiffMarkdownBlock
          tag="h3"
          anchorKind="h3"
          node={node as MarkdownPositionNode | undefined}
          diff={diff}
          comments={comments}
          draftAnchorIds={draftAnchorIds}
          onAddComment={onAddComment}
          {...props}
        />
      ),
      h4: ({ node, ...props }) => (
        <DiffMarkdownBlock
          tag="h4"
          anchorKind="h4"
          node={node as MarkdownPositionNode | undefined}
          diff={diff}
          comments={comments}
          draftAnchorIds={draftAnchorIds}
          onAddComment={onAddComment}
          {...props}
        />
      ),
      p: ({ node, ...props }) => (
        <DiffMarkdownBlock
          tag="p"
          anchorKind="p"
          node={node as MarkdownPositionNode | undefined}
          diff={diff}
          comments={comments}
          draftAnchorIds={draftAnchorIds}
          onAddComment={onAddComment}
          {...props}
        />
      ),
      li: ({ node, ...props }) => (
        <DiffMarkdownBlock
          tag="li"
          anchorKind="li"
          node={node as MarkdownPositionNode | undefined}
          diff={diff}
          comments={comments}
          draftAnchorIds={draftAnchorIds}
          onAddComment={onAddComment}
          {...props}
        />
      ),
      blockquote: ({ node, ...props }) => (
        <DiffMarkdownBlock
          tag="blockquote"
          anchorKind="blockquote"
          node={node as MarkdownPositionNode | undefined}
          diff={diff}
          comments={comments}
          draftAnchorIds={draftAnchorIds}
          onAddComment={onAddComment}
          {...props}
        />
      ),
      pre: ({ node, ...props }) => (
        <DiffMarkdownBlock
          tag="pre"
          anchorKind="pre"
          node={node as MarkdownPositionNode | undefined}
          diff={diff}
          comments={comments}
          draftAnchorIds={draftAnchorIds}
          onAddComment={onAddComment}
          {...props}
        />
      ),
      tr: ({ node, ...props }) => (
        <DiffTableRow node={node as MarkdownPositionNode | undefined} diff={diff} comments={comments} draftAnchorIds={draftAnchorIds} onAddComment={onAddComment} {...props} />
      ),
    }),
    [comments, diff, draftAnchorIds, onAddComment],
  );

  return (
    <div className="artifact-diff">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {diff.markdown}
      </ReactMarkdown>
    </div>
  );
}

function anchorFromNode(kind: string, children: ReactNode, node: MarkdownPositionNode | undefined): ArtifactCommentAnchor {
  const normalized = textFromReactNode(children).replace(/\s+/g, " ").trim();
  const text = normalized || kind;
  const line_start = node?.position?.start?.line ?? 0;
  const line_end = node?.position?.end?.line ?? 0;
  return {
    anchor_id: `${kind}:${line_start}-${line_end}:${hashText(text)}`,
    anchor_kind: kind,
    anchor_label: takeChars(text, 120),
    anchor_excerpt: takeChars(text, 500),
    line_start,
    line_end,
  };
}

type CommentableMarkdownBlockProps = {
  tag: CommentableTag;
  anchorKind: string;
  anchor?: ArtifactCommentAnchor;
  anchorChildren?: ReactNode;
  children?: ReactNode;
  node?: MarkdownPositionNode;
  comments: ArtifactComment[];
  draftAnchorIds: string[];
  onAddComment?: (anchor: ArtifactCommentAnchor) => void;
  className?: string;
  /** When set, single-click schedules comment after this ms; dblclick cancels (mermaid zoom). */
  deferClickMs?: number;
  onBlockDoubleClick?: () => void;
} & Record<string, unknown>;

function ignoresBlockCommentClick(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("a, button, input, textarea, select, summary"));
}

function CommentableMarkdownBlock({
  tag,
  anchorKind,
  anchor: anchorOverride,
  anchorChildren,
  children,
  node,
  comments,
  draftAnchorIds,
  onAddComment,
  className,
  deferClickMs,
  onBlockDoubleClick,
  ...props
}: CommentableMarkdownBlockProps) {
  const { onClick: originalOnClick, ...blockProps } = props;
  const anchor = anchorOverride ?? anchorFromNode(anchorKind, anchorChildren ?? children, node);
  const matchingComments = comments.filter((comment) => commentBlockId(comment.anchor_id) === anchor.anchor_id);
  const hasDraft = draftAnchorIds.some((id) => commentBlockId(id) === anchor.anchor_id);
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openThread = useContext(OpenThreadContext);
  const regions = [...new Set(matchingComments.map((comment) => comment.anchor_id))].flatMap((id) => {
    const box = regionBox(id);
    return box ? [{ id, box }] : [];
  });

  useEffect(() => {
    return () => {
      if (clickTimerRef.current != null) clearTimeout(clickTimerRef.current);
    };
  }, []);

  const classes = ["commentable-md-block", onAddComment ? "can-comment" : "", matchingComments.length > 0 ? "has-comments" : "", hasDraft ? "has-draft" : "", className]
    .filter(Boolean)
    .join(" ");

  const handleBlockClick = (event: MouseEvent<HTMLElement>) => {
    if (typeof originalOnClick === "function") {
      (originalOnClick as (event: MouseEvent<HTMLElement>) => void)(event);
    }
    // A click that ends a text selection, or an Option-drag over an area, is that gesture's, not a comment on the block.
    if (!onAddComment || event.defaultPrevented || event.altKey || clickClearsSelection || hasTextSelection() || ignoresBlockCommentClick(event.target)) return;
    event.stopPropagation();
    if (deferClickMs != null && deferClickMs > 0) {
      if (clickTimerRef.current != null) clearTimeout(clickTimerRef.current);
      clickTimerRef.current = setTimeout(() => {
        clickTimerRef.current = null;
        onAddComment(anchor);
      }, deferClickMs);
      return;
    }
    onAddComment(anchor);
  };

  const handleBlockDoubleClick = (event: MouseEvent<HTMLElement>) => {
    if (clickTimerRef.current != null) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    // MermaidDiagram owns open-zoom on its own dblclick; wrapper only cancels scheduled comment.
    // If onBlockDoubleClick is provided, call it (escape hatch); otherwise do nothing extra.
    if (onBlockDoubleClick) {
      if (ignoresBlockCommentClick(event.target)) return;
      event.stopPropagation();
      onBlockDoubleClick();
    }
  };

  // Keyboard path (DESIGN.md: every playbook keyboard-only): commentable blocks
  // are focusable and Enter/Space opens the existing composer at this anchor.
  // No role="button": markdown blocks legally contain links/buttons, and a
  // button ancestor would make that nesting invalid for AT.
  const handleBlockKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!onAddComment || (event.key !== "Enter" && event.key !== " ") || event.target !== event.currentTarget) return;
    event.preventDefault();
    onAddComment(anchor);
  };

  return createElement(
    tag,
    {
      ...blockProps,
      className: classes,
      "data-anchor-id": anchor.anchor_id,
      ref: (el: Element | null) => {
        if (el) blockAnchors.set(el, anchor);
      },
      onClick: handleBlockClick,
      onDoubleClick: deferClickMs != null && deferClickMs > 0 ? handleBlockDoubleClick : undefined,
      // No tooltip: one on every paragraph interrupts reading. The panel's empty state says how to comment.
      ...(onAddComment ? { tabIndex: 0, "aria-description": "Press Enter to comment", onKeyDown: handleBlockKeyDown } : {}),
    },
    children,
    regions.map(({ id, box }) => <span key={id} className="comment-region-box" style={box} aria-hidden="true" />),
    hasDraft ? <span className="comment-draft-badge">Draft</span> : null,
    matchingComments.length > 0 ? (
      // The marker only says comments exist here; reading them is the panel's job, so nothing opens on hover.
      <button
        type="button"
        className="comment-count-badge"
        aria-label={`${matchingComments.length} comment${matchingComments.length === 1 ? "" : "s"}`}
        title="Show in comments"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          // The block's own thread first; otherwise the first comment on part of it.
          openThread?.((matchingComments.find((comment) => comment.anchor_id === anchor.anchor_id) ?? matchingComments[0]).anchor_id);
        }}
      >
        {matchingComments.length}
      </button>
    ) : null,
  );
}

type MarkdownPreProps = ComponentProps<"pre"> & {
  node?: MarkdownPositionNode;
  comments: ArtifactComment[];
  draftAnchorIds: string[];
  onAddComment?: (anchor: ArtifactCommentAnchor) => void;
  onOpenZoom: (svgHtml: string) => void;
};

function MarkdownPre({ children, comments, draftAnchorIds, onAddComment, onOpenZoom, node, ...props }: MarkdownPreProps) {
  const child = Array.isArray(children) ? children[0] : children;
  if (isValidElement<MarkdownCodeElement>(child)) {
    const className = child.props.className ?? "";
    const codeText = String(child.props.children ?? "");
    if (/\blanguage-mermaid\b/.test(className)) {
      return (
        <CommentableMarkdownBlock
          tag="div"
          anchorKind="mermaid"
          anchorChildren={children}
          node={node}
          comments={comments}
          draftAnchorIds={draftAnchorIds}
          onAddComment={onAddComment}
          deferClickMs={MERMAID_CLICK_DELAY_MS}
        >
          <MermaidDiagram chart={codeText.replace(/\n$/, "")} onOpenZoom={onOpenZoom} />
        </CommentableMarkdownBlock>
      );
    }
    if (isDiffCodeBlock(className, codeText)) {
      return <RenderedDiffBlock text={codeText} node={node as MarkdownPositionNode | undefined} comments={comments} draftAnchorIds={draftAnchorIds} onAddComment={onAddComment} />;
    }
  }
  return (
    <CommentableMarkdownBlock tag="pre" anchorKind="pre" node={node} comments={comments} draftAnchorIds={draftAnchorIds} onAddComment={onAddComment} {...props}>
      {children}
    </CommentableMarkdownBlock>
  );
}

/**
 * Attachment name an image `src` points at from inside artifact `artifactPath` (relative to artifacts/),
 * or null when it is absolute, has a scheme, escapes the root, or is not exactly attachments/<name>.
 * Decodes percent-escapes because mdast normalizes `a b.png` to `a%20b.png`; the daemon re-validates the name.
 */
export function attachmentNameFor(artifactPath: string | undefined, src: string | undefined): string | null {
  if (!src || src.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(src)) return null;
  const segments: string[] = [];
  for (const segment of [...(artifactPath ?? "").split("/").slice(0, -1), ...src.split("/")]) {
    if (segment === "..") {
      if (segments.pop() === undefined) return null;
    } else if (segment && segment !== ".") {
      segments.push(segment);
    }
  }
  if (segments.length !== 2 || segments[0] !== "attachments") return null;
  try {
    return decodeURIComponent(segments[1]);
  } catch {
    return null;
  }
}

type ArtifactImageProps = ComponentProps<"img"> & { repoPath?: string; taskSlug?: string; artifactPath?: string; attachmentNodeIds?: ReadonlyMap<string, string> };

// shortcut: only attachments/<name> at the artifact's namespace root resolves (the task's artifacts/, or for a tree
// artifact its parent/live-child/snapshot root, read by node id so only names in the current tree); any other image
// under artifacts/ keeps its literal src. Add a BlobRef target if harnesses write images elsewhere.
function ArtifactImage({ repoPath, taskSlug, artifactPath, attachmentNodeIds, alt, ...props }: ArtifactImageProps) {
  const resolved = repoPath && taskSlug ? attachmentNameFor(artifactPath, props.src) : null;
  const nodeId = resolved ? attachmentNodeIds?.get(resolved) : undefined;
  const name = attachmentNodeIds && !nodeId ? null : resolved;
  const { src, error } = useAttachmentImageSrc(repoPath ?? "", taskSlug ?? "", name ?? "", nodeId);
  if (name == null) return <img alt={alt} {...props} />;
  return <img alt={alt} {...props} src={src || undefined} title={error || props.title} />;
}

const TEXT_HIGHLIGHT = "artifact-comment";
/** The DOM event: `MouseEvent` in this file is React's. */
type DomMouseEvent = globalThis.MouseEvent;
type Box = { left: number; top: number; width: number; height: number };

const unspaced = (text: string) => text.replace(/\s+/g, "");

/** How many times `needle` starts in `hay` before `end`. */
function occurrencesBefore(hay: string, needle: string, end: number): number {
  let count = 0;
  for (let index = hay.indexOf(needle); index >= 0 && index < end; index = hay.indexOf(needle, index + 1)) count += 1;
  return count;
}

/**
 * Where a text comment's excerpt sits in the rendered document, searched from its block on. Whitespace is ignored on
 * both sides: a selection's text breaks lines where the DOM's does not. The id (`text:<hash>.<n>@block`) says which
 * occurrence in the block was selected, so a repeated phrase paints the right one.
 */
function findTextRange(root: HTMLElement, comment: ArtifactComment): Range | null {
  const start = findBlock(root, commentBlockId(comment.anchor_id));
  const needle = unspaced(comment.anchor_excerpt);
  if (!start || !needle) return null;
  const skip = Number(/^text:[0-9a-f]+\.(\d+)@/.exec(comment.anchor_id)?.[1] ?? 0);
  const limit = (start.textContent ?? "").length + needle.length;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  walker.currentNode = start;
  let hay = "";
  const at: Array<[Text, number]> = [];
  for (let node = walker.nextNode() as Text | null; node && hay.length < limit; node = walker.nextNode() as Text | null) {
    if (node.parentElement?.closest(BLOCK_CHROME)) continue;
    for (let i = 0; i < node.data.length; i += 1) {
      if (/\s/.test(node.data[i])) continue;
      hay += node.data[i];
      at.push([node, i]);
    }
  }
  let index = hay.indexOf(needle);
  for (let seen = 0; seen < skip && index >= 0; seen += 1) index = hay.indexOf(needle, index + 1);
  if (index < 0) return null;
  const range = document.createRange();
  range.setStart(at[index][0], at[index][1]);
  const end = at[index + needle.length - 1];
  range.setEnd(end[0], end[1] + 1);
  return range;
}

/**
 * The anchor of a dragged area. Over one diagram or image it is that part of the block, in percent of its box; over
 * plain text it is the innermost blocks the area touches, as one comment on their line range.
 */
function regionAnchor(root: HTMLElement, box: Box): ArtifactCommentAnchor | null {
  const hit = [...root.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.left < box.left + box.width && r.right > box.left && r.top < box.top + box.height && r.bottom > box.top;
  });
  const blocks = hit.filter((el) => blockAnchors.has(el) && !hit.some((other) => other !== el && el.contains(other)));
  const anchors = blocks.flatMap((el) => blockAnchors.get(el) ?? []);
  const first = anchors[0];
  if (!first) return null;
  if (anchors.length === 1) {
    if (!blocks[0].querySelector("svg, img")) return first;
    const r = blocks[0].getBoundingClientRect();
    const percent = (value: number, size: number) => Math.round(Math.min(100, Math.max(0, (value / size) * 100)));
    const x = percent(box.left - r.left, r.width);
    const y = percent(box.top - r.top, r.height);
    const w = Math.max(1, percent(box.left + box.width - r.left, r.width) - x);
    const h = Math.max(1, percent(box.top + box.height - r.top, r.height) - y);
    return {
      ...first,
      anchor_id: `region:${x},${y},${w},${h}@${first.anchor_id}`,
      anchor_kind: "region",
      anchor_label: takeChars(`Area at ${x}%, ${y}% (${w}% × ${h}%) of ${first.anchor_label}`, 120),
    };
  }
  const excerpt = takeChars(anchors.map((anchor) => anchor.anchor_excerpt).join("\n"), 500);
  const lines = anchors.flatMap((anchor) => [anchor.line_start, anchor.line_end]).filter((line) => line > 0);
  return {
    anchor_id: `region:${hashText(excerpt)}@${first.anchor_id}`,
    anchor_kind: "region",
    anchor_label: takeChars(`${anchors.length} blocks from: ${first.anchor_label}`, 120),
    anchor_excerpt: excerpt,
    line_start: lines.length ? Math.min(...lines) : 0,
    line_end: lines.length ? Math.max(...lines) : 0,
  };
}

/**
 * The comment gestures that are not a click on a block: select text and comment on exactly that, or hold Option and
 * drag over an area. Also paints saved text comments (CSS Custom Highlight API: no DOM is rewritten) and opens their
 * thread on a click. It renders a hidden marker as the document's last child and works on the marker's parent.
 */
function CommentGestures({
  comments,
  rendered,
  body,
  onAddComment,
}: {
  comments: ArtifactComment[];
  /** The `components` map and the text: when either changes, the document's text nodes may have been replaced. */
  rendered: unknown;
  body: string;
  onAddComment?: (anchor: ArtifactCommentAnchor) => void;
}) {
  const markerRef = useRef<HTMLSpanElement>(null);
  const openThread = useContext(OpenThreadContext);
  const [pick, setPick] = useState<{ anchor: ArtifactCommentAnchor; left: number; top: number } | null>(null);
  const [marquee, setMarquee] = useState<Box | null>(null);
  const textRanges = useRef<Array<{ id: string; range: Range }>>([]);

  // `rendered` and `body` are dependencies on purpose: a new `components` map remounts the blocks, and a range on a
  // replaced text node paints nothing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    const root = markerRef.current?.parentElement;
    const registry = typeof CSS === "undefined" ? undefined : CSS.highlights;
    if (!root || !registry || typeof Highlight === "undefined") return;
    const found = comments.flatMap((comment) => {
      const range = comment.anchor_kind === "text" ? findTextRange(root, comment) : null;
      return range ? [{ id: comment.anchor_id, range }] : [];
    });
    textRanges.current = found;
    // One registry entry for every mounted document: each adds and removes only its own ranges.
    const highlight = registry.get(TEXT_HIGHLIGHT) ?? new Highlight();
    registry.set(TEXT_HIGHLIGHT, highlight);
    for (const { range } of found) highlight.add(range);
    return () => {
      for (const { range } of found) highlight.delete(range);
      textRanges.current = [];
    };
  }, [comments, rendered, body]);

  useEffect(() => {
    const root = markerRef.current?.parentElement;
    if (!root) return;
    const blockOf = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(BLOCK_SELECTOR) ?? null;

    const offerSelection = () => {
      const selection = window.getSelection();
      const range = selection && !selection.isCollapsed && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
      const startBlock = range && root.contains(range.commonAncestorContainer) ? blockOf(range.startContainer) : null;
      const start = startBlock ? blockAnchors.get(startBlock) : undefined;
      const text = selection?.toString().replace(/\s+/g, " ").trim() ?? "";
      if (!range || !start || !text) return setPick(null);
      const endBlock = blockOf(range.endContainer);
      const end = (endBlock && blockAnchors.get(endBlock)) || start;
      const before = document.createRange();
      before.setStart(startBlock as HTMLElement, 0);
      before.setEnd(range.startContainer, range.startOffset);
      const nth = occurrencesBefore(unspaced(startBlock?.textContent ?? ""), unspaced(takeChars(text, 500)), unspaced(before.toString()).length);
      const rects = range.getClientRects?.();
      const last = rects?.[rects.length - 1] ?? range.getBoundingClientRect?.();
      setPick({
        anchor: {
          anchor_id: `text:${hashText(text)}.${nth}@${start.anchor_id}`,
          anchor_kind: "text",
          anchor_label: takeChars(text, 120),
          anchor_excerpt: takeChars(text, 500),
          line_start: start.line_start,
          line_end: Math.max(start.line_end, end.line_end),
        },
        left: Math.max(8, Math.min(last?.right ?? 0, window.innerWidth - 128)),
        top: (last?.bottom ?? 0) + 6,
      });
    };
    // After the event: a click inside an old selection collapses it only once mouseup has returned.
    const onMouseUp = () => window.setTimeout(offerSelection, 0);
    const dismiss = () => setPick(null);
    const onSelectionChange = () => {
      if (!hasTextSelection()) setPick(null);
    };

    let endDrag = () => {};
    const onMouseDown = (down: DomMouseEvent) => {
      clickClearsSelection = hasTextSelection();
      if (!down.altKey || down.button !== 0) return;
      down.preventDefault();
      const boxTo = (event: DomMouseEvent): Box => ({
        left: Math.min(down.clientX, event.clientX),
        top: Math.min(down.clientY, event.clientY),
        width: Math.abs(event.clientX - down.clientX),
        height: Math.abs(event.clientY - down.clientY),
      });
      const move = (event: DomMouseEvent) => setMarquee(boxTo(event));
      endDrag = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        window.removeEventListener("blur", endDrag);
        setMarquee(null);
      };
      const up = (event: DomMouseEvent) => {
        endDrag();
        const box = boxTo(event);
        const anchor = box.width < 6 && box.height < 6 ? null : regionAnchor(root, box);
        if (anchor) onAddComment?.(anchor);
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
      // A mouseup lost to another window must not leave a drag that the next click finishes.
      window.addEventListener("blur", endDrag);
    };

    // Capture, and stopped here: a click on commented text opens its thread instead of a new comment on the block.
    const onClick = (event: DomMouseEvent) => {
      if (!openThread || event.altKey || hasTextSelection() || textRanges.current.length === 0) return;
      if (event.target instanceof Element && event.target.closest("a, button")) return;
      const caret = document.caretRangeFromPoint?.(event.clientX, event.clientY);
      const hit = caret ? textRanges.current.find(({ range }) => range.isPointInRange(caret.startContainer, caret.startOffset)) : undefined;
      if (!hit) return;
      event.stopPropagation();
      openThread(hit.id);
    };

    root.addEventListener("click", onClick, true);
    if (onAddComment) {
      root.addEventListener("mouseup", onMouseUp);
      root.addEventListener("keyup", offerSelection);
      root.addEventListener("mousedown", onMouseDown);
      root.addEventListener("scroll", dismiss);
      document.addEventListener("selectionchange", onSelectionChange);
    }
    return () => {
      endDrag();
      root.removeEventListener("click", onClick, true);
      root.removeEventListener("mouseup", onMouseUp);
      root.removeEventListener("keyup", offerSelection);
      root.removeEventListener("mousedown", onMouseDown);
      root.removeEventListener("scroll", dismiss);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [onAddComment, openThread]);

  return (
    <>
      <span ref={markerRef} hidden />
      {pick &&
        onAddComment &&
        createPortal(
          <button
            type="button"
            className="btn small comment-pick-btn"
            style={{ left: pick.left, top: pick.top }}
            // Keeps the selection (and its highlight) until the click lands.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              onAddComment(pick.anchor);
              setPick(null);
            }}
          >
            <MessageSquarePlus size={16} strokeWidth={1.5} aria-hidden="true" /> Comment
          </button>,
          document.body,
        )}
      {marquee && createPortal(<div className="comment-marquee" style={marquee} aria-hidden="true" />, document.body)}
    </>
  );
}

type ArtifactMarkdownProps = {
  text: string;
  /** The repo and the owner of the attachments dir plus the artifact's name relative to artifacts/, so relative images resolve. */
  repoPath?: string;
  taskSlug?: string;
  artifactPath?: string;
  /** Tree artifacts only: attachment name -> tree node id in its namespace root (`taskSlug` is then the viewing task); unlisted names stay unresolved. */
  attachmentNodeIds?: ReadonlyMap<string, string>;
  comments?: ArtifactComment[];
  draftAnchorIds?: string[];
  onAddComment?: (anchor: ArtifactCommentAnchor) => void;
  /** A click on a block's comment marker, or on commented text: show that thread in the comments panel. */
  onOpenThread?: (anchorId: string) => void;
  onDiagramZoomOpenChange?: (open: boolean) => void;
};

function sameDraftAnchorIds(previous: string[] | undefined, next: string[] | undefined): boolean {
  const length = previous?.length ?? 0;
  if (length !== (next?.length ?? 0)) return false;
  for (let index = 0; index < length; index += 1) {
    if (previous?.[index] !== next?.[index]) return false;
  }
  return true;
}

function sameAttachmentNodeIds(previous: ReadonlyMap<string, string> | undefined, next: ReadonlyMap<string, string> | undefined): boolean {
  if (previous === next) return true;
  if (!previous || !next || previous.size !== next.size) return false;
  for (const [name, id] of previous) {
    if (next.get(name) !== id) return false;
  }
  return true;
}

function sameArtifactMarkdownProps(previous: ArtifactMarkdownProps, next: ArtifactMarkdownProps): boolean {
  return (
    previous.text === next.text &&
    previous.repoPath === next.repoPath &&
    previous.taskSlug === next.taskSlug &&
    previous.artifactPath === next.artifactPath &&
    sameAttachmentNodeIds(previous.attachmentNodeIds, next.attachmentNodeIds) &&
    previous.comments === next.comments &&
    sameDraftAnchorIds(previous.draftAnchorIds, next.draftAnchorIds) &&
    previous.onAddComment === next.onAddComment &&
    previous.onOpenThread === next.onOpenThread &&
    previous.onDiagramZoomOpenChange === next.onDiagramZoomOpenChange
  );
}

export const ArtifactMarkdown = memo(function ArtifactMarkdown({
  text,
  repoPath,
  taskSlug,
  artifactPath,
  attachmentNodeIds,
  comments = [],
  draftAnchorIds = [],
  onAddComment,
  onOpenThread,
  onDiagramZoomOpenChange,
}: ArtifactMarkdownProps) {
  const body = useMemo(() => stripFrontmatter(text), [text]);
  const [zoomSvgHtml, setZoomSvgHtml] = useState<string | null>(null);

  const openDiagramZoom = useMemo(
    () => (svgHtml: string) => {
      setZoomSvgHtml(svgHtml);
      onDiagramZoomOpenChange?.(true);
    },
    [onDiagramZoomOpenChange],
  );

  const closeDiagramZoom = useMemo(
    () => () => {
      setZoomSvgHtml(null);
      onDiagramZoomOpenChange?.(false);
    },
    [onDiagramZoomOpenChange],
  );

  // Notify parent on unmount if zoom was still open (stuck-open guard for hotkeys).
  const zoomOpenRef = useRef(false);
  zoomOpenRef.current = zoomSvgHtml != null;
  const onZoomOpenChangeRef = useRef(onDiagramZoomOpenChange);
  onZoomOpenChangeRef.current = onDiagramZoomOpenChange;
  useEffect(() => {
    return () => {
      if (zoomOpenRef.current) onZoomOpenChangeRef.current?.(false);
    };
  }, []);

  const components = useMemo<Components>(
    () => ({
      h1: ({ node, ...props }) => (
        <CommentableMarkdownBlock
          tag="h1"
          anchorKind="h1"
          node={node as MarkdownPositionNode | undefined}
          comments={comments}
          draftAnchorIds={draftAnchorIds}
          onAddComment={onAddComment}
          {...props}
        />
      ),
      h2: ({ node, ...props }) => (
        <CommentableMarkdownBlock
          tag="h2"
          anchorKind="h2"
          node={node as MarkdownPositionNode | undefined}
          comments={comments}
          draftAnchorIds={draftAnchorIds}
          onAddComment={onAddComment}
          {...props}
        />
      ),
      h3: ({ node, ...props }) => (
        <CommentableMarkdownBlock
          tag="h3"
          anchorKind="h3"
          node={node as MarkdownPositionNode | undefined}
          comments={comments}
          draftAnchorIds={draftAnchorIds}
          onAddComment={onAddComment}
          {...props}
        />
      ),
      h4: ({ node, ...props }) => (
        <CommentableMarkdownBlock
          tag="h4"
          anchorKind="h4"
          node={node as MarkdownPositionNode | undefined}
          comments={comments}
          draftAnchorIds={draftAnchorIds}
          onAddComment={onAddComment}
          {...props}
        />
      ),
      p: ({ node, ...props }) => (
        <CommentableMarkdownBlock
          tag="p"
          anchorKind="p"
          node={node as MarkdownPositionNode | undefined}
          comments={comments}
          draftAnchorIds={draftAnchorIds}
          onAddComment={onAddComment}
          {...props}
        />
      ),
      li: ({ node, ...props }) => (
        <CommentableMarkdownBlock
          tag="li"
          anchorKind="li"
          node={node as MarkdownPositionNode | undefined}
          comments={comments}
          draftAnchorIds={draftAnchorIds}
          onAddComment={onAddComment}
          {...props}
        />
      ),
      blockquote: ({ node, ...props }) => (
        <CommentableMarkdownBlock
          tag="blockquote"
          anchorKind="blockquote"
          node={node as MarkdownPositionNode | undefined}
          comments={comments}
          draftAnchorIds={draftAnchorIds}
          onAddComment={onAddComment}
          {...props}
        />
      ),
      pre: ({ node, ...props }) => (
        <MarkdownPre
          node={node as MarkdownPositionNode | undefined}
          comments={comments}
          draftAnchorIds={draftAnchorIds}
          onAddComment={onAddComment}
          onOpenZoom={openDiagramZoom}
          {...props}
        />
      ),
      img: ({ node, ...props }) => <ArtifactImage repoPath={repoPath} taskSlug={taskSlug} artifactPath={artifactPath} attachmentNodeIds={attachmentNodeIds} {...props} />,
    }),
    [comments, draftAnchorIds, onAddComment, openDiagramZoom, repoPath, taskSlug, artifactPath, attachmentNodeIds],
  );
  return (
    <OpenThreadContext.Provider value={onOpenThread}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {body}
      </ReactMarkdown>
      <CommentGestures comments={comments} rendered={components} body={body} onAddComment={onAddComment} />
      {zoomSvgHtml != null && <DiagramZoomOverlay svgHtml={zoomSvgHtml} onClose={closeDiagramZoom} />}
    </OpenThreadContext.Provider>
  );
}, sameArtifactMarkdownProps);
