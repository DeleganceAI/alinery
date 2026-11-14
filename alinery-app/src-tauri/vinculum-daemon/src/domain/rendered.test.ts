import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainError } from "../platform/lock.ts";
import { renderedDir, renderedPdf, renderPage } from "./rendered.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A repository with a deck, and a stand-in soffice that writes `%PDF <deck>` where LibreOffice would, counting its runs. */
function rig(behaviour = "") {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "rendered-")));
  dirs.push(repo);
  mkdirSync(join(repo, ".alinery"));
  writeFileSync(join(repo, "deck.pptx"), "slides");
  const soffice = join(repo, "soffice");
  writeFileSync(
    soffice,
    `#!/bin/sh\necho run >> "${repo}/runs"\n${behaviour}\nwhile [ $# -gt 1 ]; do [ "$1" = --outdir ] && out="$2"; shift; done\nmkdir -p "$out"\nprintf '%%PDF %s' "$(basename "$1")" > "$out/$(basename "$1" .pptx).pdf"\n`,
  );
  chmodSync(soffice, 0o755);
  const runs = () => readFileSync(join(repo, "runs"), "utf8").split("\n").filter(Boolean).length;
  return { repo, soffice, deck: join(repo, "deck.pptx"), runs };
}

const refusal = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    return (error as Error).message;
  }
  throw new Error("expected a refusal");
};

test("a deck converts once, its PDF is reused until the deck changes, and the work directory is cleaned", async () => {
  const { repo, soffice, deck, runs } = rig();
  const pdf = await renderedPdf(repo, deck, soffice);
  expect(readFileSync(pdf, "utf8")).toBe("%PDF deck.pptx");
  expect(await renderedPdf(repo, deck, soffice)).toBe(pdf);
  expect(runs()).toBe(1);
  utimesSync(deck, new Date(), new Date(Date.now() + 5000));
  expect(await renderedPdf(repo, deck, soffice)).not.toBe(pdf);
  expect(runs()).toBe(2);
  expect(readdirSync(renderedDir(repo)).every((n) => n.endsWith(".pdf"))).toBe(true);
});

test("without LibreOffice, for a non-deck, or when the conversion fails, the refusal says why", async () => {
  const { repo, deck } = rig();
  expect(await refusal(() => renderedPdf(repo, deck, ""))).toContain("LibreOffice is not installed");
  expect(await refusal(async () => renderedPdf(repo, join(repo, "notes.docx"), "/bin/true"))).toContain("only a presentation");
  const broken = rig("echo 'Error: source file could not be loaded' >&2; exit 1");
  expect(await refusal(() => renderedPdf(broken.repo, broken.deck, broken.soffice))).toContain("could not convert deck.pptx (exit 1): Error: source file could not be loaded");
});

test("a page of a deck is drawn from its rendered PDF; past the last page, or what is not a PDF or deck, is refused", async () => {
  const { repo, soffice, deck, runs } = rig();
  // A stand-in Python: argv is -I -c <script> <pdf> <page> <out>, and the PDF has three pages.
  const python = join(repo, "python3");
  writeFileSync(python, `#!/bin/sh\n[ "$5" -le 3 ] && printf 'PNG %s %s' "$(cat "$4")" "$5" > "$6"\necho 3\n`);
  chmodSync(python, 0o755);
  const out = await renderPage(repo, deck, 2, python, soffice);
  expect(new TextDecoder().decode(out.png)).toBe("PNG %PDF deck.pptx 2");
  expect(out.pages).toBe(3);
  await renderPage(repo, deck, 1, python, soffice);
  expect(runs()).toBe(1);
  expect(await refusal(() => renderPage(repo, deck, 9, python, soffice))).toBe("there is no page 9: it has 3");
  writeFileSync(join(repo, "a.pdf"), "%PDF own");
  expect(new TextDecoder().decode((await renderPage(repo, join(repo, "a.pdf"), 1, python, soffice)).png)).toBe("PNG %PDF own 1");
  writeFileSync(join(repo, "notes.docx"), "words");
  expect(await refusal(() => renderPage(repo, join(repo, "notes.docx"), 1, python, soffice))).toContain("only a PDF or a presentation");
  expect(await refusal(() => renderPage(repo, join(repo, "gone.pdf"), 1, python, soffice))).toContain("no such file");
  expect(await refusal(() => renderPage(repo, deck, 1, undefined, soffice))).toContain("Python is missing");
  expect(readdirSync(renderedDir(repo)).filter((n) => n.startsWith("page-"))).toEqual([]);
});
