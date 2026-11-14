import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertToPdf, pdfPagePng } from "./office.ts";

test("a conversion past its time limit is stopped, and its work directory goes with it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "office-"));
  const soffice = join(dir, "soffice");
  writeFileSync(soffice, "#!/bin/sh\nexec sleep 30\n");
  chmodSync(soffice, 0o755);
  const started = Date.now();
  await expect(convertToPdf(soffice, join(dir, "deck.pptx"), dir, 200)).rejects.toThrow("LibreOffice took longer than 0 seconds");
  expect(Date.now() - started).toBeLessThan(5000);
  expect(readdirSync(dir).filter((n) => n.startsWith("convert-"))).toEqual([]);
});

test("drawing a page of what is not a PDF says why", async () => {
  const dir = mkdtempSync(join(tmpdir(), "office-"));
  const python = join(dir, "python3");
  writeFileSync(python, "#!/bin/sh\necho 'PdfiumError: Failed to load document' >&2\nexit 1\n");
  chmodSync(python, 0o755);
  await expect(pdfPagePng(python, join(dir, "x.pdf"), 1, dir)).rejects.toThrow("could not draw x.pdf: PdfiumError: Failed to load document");
  expect(readdirSync(dir).filter((n) => n.startsWith("page-"))).toEqual([]);
});
