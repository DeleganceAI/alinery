import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockIpc } from "../test/mockIpc";
import { FilePanel, FilesPanel, formatBytes } from "./CanvasFiles";

const mocks = vi.hoisted(() => ({
  readCanvasFile: vi.fn(),
  saveFileDialog: vi.fn(async (_name: string, _bytes: Uint8Array) => true),
  revealItemInDir: vi.fn(async () => undefined),
}));
// The bytes come from the daemon (BlobService CanvasFileBlob, domain/canvas.test.ts); the save from the shell.
vi.mock("../sync/chat", () => ({ MAX_CANVAS_FILE_BYTES: 100 * 1024 * 1024, readCanvasFile: mocks.readCanvasFile }));
vi.mock("../ipc", () => mockIpc(mocks));
vi.mock("./CanvasPdf", () => ({ default: () => <p>pdf pages</p> }));

const where = { repo: "/repo", threadId: "t1", panel: "p1" };
const bytesOf = (text: string) => ({ bytes: new TextEncoder().encode(text), total: text.length });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("canvas file panels", () => {
  it("lists files, opens one into a preview, saves a copy and goes back", async () => {
    mocks.readCanvasFile.mockResolvedValue(bytesOf("name,qty\npens,3\n"));
    const body = { dir: "/repo/out", entries: [{ path: "stock.csv", size: 18, mtime_ms: 0 }], truncated: false };
    render(<FilesPanel where={where} text={JSON.stringify(body)} />);
    fireEvent.click(screen.getByRole("button", { name: "stock.csv" }));
    const table = await screen.findByRole("table");
    expect(within(table).getByText("pens")).toBeTruthy();
    expect(mocks.readCanvasFile).toHaveBeenCalledWith("/repo", "t1", "p1", "stock.csv");
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
    mocks.readCanvasFile.mockResolvedValue({ bytes: xlsx, total: xlsx.length });
    render(<FilePanel where={where} text={JSON.stringify({ path: "/repo/out/sample.xlsx", size: xlsx.length, mtime_ms: 0 })} />);
    expect(await screen.findByText("North")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Notes" }));
    expect(screen.getByText("hello")).toBeTruthy();
  });

  it("hands a PDF to the PDF view, and offers no folder for a remote repository", async () => {
    mocks.readCanvasFile.mockResolvedValue(bytesOf("%PDF-1.7"));
    render(<FilePanel where={{ ...where, repo: "alinery+ssh://box/srv/repo" }} text={JSON.stringify({ path: "/srv/repo/a.pdf", size: 8, mtime_ms: 0 })} />);
    expect(await screen.findByText("pdf pages")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show in folder" })).toBeNull();
  });

  it("does not read a file past the limit", () => {
    render(<FilePanel where={where} text={JSON.stringify({ path: "/repo/huge.bin", size: 200 * 1024 * 1024, mtime_ms: 0 })} />);
    expect(screen.getByText(/too large to preview or save here/)).toBeTruthy();
    expect(mocks.readCanvasFile).not.toHaveBeenCalled();
    expect(formatBytes(1536)).toBe("1.5 KB");
  });
});
