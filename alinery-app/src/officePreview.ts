// Read-only previews of office files for the canvas, with what the webview already has: a zip's entries through
// DecompressionStream, their XML through DOMParser. Values and text only: no styles, formulas, images or layout. A
// spreadsheet date shows as its serial number. Rendering a deck as slides is LibreOffice's job (plan Phase 4).

/** A preview grid's bounds: the same as a table panel's (domain/canvas.ts). */
export const MAX_ROWS = 5000;
export const MAX_COLUMNS = 50;

type Zip = { names: string[]; text(name: string): Promise<string | undefined> };

/** The entries of a zip (no zip64: an office file never needs it). */
export function readZip(bytes: Uint8Array): Zip {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("not a zip file");
  const entries = new Map<string, { method: number; size: number; local: number }>();
  let at = view.getUint32(end + 16, true);
  for (let n = view.getUint16(end + 10, true); n > 0; n--) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error("damaged zip directory");
    const nameLen = view.getUint16(at + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen));
    entries.set(name, { method: view.getUint16(at + 10, true), size: view.getUint32(at + 20, true), local: view.getUint32(at + 42, true) });
    at += 46 + nameLen + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return {
    names: [...entries.keys()],
    async text(name) {
      const e = entries.get(name);
      if (!e) return undefined;
      const start = e.local + 30 + view.getUint16(e.local + 26, true) + view.getUint16(e.local + 28, true);
      const raw = bytes.slice(start, start + e.size);
      if (e.method === 0) return new TextDecoder().decode(raw);
      if (e.method !== 8) throw new Error(`unsupported zip compression ${e.method}`);
      if (typeof DecompressionStream === "undefined") throw new Error("this macOS's WebKit cannot unzip files; save a copy to open it");
      return new Response(new Response(raw).body?.pipeThrough(new DecompressionStream("deflate-raw"))).text();
    },
  };
}

const xml = (text: string) => new DOMParser().parseFromString(text, "application/xml");
const all = (node: Document | Element, local: string) => [...node.getElementsByTagNameNS("*", local)];
const attr = (el: Element, local: string) => el.getAttribute(local) ?? [...el.attributes].find((a) => a.localName === local)?.value ?? "";
/** The `r:id` that points into a part's relationships (a slide id also has a plain `id`). */
const relId = (el: Element) => [...el.attributes].find((a) => a.localName === "id" && a.namespaceURI)?.value ?? "";

/** A part's relationships: id to the zip path of its target. */
async function rels(zip: Zip, part: string): Promise<Map<string, string>> {
  const dir = part.slice(0, part.lastIndexOf("/") + 1);
  const text = await zip.text(`${dir}_rels/${part.slice(dir.length)}.rels`);
  const out = new Map<string, string>();
  if (!text) return out;
  for (const r of all(xml(text), "Relationship")) {
    const target = attr(r, "Target");
    out.set(attr(r, "Id"), target.startsWith("/") ? target.slice(1) : normalize(dir + target));
  }
  return out;
}

function normalize(path: string): string {
  const parts: string[] = [];
  for (const p of path.split("/")) {
    if (p === "..") parts.pop();
    else if (p !== ".") parts.push(p);
  }
  return parts.join("/");
}

export type Sheet = { name: string; rows: string[][]; truncated: boolean };

const columnIndex = (ref: string) => [...(ref.match(/^[A-Z]+/)?.[0] ?? "A")].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;

