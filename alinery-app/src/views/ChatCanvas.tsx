import type { Canvas, CanvasPanel } from "alinery-proto/alinery/v1/entities_pb";
import { Maximize2, Minimize2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CANVAS_SANDBOX, lockedLoader, withCanvasCsp } from "../canvasSandbox";
import { ChatMarkdown } from "../chat/CopyMessage";
import { ErrorBoundary } from "../ErrorBoundary";
import { closeCanvasPanel, readCanvasPanel } from "../sync/chat";
import { toast } from "../toast";
import { FilePanel, FilesPanel, Grid } from "./CanvasFiles";
import { errorMessage } from "./chatThreadSession";

type Body = { rev: bigint; kind: string; text?: string; error?: string };

/**
 * A panel's body, read again only when its rev moves; the last body stays up while the next one loads. The body
 * carries the kind it was read for: an agent can show a new kind under the same panel id, and drawing the old
 * markdown text as the new table would throw.
 */
function usePanelBody(repo: string, threadId: string, panel: CanvasPanel): Body | undefined {
  const [body, setBody] = useState<Body>();
  const { id, rev, kind } = panel;
  useEffect(() => {
    let live = true;
    readCanvasPanel(repo, threadId, id).then(
      (text) => live && setBody({ rev, kind, text }),
      (error: unknown) => live && setBody({ rev, kind, error: errorMessage(error) }),
    );
    return () => {
      live = false;
    };
  }, [repo, threadId, id, rev, kind]);
  return body;
}

function TablePanel({ text }: { text: string }) {
  const { columns, rows } = JSON.parse(text) as { columns: string[]; rows: unknown[][] };
  return <Grid columns={columns} rows={rows} />;
}

const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function ChartPanel({ text }: { text: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let done: (() => void) | undefined;
    let live = true;
    setError("");
    // vega-embed is about 800 KB: loaded the first time a chart shows, never at startup.
    Promise.all([import("vega-embed"), import("vega")])
      .then(async ([{ default: embed }, vega]) => {
        if (!live || !host.current) return;
        const ink = cssVar("--text-muted") || "#9b9b97";
        const result = await embed(host.current, JSON.parse(text), {
          actions: false,
          renderer: "svg",
          loader: lockedLoader(vega.loader()),
          config: {
            background: "transparent",
            view: { stroke: null },
            axis: { labelColor: ink, titleColor: ink, domainColor: ink, tickColor: ink, gridColor: cssVar("--border") || "#333" },
            legend: { labelColor: ink, titleColor: ink },
            title: { color: cssVar("--text") || ink },
          },
        });
        if (live) done = () => result.finalize();
        else result.finalize();
      })
      .catch((e: unknown) => live && setError(errorMessage(e)));
    return () => {
      live = false;
      done?.();
    };
  }, [text]);
  return error ? <p className="canvas-error">Chart failed: {error}</p> : <div ref={host} className="canvas-chart" />;
}

function PanelBody({ kind, text, title, where }: { kind: string; text: string; title: string; where: { repo: string; threadId: string; panel: string } }) {
  // Keyed by the body: showing a file again (a new size or time) reads it again.
  if (kind === "file") return <FilePanel key={text} where={where} text={text} />;
  if (kind === "files") return <FilesPanel key={text} where={where} text={text} />;
  if (kind === "markdown") return <ChatMarkdown text={text} />;
  if (kind === "table") return <TablePanel text={text} />;
  if (kind === "chart") return <ChartPanel text={text} />;
  if (kind === "html") return <iframe className="canvas-frame" sandbox={CANVAS_SANDBOX} referrerPolicy="no-referrer" srcDoc={withCanvasCsp(text)} title={title || "Canvas page"} />;
  return <p className="canvas-error">Unknown panel kind {kind}.</p>;
}

function CanvasSlot(props: { repo: string; threadId: string; panel: CanvasPanel; focused: boolean; maximised: boolean; onMaximise(): void }) {
  const { repo, threadId, panel } = props;
  const body = usePanelBody(repo, threadId, panel);
  const label = panel.title || `${panel.id} ${panel.kind}`;
  return (
    <section className="canvas-slot" data-kind={panel.kind} data-focus={props.focused ? "true" : undefined} aria-label={label}>
      <header className="canvas-slot-head">
        <span className="canvas-slot-title">{label}</span>
        <button
          type="button"
          className="chat-icon-btn"
          aria-label={props.maximised ? `Restore ${label}` : `Maximise ${label}`}
          title={props.maximised ? "Restore" : "Maximise"}
          onClick={props.onMaximise}
        >
          {props.maximised ? <Minimize2 size={14} aria-hidden="true" /> : <Maximize2 size={14} aria-hidden="true" />}
        </button>
        <button
          type="button"
          className="chat-icon-btn"
          aria-label={`Close ${label}`}
          title="Close"
          onClick={() => void closeCanvasPanel(repo, threadId, panel.id).catch((e: unknown) => toast.error(errorMessage(e)))}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </header>
      <div className="canvas-slot-body">
        {body?.error ? (
          <p className="canvas-error">{body.error}</p>
        ) : body?.text === undefined ? null : (
          // A panel that throws while drawing shows its error here; the rest of the app keeps running. A new body retries.
          <ErrorBoundary key={`${body.rev}:${body.kind}`} fallback={(error) => <p className="canvas-error">This panel could not be drawn: {errorMessage(error)}</p>}>
            <PanelBody kind={body.kind} text={body.text} title={label} where={{ repo, threadId, panel: panel.id }} />
          </ErrorBoundary>
        )}
      </div>
    </section>
  );
}

/** The thread's panels beside the chat: one fills the space, two and three split it in columns, four make a grid. */
export function ChatCanvas({ repo, threadId, canvas }: { repo: string; threadId: string; canvas: Canvas }) {
  const [maximised, setMaximised] = useState("");
  const panels = canvas.panels.some((p) => p.id === maximised) ? canvas.panels.filter((p) => p.id === maximised) : canvas.panels;
  if (panels.length === 0) {
    return (
      <div className="chat-canvas chat-canvas-empty" data-testid="chat-canvas">
        <p>The canvas is empty. Ask Ava to show something here: a chart, a table, a document, a small page, or files to preview and save.</p>
      </div>
    );
  }
  return (
    <div className="chat-canvas" data-testid="chat-canvas" data-count={panels.length}>
      {panels.map((panel) => (
        <CanvasSlot
          key={panel.id}
          repo={repo}
          threadId={threadId}
          panel={panel}
          focused={canvas.focus === panel.id}
          maximised={maximised === panel.id}
          onMaximise={() => setMaximised(maximised === panel.id ? "" : panel.id)}
        />
      ))}
    </div>
  );
}
