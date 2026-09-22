import { Check, Copy, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Chat bubble markdown: GFM formatting, no comment anchors/diff/mermaid machinery. */
export function ChatMarkdown({ text }: { text: string }) {
  const components = useMemo<Components>(
    () => ({
      a: ({ node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
    }),
    [],
  );
  return (
    <div className="md chat-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
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
