import { Check, Copy, Maximize2, TriangleAlert } from "lucide-react";
import type { Mermaid } from "mermaid";
import type { ComponentProps, MouseEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { createElement, isValidElement, memo, useEffect, useId, useMemo, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
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
};

export type ArtifactCommentAnchor = {
  anchor_id: string;
  anchor_kind: string;
  anchor_label: string;
  anchor_excerpt: string;
  line_start: number;
  line_end: number;
};

export function formatArtifactCommentTarget(anchor: ArtifactCommentAnchor): string {
  const location =
    anchor.line_start > 0
      ? anchor.line_end > 0 && anchor.line_end !== anchor.line_start
        ? `Lines ${anchor.line_start}-${anchor.line_end}`
        : `Line ${anchor.line_start}`
      : "rendered block";
  const excerpt = anchor.anchor_excerpt.replace(/\s+/g, " ").trim();
  if (!excerpt) return `Add comment to ${location}`;
  return `Add comment to ${location}: "${excerpt}"`;
}

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
  const matchingComments = comments.filter((comment) => comment.anchor_id === anchor.anchor_id);
  const hasDraft = draftAnchorIds.includes(anchor.anchor_id);
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
    if (!onAddComment || event.defaultPrevented || ignoresBlockCommentClick(event.target)) return;
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
      onClick={handleClick}
      {...(onAddComment ? { tabIndex: 0, onKeyDown: handleRowKeyDown } : {})}
      title={
        hasDraft
          ? "Unsaved draft"
          : matchingComments.length > 0
            ? `${matchingComments.length} comment${matchingComments.length === 1 ? "" : "s"}`
            : onAddComment
              ? "Add comment — Enter"
              : undefined
      }
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
  return target instanceof Element && Boolean(target.closest("a, button, input, textarea, select, summary, .comment-popover"));
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
  const matchingComments = comments.filter((comment) => comment.anchor_id === anchor.anchor_id);
  const hasDraft = draftAnchorIds.includes(anchor.anchor_id);
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commentsId = useId();
  const [commentsOpen, setCommentsOpen] = useState(false);

  useEffect(() => {
    return () => {
      if (clickTimerRef.current != null) clearTimeout(clickTimerRef.current);
    };
  }, []);

  const classes = [
    "commentable-md-block",
    onAddComment ? "can-comment" : "",
    matchingComments.length > 0 ? "has-comments" : "",
    commentsOpen ? "comments-open" : "",
    hasDraft ? "has-draft" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const handleBlockClick = (event: MouseEvent<HTMLElement>) => {
    if (typeof originalOnClick === "function") {
      (originalOnClick as (event: MouseEvent<HTMLElement>) => void)(event);
    }
    if (!onAddComment || event.defaultPrevented || ignoresBlockCommentClick(event.target)) return;
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
      onClick: handleBlockClick,
      onDoubleClick: deferClickMs != null && deferClickMs > 0 ? handleBlockDoubleClick : undefined,
      ...(onAddComment ? { tabIndex: 0, title: "Add comment — Enter", onKeyDown: handleBlockKeyDown } : {}),
    },
    children,
    hasDraft ? <span className="comment-draft-badge">Draft</span> : null,
    matchingComments.length > 0 ? (
      <>
        <button
          type="button"
          className="comment-count-badge"
          aria-label={`${matchingComments.length} comment${matchingComments.length === 1 ? "" : "s"}`}
          aria-describedby={commentsId}
          aria-controls={commentsId}
          aria-expanded={commentsOpen}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setCommentsOpen(true);
          }}
          onFocus={() => setCommentsOpen(true)}
          onBlur={() => setCommentsOpen(false)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            setCommentsOpen(false);
          }}
        >
          {matchingComments.length}
        </button>
        <span className="comment-popover" id={commentsId} role="note">
          {matchingComments.map((comment) => (
            <span className="comment-popover-item" key={comment.id}>
              <span className="comment-popover-meta">Line {comment.line_start}</span>
              <span className="comment-popover-body">{comment.body}</span>
            </span>
          ))}
        </span>
      </>
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

type ArtifactMarkdownProps = {
  text: string;
  comments?: ArtifactComment[];
  draftAnchorIds?: string[];
  onAddComment?: (anchor: ArtifactCommentAnchor) => void;
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

function sameArtifactMarkdownProps(previous: ArtifactMarkdownProps, next: ArtifactMarkdownProps): boolean {
  return (
    previous.text === next.text &&
    previous.comments === next.comments &&
    sameDraftAnchorIds(previous.draftAnchorIds, next.draftAnchorIds) &&
    previous.onAddComment === next.onAddComment &&
    previous.onDiagramZoomOpenChange === next.onDiagramZoomOpenChange
  );
}

export const ArtifactMarkdown = memo(function ArtifactMarkdown({ text, comments = [], draftAnchorIds = [], onAddComment, onDiagramZoomOpenChange }: ArtifactMarkdownProps) {
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
    }),
    [comments, draftAnchorIds, onAddComment, openDiagramZoom],
  );
  return (
    <>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {body}
      </ReactMarkdown>
      {zoomSvgHtml != null && <DiagramZoomOverlay svgHtml={zoomSvgHtml} onClose={closeDiagramZoom} />}
    </>
  );
}, sameArtifactMarkdownProps);

export async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.left = "-9999px";
  area.style.top = "0";
  document.body.appendChild(area);
  area.select();
  try {
    if (!document.execCommand("copy")) throw new Error("copy command rejected");
  } finally {
    document.body.removeChild(area);
  }
}

export function CopyTextButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const statusLabel = state === "copied" ? `Copied ${label}` : state === "failed" ? `Failed to copy ${label}` : `Copy ${label}`;

  return (
    <button
      className="btn ghost small copy-value-button"
      type="button"
      disabled={!text}
      title={statusLabel}
      aria-label={statusLabel}
      onClick={async () => {
        try {
          await copyTextToClipboard(text);
          setState("copied");
        } catch {
          setState("failed");
        }
        window.setTimeout(() => setState("idle"), 1200);
      }}
    >
      {state === "copied" ? (
        <Check size={14} strokeWidth={2} aria-hidden="true" />
      ) : state === "failed" ? (
        <TriangleAlert size={14} strokeWidth={2} aria-hidden="true" />
      ) : (
        <Copy size={14} strokeWidth={1.5} aria-hidden="true" />
      )}
    </button>
  );
}

export function CopyArtifactButton({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  return (
    <button
      type="button"
      className="btn ghost small"
      disabled={!text}
      title={state === "failed" ? "Copy failed" : "Copy artifact markdown"}
      onClick={async () => {
        try {
          await copyTextToClipboard(text);
          setState("copied");
        } catch {
          setState("failed");
        }
        window.setTimeout(() => setState("idle"), 1200);
      }}
    >
      {state === "copied" ? "Copied" : state === "failed" ? "Failed" : "Copy"}
    </button>
  );
}
