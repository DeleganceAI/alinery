// A chat thread's canvas: up to four panels the thread's agent writes beside the conversation. The user turns it on
// for one thread (`enableCanvas`, behind ChatService.EnableCanvas) and it stays on; the agent can only fill it. State is
// `sessions/<id>.canvas.json` (the `canvas/_/<id>` entity, and its existence is the switch), and each panel's body is a
// file in `sessions/<id>.canvas/` the page reads through BlobService. Bodies never travel through the transcript.
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "../platform/fs.ts";
import { DomainError } from "../platform/lock.ts";
import { loadChat } from "./chat.ts";
import { alineryDir } from "./taskFiles.ts";

export const PANEL_IDS = ["p1", "p2", "p3", "p4"] as const;
export type PanelId = (typeof PANEL_IDS)[number];
export const PANEL_KINDS = ["html", "table", "chart", "markdown"] as const;
export type PanelKind = (typeof PANEL_KINDS)[number];
const EXT: Record<PanelKind, string> = { html: "html", table: "table.json", chart: "vega.json", markdown: "md" };

export const MAX_PANEL_BYTES = 1024 * 1024;
export const MAX_TABLE_ROWS = 5000;
export const MAX_TABLE_COLUMNS = 50;
const MAX_TITLE = 120;
const KEEP_USER_CLOSED = 10;

export type Panel = { kind: PanelKind; title: string; rev: number; updated_at_ms: number };
export type CanvasFile = {
  v: 1;
  thread_id: string;
  enabled_at_ms: number;
  order: PanelId[];
  focus: PanelId | "";
  panels: Partial<Record<PanelId, Panel>>;
  /** Panels the user closed, newest last, so `canvas_get` can tell the agent. */
  user_closed: { panel: PanelId; title: string; at_ms: number }[];
};

const sessionsDir = (repo: string) => join(alineryDir(repo), "sessions");
export const canvasPath = (repo: string, id: string) => join(sessionsDir(repo), `${id}.canvas.json`);
export const canvasDir = (repo: string, id: string) => join(sessionsDir(repo), `${id}.canvas`);
/** The path the feed knows the canvas file by, relative to `.alinery/`. */
export const canvasRel = (id: string) => `sessions/${id}.canvas.json`;
export const canvasKey = (id: string) => `canvas/_/${id}`;

const isPanelId = (v: unknown): v is PanelId => PANEL_IDS.includes(v as PanelId);
const isKind = (v: unknown): v is PanelKind => PANEL_KINDS.includes(v as PanelKind);

/** The canvas file, or undefined when the thread has none (never enabled) or the file is not one. */
export function readCanvas(repo: string, id: string): CanvasFile | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(canvasPath(repo, id), "utf8"));
  } catch {
    return undefined;
  }
  return parseCanvas(raw, id);
}

/** A canvas file's JSON as the type, dropping what is malformed: the agent never wrote this file, but a person might. */
export function parseCanvas(raw: unknown, id: string): CanvasFile | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  if (o.v !== 1 || o.thread_id !== id) return undefined;
  const panels: CanvasFile["panels"] = {};
  const given = o.panels && typeof o.panels === "object" ? (o.panels as Record<string, unknown>) : {};
  for (const pid of PANEL_IDS) {
    const p = given[pid] as Record<string, unknown> | undefined;
    if (!p || !isKind(p.kind)) continue;
    panels[pid] = { kind: p.kind, title: typeof p.title === "string" ? p.title : "", rev: Number(p.rev) || 0, updated_at_ms: Number(p.updated_at_ms) || 0 };
  }
  const order = (Array.isArray(o.order) ? o.order : []).filter((p, i, all): p is PanelId => isPanelId(p) && panels[p] !== undefined && all.indexOf(p) === i);
  for (const pid of PANEL_IDS) if (panels[pid] && !order.includes(pid)) order.push(pid);
  const focus = isPanelId(o.focus) && panels[o.focus] ? o.focus : "";
  const closed = (Array.isArray(o.user_closed) ? o.user_closed : []).flatMap((c) =>
    c && typeof c === "object" && isPanelId((c as Record<string, unknown>).panel)
      ? [{ panel: (c as { panel: PanelId }).panel, title: String((c as Record<string, unknown>).title ?? ""), at_ms: Number((c as Record<string, unknown>).at_ms) || 0 }]
      : [],
  );
  return { v: 1, thread_id: id, enabled_at_ms: Number(o.enabled_at_ms) || 0, order, focus, panels, user_closed: closed };
}

export const canvasEnabled = (repo: string, id: string) => readCanvas(repo, id) !== undefined;

