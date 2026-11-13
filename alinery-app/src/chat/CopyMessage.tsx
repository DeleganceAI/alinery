import type { Element, ElementContent } from "hast";
import { Check, Copy, TriangleAlert } from "lucide-react";
import { createContext, useContext, useMemo, useState } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

// Read the Markdown tree, not the DOM: nested copy controls must never enter copied text.
function markdownText(node: Element | ElementContent): string {
  if (node.type === "text") return node.value;
  if (node.type !== "element") return "";
  if (node.tagName === "br") return "\n";
  return node.children.map(markdownText).join("");
}

/**
 * What a view lets chat text open: `resolve` turns a path an agent wrote into a target the view knows exists (or null, and
 * the text stays plain), and `open` shows it, kept on a double click. Without a provider nothing links.
 */
export type PathLinks = { resolve: (path: string) => string | null; open: (target: string, keep: boolean) => void };
export const PathLinksContext = createContext<PathLinks | null>(null);

const EXTERNAL_HREF = /^(?:[a-z][a-z0-9+.-]*:|#)/i;

/** Chat bubble markdown: GFM formatting, no comment anchors/diff/mermaid machinery. Inline code and relative links that name a known file open it. */
export function ChatMarkdown({ text, showBlockCopyButtons = true, preserveLineBreaks = false }: { text: string; showBlockCopyButtons?: boolean; preserveLineBreaks?: boolean }) {
  const links = useContext(PathLinksContext);
  const components = useMemo<Components>(
    () => ({
      a: ({ node, href, ...props }) => {
        const target = links && href && !EXTERNAL_HREF.test(href) ? links.resolve(decodeURI(href)) : null;
        if (!target) return <a {...props} href={href} target="_blank" rel="noreferrer" />;
        return (
          <a
            {...props}
            href={href}
            className="chat-path-link"
            onClick={(event) => {
              event.preventDefault();
              links?.open(target, event.detail >= 2);
            }}
          />
        );
      },
      // A fenced block's text ends in a newline, so only inline code is a candidate.
      code: ({ node, children, ...props }) => {
        const path = typeof children === "string" && !props.className && !children.includes("\n") ? children : "";
        const target = links && path ? links.resolve(path) : null;
        if (!target) return <code {...props}>{children}</code>;
        return (
          <button type="button" className="chat-path-link" title={`Open ${path}`} onClick={(event) => links?.open(target, event.detail >= 2)}>
            <code {...props}>{children}</code>
          </button>
        );
      },
      pre: ({ node, children, ...props }) =>
        showBlockCopyButtons ? (
          <div className="chat-copyable-block">
            <pre {...props}>{children}</pre>
            <CopyTextButton text={node ? markdownText(node).replace(/\n$/, "") : ""} label="code block" />
          </div>
        ) : (
          <pre {...props}>{children}</pre>
        ),
      blockquote: ({ node, children, ...props }) =>
        showBlockCopyButtons ? (
          <blockquote {...props} className="chat-copyable-block">
            {children}
            <CopyTextButton text={node ? markdownText(node).replace(/^\n|\n$/g, "") : ""} label="quote" />
          </blockquote>
        ) : (
          <blockquote {...props}>{children}</blockquote>
        ),
    }),
    [showBlockCopyButtons, links],
  );
  return (
    <div className="md chat-md">
      <ReactMarkdown remarkPlugins={preserveLineBreaks ? [remarkGfm, remarkBreaks] : [remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

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

/** Copy button for arbitrary named values (row actions, artifact chrome). */
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

/** Chat row meta: bare icon, titled "Copy message". */
export function CopyChatMessageButton({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const statusLabel = state === "copied" ? "Copied message" : state === "failed" ? "Failed to copy message" : "Copy message";

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

/** Artifact chrome: label-style copy with its own copied/failed feedback. */
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
