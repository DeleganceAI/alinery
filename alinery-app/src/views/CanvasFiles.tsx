// A preview of a file by its type, with Save a copy (and, given its path, Copy path and Show in folder): the canvas's
// `file` and `files` panels, and a task's or session's file tab for what text cannot show. The bytes are a BlobService
// read, so a remote repository works the same; the office formats are read by officePreview.ts, and a deck is drawn
// to PDF by LibreOffice on the repository's machine when it has it (`readRenderedPdf`).
import type { BlobRef } from "alinery-proto/alinery/v1/blobs_pb";
import { lazy, type ReactNode, Suspense, useEffect, useState } from "react";
import { CANVAS_SANDBOX, withCanvasCsp } from "../canvasSandbox";
import { ChatMarkdown, CopyTextButton } from "../chat/CopyMessage";
import * as ipc from "../ipc";
import { docxMarkdown, parseCsv, pptxMarkdown, type Sheet, xlsxSheets } from "../officePreview";
import { isRemoteRepo } from "../remoteRepo";
import { canvasFileRef } from "../sync/chat";
import { MAX_PREVIEW_BYTES, readPreviewBytes, readRenderedPdf } from "../sync/tasks";
import { toast } from "../toast";
import { errorMessage } from "./chatThreadSession";
import { LIBREOFFICE_URL } from "./RuntimePanel";

// pdf.js is about 1.5 MB with its worker: loaded the first time a PDF shows.
const CanvasPdf = lazy(() => import("./CanvasPdf"));

type FileEntry = { path: string; size: number; mtime_ms: number };
type FilesBody = { dir: string; entries: FileEntry[]; truncated: boolean };
type Where = { repo: string; threadId: string; panel: string };

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
};
const MAX_TEXT_BYTES = 1024 * 1024;