/** One write at a time per thread: two tool calls of one turn can run together, and each rewrites the whole file. */
const chains = new Map<string, Promise<unknown>>();
function serial<T>(id: string, run: () => T): Promise<T> {
  const next = (chains.get(id) ?? Promise.resolve()).catch(() => {}).then(run);
  chains.set(id, next);
  void next.finally(() => chains.get(id) === next && chains.delete(id)).catch(() => {});
  return next;
}

function load(repo: string, id: string): CanvasFile {
  const canvas = readCanvas(repo, id);
  if (!canvas) throw new DomainError("failed_precondition", "The canvas is not enabled for this thread. Only the user can turn it on, from the thread's header.");
  return canvas;
}

const save = (repo: string, canvas: CanvasFile) => writeAtomic(canvasPath(repo, canvas.thread_id), JSON.stringify(canvas, null, 2));

/** Turns the canvas on for a chat thread; true when it was off. There is no way back, by design. */
export function enableCanvas(repo: string, id: string, now = Date.now()): Promise<boolean> {
  loadChat(repo, id);
  return serial(id, () => {
    if (readCanvas(repo, id)) return false;
    mkdirSync(canvasDir(repo, id), { recursive: true });
    save(repo, { v: 1, thread_id: id, enabled_at_ms: now, order: [], focus: "", panels: {}, user_closed: [] });
    return true;
  });
}

// ---- panel bodies -----------------------------------------------------------------------------------------------------

type Cell = string | number | boolean | null;
export type TableBody = { columns: string[]; rows: Cell[][] };

const tooBig = (bytes: number) => new DomainError("invalid_argument", `panel body is ${bytes} bytes; the limit is ${MAX_PANEL_BYTES}`);

/** The file text for a panel of `kind`, or the refusal the agent reads. */
export function bodyText(kind: PanelKind, body: unknown): string {
  let text: string;
  if (kind === "html" || kind === "markdown") {
    if (typeof body !== "string") throw new DomainError("invalid_argument", `a ${kind} panel's body is a string`);
    text = body;
  } else if (kind === "table") {
    text = JSON.stringify(tableOf(body));
  } else {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new DomainError("invalid_argument", "a chart panel's body is a Vega-Lite spec object");
    const url = findUrl(body);
    if (url) throw new DomainError("invalid_argument", `chart panels take inline data only (data.values); found a URL at ${url}`);
    text = JSON.stringify(body);
  }
  const bytes = Buffer.byteLength(text);
  if (bytes > MAX_PANEL_BYTES) throw tooBig(bytes);
  return text;
}

function tableOf(body: unknown): TableBody {
  const b = body as Partial<TableBody> | undefined;
  if (!b || !Array.isArray(b.columns) || !Array.isArray(b.rows)) throw new DomainError("invalid_argument", "a table panel's body is { columns: string[], rows: cell[][] }");
  if (!b.columns.every((c) => typeof c === "string")) throw new DomainError("invalid_argument", "table columns are strings");
  if (b.columns.length > MAX_TABLE_COLUMNS) throw new DomainError("invalid_argument", `a table has at most ${MAX_TABLE_COLUMNS} columns`);
  if (b.rows.length > MAX_TABLE_ROWS) throw new DomainError("invalid_argument", `a table has at most ${MAX_TABLE_ROWS} rows`);
  for (const row of b.rows) {
    if (!Array.isArray(row) || row.length > b.columns.length) throw new DomainError("invalid_argument", "each table row is an array no longer than columns");
    if (!row.every((c) => c === null || ["string", "number", "boolean"].includes(typeof c))) throw new DomainError("invalid_argument", "table cells are strings, numbers, booleans or null");
  }
  return { columns: b.columns, rows: b.rows as Cell[][] };
}

/** The JSON path of the first `url`-like string in a spec, or "". The page's Vega loader refuses every fetch anyway; this tells the agent early. */
function findUrl(value: unknown, path = "spec"): string {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findUrl(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return "";
  }
  if (!value || typeof value !== "object") return "";
  for (const [k, v] of Object.entries(value)) {
    if ((k === "url" || k === "href") && typeof v === "string" && v) return `${path}.${k}`;
    const hit = findUrl(v, `${path}.${k}`);
    if (hit) return hit;
  }
  return "";
}

/** A panel's body file: what BlobService serves and `canvas_get` reads back. */
export function panelFile(repo: string, id: string, panel: string): { path: string; kind: PanelKind } {
  if (!isPanelId(panel)) throw new DomainError("invalid_argument", `invalid panel: ${panel}`);
  const p = readCanvas(repo, id)?.panels[panel];
  if (!p) throw new DomainError("not_found", `no panel ${panel}`);
  return { path: join(canvasDir(repo, id), `${panel}.${EXT[p.kind]}`), kind: p.kind };
}

// ---- the agent's writes -----------------------------------------------------------------------------------------------

const describe = (canvas: CanvasFile) => canvas.order.map((p) => `${p} (${canvas.panels[p]?.kind}: ${canvas.panels[p]?.title || "untitled"})`).join(", ");

