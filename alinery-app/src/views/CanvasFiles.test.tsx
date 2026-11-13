import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockIpc } from "../test/mockIpc";
import { FilePanel, FilesPanel, FileView, formatBytes, richPreview } from "./CanvasFiles";

const mocks = vi.hoisted(() => ({
  readPreviewBytes: vi.fn(),
  readRenderedPdf: vi.fn(),
  saveFileDialog: vi.fn(async (_name: string, _bytes: Uint8Array) => true),
  revealItemInDir: vi.fn(async () => undefined),
}));
// The bytes come from the daemon (BlobService CanvasFileBlob, domain/canvas.test.ts); the save from the shell.
vi.mock("../sync/chat", () => ({ canvasFileRef: (threadId: string, panel: string, path: string) => ({ threadId, panel, path }) }));
vi.mock("../sync/tasks", () => ({ MAX_PREVIEW_BYTES: 100 * 1024 * 1024, readPreviewBytes: mocks.readPreviewBytes, readRenderedPdf: mocks.readRenderedPdf }));
vi.mock("../ipc", () => mockIpc(mocks));
vi.mock("./CanvasPdf", () => ({ default: ({ bytes }: { bytes: Uint8Array }) => <p>pdf pages {new TextDecoder().decode(bytes)}</p> }));

const where = { repo: "/repo", threadId: "t1", panel: "p1" };
const bytesOf = (text: string) => ({ bytes: new TextEncoder().encode(text), total: text.length });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("canvas file panels", () => {
  it("lists files, opens one into a preview, saves a copy and goes back", async () => {
    mocks.readPreviewBytes.mockResolvedValue(bytesOf("name,qty\npens,3\n"));
    const body = { dir: "/repo/out", entries: [{ path: "stock.csv", size: 18, mtime_ms: 0 }], truncated: false };
    render(<FilesPanel where={where} text={JSON.stringify(body)} />);
    fireEvent.click(screen.getByRole("button", { name: "stock.csv" }));
    const table = await screen.findByRole("table");
    expect(within(table).getByText("pens")).toBeTruthy();
    expect(mocks.readPreviewBytes).toHaveBeenCalledWith("/repo", { threadId: "t1", panel: "p1", path: "stock.csv" });
    fireEvent.click(screen.getByRole("button", { name: "Save a copy…" }));
    await waitFor(() => expect(mocks.saveFileDialog).toHaveBeenCalled());
    expect(mocks.saveFileDialog.mock.calls[0]?.[0]).toBe("stock.csv");
    expect(new TextDecoder().decode(mocks.saveFileDialog.mock.calls[0]?.[1])).toContain("pens");
    fireEvent.click(screen.getByRole("button", { name: "Show in folder" }));
    expect(mocks.revealItemInDir).toHaveBeenCalledWith("/repo/out/stock.csv");
    fireEvent.click(screen.getByRole("button", { name: "← All files" }));
    expect(screen.getByRole("button", { name: "stock.csv" })).toBeTruthy();
  });

  it("previews a spreadsheet with a tab per sheet", async () => {
    const xlsx = new Uint8Array(readFileSync(join(__dirname, "..", "test", "fixtures", "sample.xlsx")));
    mocks.readPreviewBytes.mockResolvedValue({ bytes: xlsx, total: xlsx.length });
    render(<FilePanel where={where} text={JSON.stringify({ path: "/repo/out/sample.xlsx", size: xlsx.length, mtime_ms: 0 })} />);
    expect(await screen.findByText("North")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Notes" }));
    expect(screen.getByText("hello")).toBeTruthy();
  });

  it("hands a PDF to the PDF view, and offers no folder for a remote repository", async () => {
    mocks.readPreviewBytes.mockResolvedValue(bytesOf("%PDF-1.7"));
    render(<FilePanel where={{ ...where, repo: "alinery+ssh://box/srv/repo" }} text={JSON.stringify({ path: "/srv/repo/a.pdf", size: 8, mtime_ms: 0 })} />);
    expect(await screen.findByText("pdf pages %PDF-1.7")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show in folder" })).toBeNull();
  });

  it("draws a deck through LibreOffice, and without it shows the slides' text and why", async () => {
    const pptx = new Uint8Array(readFileSync(join(__dirname, "..", "test", "fixtures", "sample.pptx")));
    mocks.readPreviewBytes.mockResolvedValue({ bytes: pptx, total: pptx.length });
    mocks.readRenderedPdf.mockResolvedValueOnce(new TextEncoder().encode("%PDF drawn"));
    const ref = { worktreeFile: "deck.pptx" } as never;
    render(<FileView repo="/repo" ref={ref} name="deck.pptx" />);
    expect(await screen.findByText("pdf pages %PDF drawn")).toBeTruthy();
    expect(mocks.readRenderedPdf).toHaveBeenCalledWith("/repo", ref);
    expect(screen.queryByRole("button", { name: "Show in folder" })).toBeNull();
    cleanup();
    mocks.readRenderedPdf.mockRejectedValueOnce(new Error("LibreOffice is not installed on the machine this repository lives on"));
    render(<FileView repo="/repo" ref={ref} name="deck.pptx" />);
    expect(await screen.findByText(/LibreOffice is not installed/)).toBeTruthy();
    expect(screen.getByText("Plan body")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Get LibreOffice" })).toBeTruthy();
  });

  it("knows which files a file tab should preview instead of showing as text", () => {
    expect(["a.pdf", "b.XLSX", "c.docx", "d.pptx", "e.key", "f.png"].every(richPreview)).toBe(true);
    expect(["g.svg", "h.md", "i.csv", "j.ts"].some(richPreview)).toBe(false);
  });

  it("does not read a file past the limit", () => {
    render(<FilePanel where={where} text={JSON.stringify({ path: "/repo/huge.bin", size: 200 * 1024 * 1024, mtime_ms: 0 })} />);
    expect(screen.getByText(/too large to preview or save here/)).toBeTruthy();
    expect(mocks.readPreviewBytes).not.toHaveBeenCalled();
    expect(formatBytes(1536)).toBe("1.5 KB");
  });
});
