import { describe, expect, it } from "vitest";
import { decodeOmpPage } from "./ompFile";

function page(header: Record<string, number>, rows: string[]): ArrayBuffer {
  const body = rows.length > 0 ? `${rows.join("\n")}\n` : "";
  const bytes = new TextEncoder().encode(`${JSON.stringify(header)}\n${body}`);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const message = (id: string, role: string, text: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "message", id, message: { role, content: [{ type: "text", text }], ...extra } });

describe("decodeOmpPage", () => {
  it("reads the header and carries each row's id onto its message", () => {
    const buffer = page({ start: 512, end: 900, length: 4096 }, [message("a1", "user", "hello"), message("a2", "assistant", "hi")]);
    const decoded = decodeOmpPage(buffer);
    expect({ start: decoded.start, end: decoded.end, length: decoded.length }).toEqual({ start: 512, end: 900, length: 4096 });
    expect(decoded.messages.map((m) => m.rowId)).toEqual(["a1", "a2"]);
    expect(decoded.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("keeps toolResult metadata so tool output can render", () => {
    const row = JSON.stringify({
      type: "message",
      id: "t1",
      message: { role: "toolResult", toolName: "bash", toolCallId: "call-9", isError: true, content: [{ type: "text", text: "boom" }] },
    });
    const [result] = decodeOmpPage(page({ start: 0, end: 10, length: 10 }, [row])).messages;
    expect(result).toMatchObject({ role: "toolResult", toolName: "bash", toolCallId: "call-9", isError: true, rowId: "t1" });
  });

  it("ignores rows that are not conversation", () => {
    const rows = [
      JSON.stringify({ type: "title", title: "", pad: " ".repeat(8) }),
      JSON.stringify({ type: "session", id: "s", version: 3 }),
      JSON.stringify({ type: "custom", customType: "tool_execution_start", data: {} }),
      JSON.stringify({ type: "compaction", firstKeptEntryId: "x" }),
      message("keep", "user", "only this"),
    ];
    expect(decodeOmpPage(page({ start: 0, end: 1, length: 1 }, rows)).messages.map((m) => m.rowId)).toEqual(["keep"]);
  });

  it("honours OMP's own display:false marker", () => {
    const hidden = JSON.stringify({ type: "message", id: "h", display: false, message: { role: "assistant", content: [{ type: "text", text: "internal" }] } });
    expect(decodeOmpPage(page({ start: 0, end: 1, length: 1 }, [hidden, message("shown", "user", "x")])).messages.map((m) => m.rowId)).toEqual(["shown"]);
  });

  // A row over Bun's 64 KiB stream buffer can be split across write(2) calls, so a read taken
  // while OMP is writing can see a torn final row. One dropped row is recoverable; throwing away
  // the page is not.
  it("drops a torn trailing row instead of failing the page", () => {
    const bytes = new TextEncoder().encode(`${JSON.stringify({ start: 0, end: 1, length: 1 })}\n${message("good", "user", "kept")}\n{"type":"mess`);
    const decoded = decodeOmpPage(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    expect(decoded.messages.map((m) => m.rowId)).toEqual(["good"]);
  });

  it("returns an empty page for a session with no journal", () => {
    expect(decodeOmpPage(page({ start: 0, end: 0, length: 0 }, [])).messages).toEqual([]);
  });
});
