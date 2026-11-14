import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { docxMarkdown, parseCsv, pptxMarkdown, readZip, xlsxSheets } from "./officePreview";

// Made by openpyxl, python-docx and python-pptx (the bundled Python's), so the reader meets real files.
const fixture = (name: string) => new Uint8Array(readFileSync(join(__dirname, "test", "fixtures", name)));

describe("office previews", () => {
  it("reads every sheet's values, placing cells by their reference", async () => {
    expect(await xlsxSheets(fixture("sample.xlsx"))).toEqual([
      {
        name: "Sales",
        rows: [
          ["Region", "Q1", "Done"],
          ["North", "12.5", "TRUE"],
          ["", "", "", "", "far"],
        ],
        truncated: false,
      },
      { name: "Notes", rows: [["hello"]], truncated: false },
    ]);
  });

  it("turns a Word document into Markdown headings, list items and tables", async () => {
    expect(await docxMarkdown(fixture("sample.docx"))).toBe("# Report\n\nPlain | text.\n\n- First\n\n| a | b |\n| --- | --- |\n| 1 | 2 |");
  });

  it("lists a deck's text in the deck's order, not the files'", async () => {
    expect(await pptxMarkdown(fixture("sample.pptx"))).toBe("## Slide 1\n- Plan\n- Plan body\n\n## Slide 2\n- Intro\n- Intro body");
  });

  it("refuses what is not a zip", () => {
    expect(() => readZip(new TextEncoder().encode("plain text, long enough to scan for a directory"))).toThrow("not a zip file");
  });

  it("parses quoted CSV fields with separators, quotes and line breaks", () => {
    expect(parseCsv('a,"b,c","say ""hi"""\r\n1,"two\nlines",3\n')).toEqual([
      ["a", "b,c", 'say "hi"'],
      ["1", "two\nlines", "3"],
    ]);
    expect(parseCsv("x\ty", "\t")).toEqual([["x", "y"]]);
  });
});