export async function xlsxSheets(bytes: Uint8Array): Promise<Sheet[]> {
  const zip = readZip(bytes);
  const book = await zip.text("xl/workbook.xml");
  if (!book) throw new Error("not a spreadsheet");
  const targets = await rels(zip, "xl/workbook.xml");
  const sharedText = await zip.text("xl/sharedStrings.xml");
  const shared = sharedText
    ? all(xml(sharedText), "si").map((si) =>
        all(si, "t")
          .map((t) => t.textContent ?? "")
          .join(""),
      )
    : [];
  const sheets: Sheet[] = [];
  for (const s of all(xml(book), "sheet")) {
    const part = targets.get(relId(s));
    const text = part ? await zip.text(part) : undefined;
    if (!text) continue;
    const rows: string[][] = [];
    let truncated = false;
    for (const row of all(xml(text), "row")) {
      const r = Number(attr(row, "r")) - 1 || rows.length;
      if (r >= MAX_ROWS) {
        truncated = true;
        break;
      }
      const cells: string[] = [];
      for (const [i, c] of all(row, "c").entries()) {
        const col = attr(c, "r") ? columnIndex(attr(c, "r")) : i;
        if (col >= MAX_COLUMNS) {
          truncated = true;
          continue;
        }
        const type = attr(c, "t");
        const v = all(c, "v")[0]?.textContent ?? "";
        cells[col] =
          type === "s"
            ? (shared[Number(v)] ?? "")
            : type === "inlineStr"
              ? all(c, "t")
                  .map((t) => t.textContent ?? "")
                  .join("")
              : type === "b"
                ? v === "1"
                  ? "TRUE"
                  : "FALSE"
                : v;
      }
      rows[r] = Array.from(cells, (c) => c ?? "");
    }
    sheets.push({ name: attr(s, "name") || `Sheet ${sheets.length + 1}`, rows: Array.from(rows, (r) => r ?? []), truncated });
  }
  return sheets;
}

const paragraphText = (p: Element) =>
  [...p.getElementsByTagNameNS("*", "*")]
    .map((el) => (el.localName === "t" ? (el.textContent ?? "") : el.localName === "tab" ? "\t" : el.localName === "br" ? "  \n" : ""))
    .join("");

/** A Word document as Markdown: headings, list items, paragraphs and tables. */
export async function docxMarkdown(bytes: Uint8Array): Promise<string> {
  const text = await readZip(bytes).text("word/document.xml");
  if (!text) throw new Error("not a Word document");
  const body = all(xml(text), "body")[0];
  const out: string[] = [];
  for (const block of body ? [...body.children] : []) {
    if (block.localName === "p") {
      const line = paragraphText(block).trim();
      if (!line) continue;
      const style = attr(all(block, "pStyle")[0] ?? block, "val");
      const level = /^(?:heading\s*(\d)|title)$/i.exec(style);
      // A list item numbers itself (numPr) or takes a list style, which numbers it.
      const item = all(block, "numPr").length > 0 || /^list/i.test(style);
      out.push(level ? `${"#".repeat(Number(level[1] ?? 1))} ${line}` : item ? `- ${line}` : line);
    } else if (block.localName === "tbl") {
      const rows = all(block, "tr").map((tr) => all(tr, "tc").map((tc) => all(tc, "p").map(paragraphText).join(" ").replace(/\|/g, "\\|").trim()));
      if (rows.length === 0) continue;
      const width = Math.max(...rows.map((r) => r.length));
      const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
      out.push([line(rows[0] ?? []), line(Array(width).fill("---")), ...rows.slice(1).map(line)].join("\n"));
    }
  }
  return out.join("\n\n");
}

/** A deck's text as Markdown, one section per slide in the deck's order. */
export async function pptxMarkdown(bytes: Uint8Array): Promise<string> {
  const zip = readZip(bytes);
  const deck = await zip.text("ppt/presentation.xml");
  if (!deck) throw new Error("not a PowerPoint deck");
  const targets = await rels(zip, "ppt/presentation.xml");
  const out: string[] = [];
  let n = 0;
  for (const id of all(xml(deck), "sldId")) {
    const part = targets.get(relId(id));
    const text = part ? await zip.text(part) : undefined;
    if (!text) continue;
    const lines = all(xml(text), "p")
      .map((p) =>
        all(p, "t")
          .map((t) => t.textContent ?? "")
          .join("")
          .trim(),
      )
      .filter(Boolean);
    out.push([`## Slide ${++n}`, ...lines.map((l) => `- ${l}`)].join("\n"));
  }
  return out.join("\n\n");
}

/** RFC 4180 rows: quoted fields may hold the separator, quotes ("") and line breaks. */
export function parseCsv(text: string, separator = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') field += text[++i];
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === separator) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      if (rows.length === MAX_ROWS) return rows;
    } else field += c;
  }
  if (field !== "" || row.length) rows.push([...row, field]);
  return rows;
}