/** Writes a panel: the given slot, or the first free one. The body lands before the state that points at it. */
export function putPanel(repo: string, id: string, input: { panel?: string; kind: PanelKind; title?: string; body: unknown }, now = Date.now()): Promise<{ panel: PanelId; rev: number }> {
  const text = bodyText(input.kind, input.body);
  const title = (input.title ?? "").trim().slice(0, MAX_TITLE);
  return serial(id, () => {
    const canvas = load(repo, id);
    let panel: PanelId | undefined;
    if (input.panel !== undefined && input.panel !== "") {
      if (!isPanelId(input.panel)) throw new DomainError("invalid_argument", `panel is one of ${PANEL_IDS.join(", ")}`);
      panel = input.panel;
    } else {
      panel = PANEL_IDS.find((p) => !canvas.panels[p]);
      if (!panel) throw new DomainError("failed_precondition", `the canvas has 4 panels: ${describe(canvas)}. Replace one by passing its id, or close one with alinery_canvas_layout.`);
    }
    const before = canvas.panels[panel];
    mkdirSync(canvasDir(repo, id), { recursive: true });
    if (before && before.kind !== input.kind) rmSync(join(canvasDir(repo, id), `${panel}.${EXT[before.kind]}`), { force: true });
    writeAtomic(join(canvasDir(repo, id), `${panel}.${EXT[input.kind]}`), text);
    const rev = (before?.rev ?? 0) + 1;
    canvas.panels[panel] = { kind: input.kind, title: title || before?.title || "", rev, updated_at_ms: now };
    if (!canvas.order.includes(panel)) canvas.order.push(panel);
    save(repo, canvas);
    return { panel, rev };
  });
}

/** Reorders, focuses and closes panels. Unknown or absent ids are refused, so the agent learns its view was stale. */
export function layoutCanvas(repo: string, id: string, input: { order?: string[]; focus?: string; close?: string[] }): Promise<CanvasFile> {
  return serial(id, () => {
    const canvas = load(repo, id);
    const known = (p: string): PanelId => {
      if (!isPanelId(p) || !canvas.panels[p]) throw new DomainError("invalid_argument", `no panel ${p}; the canvas has ${describe(canvas) || "no panels"}`);
      return p;
    };
    for (const p of (input.close ?? []).map(known)) removePanel(repo, canvas, p);
    if (input.order) {
      const order = input.order.map(known);
      if (new Set(order).size !== order.length || order.length !== canvas.order.length) throw new DomainError("invalid_argument", `order lists every open panel once: ${canvas.order.join(", ")}`);
      canvas.order = order;
    }
    if (input.focus !== undefined) canvas.focus = input.focus === "" ? "" : known(input.focus);
    save(repo, canvas);
    return canvas;
  });
}

function removePanel(repo: string, canvas: CanvasFile, panel: PanelId) {
  const p = canvas.panels[panel];
  if (p) rmSync(join(canvasDir(repo, canvas.thread_id), `${panel}.${EXT[p.kind]}`), { force: true });
  delete canvas.panels[panel];
  canvas.order = canvas.order.filter((x) => x !== panel);
  if (canvas.focus === panel) canvas.focus = "";
}

/** The user closed a panel in the page. The agent finds out from `canvas_get`. */
export function closePanelByUser(repo: string, id: string, panel: string, now = Date.now()): Promise<void> {
  loadChat(repo, id);
  return serial(id, () => {
    const canvas = load(repo, id);
    if (!isPanelId(panel) || !canvas.panels[panel]) return;
    canvas.user_closed = [...canvas.user_closed, { panel, title: canvas.panels[panel]?.title ?? "", at_ms: now }].slice(-KEEP_USER_CLOSED);
    removePanel(repo, canvas, panel);
    save(repo, canvas);
  });
}

/** What `canvas_get` answers: the layout, and the exact body of the panel asked for. */
export function canvasReport(repo: string, id: string, panel?: string): string {
  const canvas = load(repo, id);
  const lines = [`Canvas of thread ${id}: ${canvas.order.length} of 4 panels.`];
  for (const p of canvas.order) {
    const info = canvas.panels[p];
    if (info) lines.push(`- ${p}: ${info.kind} "${info.title}" rev ${info.rev}${canvas.focus === p ? " (focused)" : ""}`);
  }
  if (canvas.user_closed.length) lines.push(`The user closed: ${canvas.user_closed.map((c) => `${c.panel} "${c.title}"`).join(", ")}.`);
  if (panel) {
    const file = panelFile(repo, id, panel);
    lines.push("", `${panel} body (${file.kind}):`, existsSync(file.path) ? readFileSync(file.path, "utf8") : "(missing)");
  }
  return lines.join("\n");
}
