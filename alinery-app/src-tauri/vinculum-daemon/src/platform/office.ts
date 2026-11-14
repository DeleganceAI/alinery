// The one place the daemon runs LibreOffice and draws PDF pages: a headless conversion to PDF, for a preview of a deck
// (domain/rendered.ts), and one page drawn to PNG by the bundled Python's pypdfium2, for the agent to look at.
// Each LibreOffice run gets its own throwaway profile, because two soffice processes sharing one refuse to start together.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { signalChild, spawnDetached } from "./process.ts";

/** ponytail: a deck converts in seconds; past this the run is stopped and the preview says so. */
export const CONVERT_TIMEOUT_MS = 120_000;
/** The longer side of a drawn page, in pixels: what a model reads well, and under every provider's image limit. */
export const PAGE_SIDE = 1568;

async function run(cmd: string[], what: string, timeoutMs: number) {
  const child = spawnDetached(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    signalChild(child, "SIGKILL", "convert-timeout");
  }, timeoutMs);
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timer);
  if (timedOut) throw new Error(`${what} took longer than ${Math.round(timeoutMs / 1000)} seconds`);
  return { stdout, code, lastError: stderr.trim().split("\n").pop() ?? "" };
}

/** The PDF LibreOffice makes of `file`, using `work` for its profile and output (removed afterwards). */
export async function convertToPdf(soffice: string, file: string, work: string, timeoutMs = CONVERT_TIMEOUT_MS): Promise<Uint8Array> {
  const dir = mkdtempSync(join(work, "convert-"));
  try {
    const out = join(dir, "out");
    const { code, lastError } = await run(
      [soffice, `-env:UserInstallation=${pathToFileURL(join(dir, "profile")).href}`, "--headless", "--norestore", "--convert-to", "pdf", "--outdir", out, file],
      "LibreOffice",
      timeoutMs,
    );
    try {
      return readFileSync(join(out, `${basename(file, extname(file))}.pdf`));
    } catch {
      throw new Error(`LibreOffice could not convert ${basename(file)}${code ? ` (exit ${code})` : ""}: ${lastError}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Prints the page count; draws page argv[2] (1-based) to argv[3] only when it exists.
const DRAW_PAGE = `import sys, pypdfium2 as pdfium
pdf = pdfium.PdfDocument(sys.argv[1])
n, i = len(pdf), int(sys.argv[2])
if 1 <= i <= n:
    page = pdf[i - 1]
    w, h = page.get_size()
    page.render(scale=min(4.0, ${PAGE_SIDE} / max(w, h))).to_pil().save(sys.argv[3])
print(n)`;

/** Page `page` of `pdf` as a PNG (undefined past the last page), and how many pages there are. */
export async function pdfPagePng(python: string, pdf: string, page: number, work: string, timeoutMs = CONVERT_TIMEOUT_MS): Promise<{ png?: Uint8Array; pages: number }> {
  const dir = mkdtempSync(join(work, "page-"));
  try {
    const out = join(dir, "page.png");
    const { stdout, code, lastError } = await run([python, "-I", "-c", DRAW_PAGE, pdf, String(page), out], "Drawing the page", timeoutMs);
    const pages = Number(stdout.trim());
    if (code || !Number.isInteger(pages)) throw new Error(`could not draw ${basename(pdf)}: ${lastError}`);
    let png: Uint8Array | undefined;
    try {
      png = readFileSync(out);
    } catch {}
    return { png, pages };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
