// A deck rendered to PDF for its preview: LibreOffice converts it once (platform/office.ts) and the PDF is kept in
// `.alinery/cache/rendered/`, named by the deck's path, size and modification time, so a changed deck renders again.
// One conversion runs at a time: LibreOffice is heavy, and a page asking twice waits for the first.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { findSoffice } from "../agentShell.ts";
import { writeAtomic } from "../platform/fs.ts";
import { DomainError } from "../platform/lock.ts";
import { convertToPdf, pdfPagePng } from "../platform/office.ts";
import { alineryDir } from "./taskFiles.ts";

/** What LibreOffice is asked to render: presentations. A PDF or a document previews without it. */
export const RENDERED_TYPES = new Set([".pptx", ".ppt", ".odp", ".key"]);
/** ponytail: the cache keeps this many PDFs, newest first; an LRU by size if decks get large. */
export const KEEP_RENDERED = 32;

export const renderedDir = (repo: string) => join(alineryDir(repo), "cache", "rendered");

let chain: Promise<unknown> = Promise.resolve();

/** The cached PDF of `file` (a checked, real path), converting it first when needed. */
export function renderedPdf(repo: string, file: string, soffice = findSoffice()): Promise<string> {
  if (!RENDERED_TYPES.has(extname(file).toLowerCase())) throw new DomainError("invalid_argument", "only a presentation is rendered to PDF");
  if (!soffice) throw new DomainError("failed_precondition", "LibreOffice is not installed on the machine this repository lives on, so the slides cannot be drawn.");
  const st = statSync(file);
  const dir = renderedDir(repo);
  const target = join(dir, `${createHash("sha256").update(`${file}\0${st.size}\0${st.mtimeMs}`).digest("hex").slice(0, 32)}.pdf`);
  const next = chain.catch(() => {}).then(async () => {
    if (existsSync(target)) return target;
    mkdirSync(dir, { recursive: true });
    let pdf: Uint8Array;
    try {
      pdf = await convertToPdf(soffice, file, dir);
    } catch (error) {
      throw new DomainError("failed_precondition", error instanceof Error ? error.message : String(error));
    }
    writeAtomic(target, pdf);
    prune(dir);
    return target;
  });
  chain = next;
  return next;
}

function prune(dir: string) {
  const pdfs = readdirSync(dir)
    .filter((n) => n.endsWith(".pdf"))
    .map((n) => ({ path: join(dir, n), at: statSync(join(dir, n)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  for (const old of pdfs.slice(KEEP_RENDERED)) rmSync(old.path, { force: true });
}

/** One page of a PDF or a deck as a PNG, for the agent to look at (alinery_render_page). `python` has pypdfium2. */
export async function renderPage(repo: string, file: string, page: number, python: string | undefined, soffice = findSoffice()): Promise<{ png: Uint8Array; pages: number }> {
  const ext = extname(file).toLowerCase();
  if (ext !== ".pdf" && !RENDERED_TYPES.has(ext)) throw new DomainError("invalid_argument", "only a PDF or a presentation (pptx, ppt, odp, key) is drawn as a page; read an image with the read tool");
  if (!existsSync(file) || !statSync(file).isFile()) throw new DomainError("not_found", `no such file: ${file}`);
  if (!python) throw new DomainError("failed_precondition", "the runtime's Python is missing, so pages cannot be drawn here");
  const pdf = ext === ".pdf" ? file : await renderedPdf(repo, file, soffice);
  mkdirSync(renderedDir(repo), { recursive: true });
  let out: Awaited<ReturnType<typeof pdfPagePng>>;
  try {
    out = await pdfPagePng(python, pdf, page, renderedDir(repo));
  } catch (error) {
    throw new DomainError("failed_precondition", error instanceof Error ? error.message : String(error));
  }
  if (!out.png) throw new DomainError("out_of_range", `there is no page ${page}: it has ${out.pages}`);
  return { png: out.png, pages: out.pages };
}
