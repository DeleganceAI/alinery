/** A journal page as `read_chat_omp` returns it: a JSON header line, then one JSON row per line. */
export function journalPage(start: number, rows: [id: string, text: string][]): ArrayBuffer {
  const body = rows.map(([id, text]) => JSON.stringify({ type: "message", id, message: { role: "user", content: [{ type: "text", text }] } })).join("\n");
  const bytes = new TextEncoder().encode(`${JSON.stringify({ start, end: start + 100, length: 1000 })}\n${body}\n`);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
