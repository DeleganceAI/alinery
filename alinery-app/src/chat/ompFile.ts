import { mapHydratedMessage } from "../chatTranscript";
import type { ChatMessage } from "../types";

/**
 * One backward page of a session's OMP journal, as returned by the `read_session_omp` command.
 *
 * The wire format is a JSON header line followed by the raw window bytes, so framing is just the
 * first newline. `start` is always a row boundary; feed it back as the next request's `end` to
 * page further back, and `start === 0` means the whole conversation is loaded.
 */
export type OmpPage = {
  start: number;
  end: number;
  length: number;
  messages: ChatMessage[];
};

const EMPTY: OmpPage = { start: 0, end: 0, length: 0, messages: [] };

export function decodeOmpPage(buffer: ArrayBuffer): OmpPage {
  const bytes = new Uint8Array(buffer);
  const newline = bytes.indexOf(0x0a);
  if (newline < 0) return EMPTY;

  const decoder = new TextDecoder();
  let header: { start?: unknown; end?: unknown; length?: unknown };
  try {
    header = JSON.parse(decoder.decode(bytes.subarray(0, newline)));
  } catch {
    return EMPTY;
  }
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

  const messages: ChatMessage[] = [];
  for (const line of decoder.decode(bytes.subarray(newline + 1)).split("\n")) {
    if (!line) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line);
    } catch {
      // OMP writes whole lines, but a row over Bun's 64 KiB stream buffer can be split across
      // write(2) calls, so a read taken mid-write can see a torn final row. Skipping it costs one
      // message that the next page will pick up; failing the page would cost the whole history.
      continue;
    }
    if (row?.type !== "message") continue;
    // OMP marks some rows as internal (an interrupted-thinking record, for one). It does not
    // render them itself, so neither do we.
    if (row.display === false) continue;
    const mapped = mapHydratedMessage(row.message, typeof row.id === "string" ? row.id : undefined);
    if (mapped) messages.push(mapped);
  }

  return { start: num(header.start), end: num(header.end), length: num(header.length), messages };
}