const extOf = (name: string) => (name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : "");
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function Grid({ columns, rows }: { columns: string[]; rows: unknown[][] }) {
  return (
    <div className="canvas-table-wrap">
      <table className="canvas-table">
        <thead>
          <tr>
            {columns.map((c, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: columns may repeat a name
              <th key={i}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity
            <tr key={r}>
              {columns.map((_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: cells have no identity
                <td key={i}>{row[i] == null ? "" : String(row[i])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Rows shown under their first row, as wide as the widest. */
function RowsGrid({ rows }: { rows: string[][] }) {
  const width = Math.max(0, ...rows.map((r) => r.length));
  const [head = [], ...rest] = rows;
  return <Grid columns={Array.from({ length: width }, (_, i) => head[i] ?? "")} rows={rest} />;
}

function Sheets({ sheets }: { sheets: Sheet[] }) {
  const [at, setAt] = useState(0);
  const sheet = sheets[at];
  if (!sheet) return <p className="dim">This workbook has no sheets.</p>;
  return (
    <div className="canvas-sheets">
      {sheets.length > 1 && (
        <div className="canvas-sheet-tabs" role="tablist" aria-label="Sheets">
          {sheets.map((s, i) => (
            <button key={s.name} type="button" role="tab" aria-selected={i === at} className={i === at ? "active" : undefined} onClick={() => setAt(i)}>
              {s.name}
            </button>
          ))}
        </div>
      )}
      <RowsGrid rows={sheet.rows} />
      {sheet.truncated && <p className="dim">Only the first rows and columns are shown.</p>}
    </div>
  );
}

/** What an async preview step resolves to, while it runs and when it fails. */
function Later({ load }: { load: () => Promise<ReactNode> }) {
  const [state, setState] = useState<{ node?: ReactNode; error?: string }>({});
  useEffect(() => {
    let live = true;
    load().then(
      (node) => live && setState({ node }),
      (e: unknown) => live && setState({ error: errorMessage(e) }),
    );
    return () => {
      live = false;
    };
  }, [load]);
  if (state.error) return <p className="canvas-error">Couldn't preview this file: {state.error}</p>;
  return state.node === undefined ? <p className="dim">Reading…</p> : state.node;
}

function ImagePreview({ bytes, type, name }: { bytes: Uint8Array; type: string; name: string }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    // An SVG in an <img> runs no script and loads nothing.
    const made = URL.createObjectURL(new Blob([bytes], { type }));
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [bytes, type]);
  return url ? <img className="canvas-image" src={url} alt={name} /> : null;
}

const looksLikeText = (bytes: Uint8Array) => !bytes.subarray(0, 8000).includes(0);

const Pdf = ({ bytes }: { bytes: Uint8Array }) => (
  <Suspense fallback={<p className="dim">Loading the PDF viewer…</p>}>
    <CanvasPdf bytes={bytes} />
  </Suspense>
);

/** Presentations: LibreOffice draws them (domain/rendered.ts RENDERED_TYPES); a pptx also has its text to fall back on. */
const DECK_TYPES = ["pptx", "ppt", "odp", "key"];
const DECKS = new Set(DECK_TYPES);

/** Files text cannot show but this preview can: a file tab hands these to `FileView` instead of its text viewer. */
const RICH = new Set(["pdf", "xlsx", "xlsm", "docx", ...DECK_TYPES, ...Object.keys(IMAGE_TYPES).filter((e) => e !== "svg")]);
export const richPreview = (name: string) => RICH.has(extOf(name));

/** The slides as LibreOffice draws them, or the deck's text and why the slides are missing. */
async function deckPreview(ext: string, bytes: Uint8Array, render?: () => Promise<Uint8Array>): Promise<ReactNode> {
  let why = "Slides are drawn by LibreOffice, which this preview cannot reach.";
  if (render) {
    try {
      return <Pdf bytes={await render()} />;
    } catch (e) {
      why = errorMessage(e);
    }
  }
  const text = ext === "pptx" ? await pptxMarkdown(bytes) : "";
  return (
    <>
      <p className="dim canvas-deck-note">
        {why}{" "}
        <a
          href={LIBREOFFICE_URL}
          target="_blank"
          rel="noreferrer"
          onClick={(event) => {
            event.preventDefault();
            void ipc.openUrl(LIBREOFFICE_URL).catch((e: unknown) => toast.error(errorMessage(e)));
          }}
        >
          Get LibreOffice
        </a>
      </p>
      {text ? <ChatMarkdown text={text} /> : <p className="dim">Save a copy to open the deck.</p>}
    </>
  );
}

/** The preview for a file's bytes, chosen by its extension. `render` draws a deck to PDF. */
export function FilePreview({ name, bytes, render }: { name: string; bytes: Uint8Array; render?: () => Promise<Uint8Array> }) {
  const ext = extOf(name);
  const [load] = useState(() => {
    if (ext === "xlsx" || ext === "xlsm") return async () => <Sheets sheets={await xlsxSheets(bytes)} />;
    if (ext === "docx") return async () => <ChatMarkdown text={await docxMarkdown(bytes)} />;
    if (DECKS.has(ext)) return () => deckPreview(ext, bytes, render);
    return undefined;
  });
  if (load) return <Later load={load} />;
  if (ext === "pdf") return <Pdf bytes={bytes} />;
  const image = IMAGE_TYPES[ext];
  if (image) return <ImagePreview bytes={bytes} type={image} name={name} />;
  if (!looksLikeText(bytes)) return <p className="dim">No preview for this kind of file. Save a copy to open it.</p>;
  const cut = bytes.length > MAX_TEXT_BYTES;
  const text = new TextDecoder().decode(bytes.subarray(0, MAX_TEXT_BYTES));
  const note = cut ? <p className="dim">Only the first megabyte is shown.</p> : null;
  if (ext === "csv" || ext === "tsv") return <RowsGrid rows={parseCsv(text, ext === "tsv" ? "\t" : ",")} />;
  if (ext === "md" || ext === "markdown")
    return (
      <>
        <ChatMarkdown text={text} />
        {note}
      </>
    );
  if (ext === "html" || ext === "htm")
    return <iframe className="canvas-frame canvas-file-frame" sandbox={CANVAS_SANDBOX} referrerPolicy="no-referrer" srcDoc={withCanvasCsp(text)} title={name} />;
  return (
    <>
      <pre className="canvas-text">{text}</pre>
      {note}
    </>
  );
}

/** What a file view reads: the file's blob, its name, and (for Copy path and Show in folder) its path on its machine. */
export type FileSource = { repo: string; ref: BlobRef; name: string; path?: string; size?: number };

/** One file: its preview and what can be done with it. A `size` known up front past the limit skips the read. */
export function FileView({ repo, ref, name, path, size }: FileSource) {
  const [state, setState] = useState<{ bytes?: Uint8Array; total?: number; error?: string }>({});
  const [saving, setSaving] = useState(false);
  const known = size ?? state.total;
  const tooBig = known !== undefined && known > MAX_PREVIEW_BYTES;
  const skip = size !== undefined && size > MAX_PREVIEW_BYTES;
  useEffect(() => {
    if (skip) return;
    let live = true;
    setState({});
    readPreviewBytes(repo, ref).then(
      ({ bytes, total }) => live && setState({ bytes, total }),
      (e: unknown) => live && setState({ error: errorMessage(e) }),
    );
    return () => {
      live = false;
    };
  }, [repo, ref, skip]);

  const save = async () => {
    setSaving(true);
    try {
      const bytes = state.bytes ?? (await readPreviewBytes(repo, ref)).bytes;
      if (await ipc.saveFileDialog(name, bytes)) toast.success(`Saved ${name}`, "short");
    } catch (e) {
      toast.error(`Couldn't save ${name}: ${errorMessage(e)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="canvas-file">
      <div className="canvas-file-actions">
        <span className="canvas-file-name" title={path ?? name}>
          {name} {known !== undefined && <span className="dim">· {formatBytes(known)}</span>}
        </span>
        <button type="button" className="btn ghost small" disabled={saving || tooBig || (!state.bytes && !skip && !state.error)} onClick={() => void save()}>
          {saving ? "Saving…" : "Save a copy…"}
        </button>
        {path && <CopyTextButton text={path} label="path" />}
        {path && !isRemoteRepo(repo) && (
          <button type="button" className="btn ghost small" onClick={() => void ipc.revealItemInDir(path).catch((e: unknown) => toast.error(errorMessage(e)))}>
            Show in folder
          </button>
        )}
      </div>
      <div className="canvas-file-preview">
        {tooBig ? (
          <p className="dim">This file is larger than {formatBytes(MAX_PREVIEW_BYTES)}, too large to preview or save here. Open it from its folder.</p>
        ) : state.error ? (
          <p className="canvas-error">{state.error}</p>
        ) : state.bytes ? (
          <FilePreview key={name} name={name} bytes={state.bytes} render={() => readRenderedPdf(repo, ref)} />
        ) : (
          <p className="dim">Reading…</p>
        )}
      </div>
    </div>
  );
}

export function FilePanel({ where, text }: { where: Where; text: string }) {
  const body = JSON.parse(text) as FileEntry;
  const [ref] = useState(() => canvasFileRef(where.threadId, where.panel, ""));
  return <FileView repo={where.repo} ref={ref} name={baseName(body.path)} path={body.path} size={body.size} />;
}

function ListedFile({ where, dir, entry }: { where: Where; dir: string; entry: FileEntry }) {
  const [ref] = useState(() => canvasFileRef(where.threadId, where.panel, entry.path));
  return <FileView repo={where.repo} ref={ref} name={baseName(entry.path)} path={`${dir}/${entry.path}`} size={entry.size} />;
}

export function FilesPanel({ where, text }: { where: Where; text: string }) {
  const body = JSON.parse(text) as FilesBody;
  const [open, setOpen] = useState<FileEntry>();
  if (open)
    return (
      <div className="canvas-file">
        <button type="button" className="btn ghost small canvas-files-back" onClick={() => setOpen(undefined)}>
          ← All files
        </button>
        <ListedFile where={where} dir={body.dir} entry={open} />
      </div>
    );
  if (body.entries.length === 0) return <p className="dim">No files matched in {body.dir}.</p>;
  return (
    <div className="canvas-table-wrap">
      <table className="canvas-table canvas-files">
        <thead>
          <tr>
            <th>Name</th>
            <th>Size</th>
            <th>Modified</th>
          </tr>
        </thead>
        <tbody>
          {body.entries.map((e) => (
            <tr key={e.path}>
              <td>
                <button type="button" className="canvas-files-open" onClick={() => setOpen(e)}>
                  {e.path}
                </button>
              </td>
              <td>{formatBytes(e.size)}</td>
              <td>{new Date(e.mtime_ms).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {body.truncated && <p className="dim canvas-files-note">Only the first {body.entries.length} files are listed.</p>}
    </div>
  );
}
