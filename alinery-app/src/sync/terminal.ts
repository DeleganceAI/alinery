// One no-harness shell's bytes from `TerminalService` (plan 2.1.5, S3.4): Attach streams the output with
// each frame's offset, keystrokes go back as unary Write calls numbered by `input_seq`, and a reattach
// asks for everything after the last byte rendered, so a dropped stream repeats and loses nothing.
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { type AttachResponse, TerminalService } from "alinery-proto/alinery/v1/terminal_pb";
import { daemonTransport } from "../daemon/transport";

export type TerminalHandlers = {
  data: (bytes: Uint8Array) => void;
  /** The shell ended. */
  exit?: (code: number) => void;
  /** The stream ended or failed after it had started. */
  closed: (error?: unknown) => void;
  /** The daemon's file is not the one this view read (a restore): the view starts over from the top. */
  reset?: () => void;
};

export type TerminalLink = {
  /** Start (or restart) the stream from the last offset. Resolves on the first frame; rejects when the daemon can't be reached or has no such terminal. */
  attach: (size: { cols: number; rows: number } | null) => Promise<void>;
  write: (data: string) => Promise<void>;
  resize: (cols: number, rows: number) => Promise<void>;
  /** Stop for good. */
  detach: () => void;
  /** The scrollback offset after the last byte handed to `data`. */
  offset: () => number;
};

const links = new Map<string, TerminalLink>();

/** Type into a session that has a mounted pane, as that pane would. False when none is attached. */
export function writeTerminal(sessionId: string, data: string): boolean {
  const link = links.get(sessionId);
  if (link) void link.write(data).catch(() => {});
  return Boolean(link);
}

export function terminalLink(repo: string, session: { taskSlug: string; id: string }, handlers: TerminalHandlers): TerminalLink {
  const client = createClient(TerminalService, daemonTransport(repo));
  const encoder = new TextEncoder();
  let ac: AbortController | null = null;
  let attachId = "";
  let seq = 0;
  let offset = 0;
  let typed = "";

  const send = (data: string): Promise<void> => {
    if (!attachId) {
      typed += data;
      return Promise.resolve();
    }
    return client.write({ attachId, inputSeq: BigInt(seq++), data: encoder.encode(data) }).then(() => {});
  };

  const open = async (size: { cols: number; rows: number } | null): Promise<void> => {
    ac?.abort();
    const mine = new AbortController();
    ac = mine;
    attachId = "";
    seq = 0;
    const stream = client.attach({ session, fromOffset: BigInt(offset), cols: size?.cols ?? 0, rows: size?.rows ?? 0 }, { signal: mine.signal })[Symbol.asyncIterator]();
    const take = (f: AttachResponse) => {
      if (mine.signal.aborted) return;
      if (f.attachId) attachId = f.attachId;
      if (f.body.case === "data" && f.body.value.length) {
        offset = Math.max(offset, Number(f.offset) + f.body.value.length);
        handlers.data(f.body.value);
      } else if (f.body.case === "exit") handlers.exit?.(f.body.value.code);
    };
    const first = await stream.next();
    if (first.done) throw new Error("terminal closed");
    take(first.value);
    if (typed) {
      const pending = typed;
      typed = "";
      void send(pending).catch(() => {});
    }
    void (async () => {
      try {
        for (;;) {
          const next = await stream.next();
          if (next.done) break;
          take(next.value);
        }
        if (!mine.signal.aborted) handlers.closed();
      } catch (e) {
        if (!mine.signal.aborted) handlers.closed(e);
      }
    })();
  };

  const link: TerminalLink = {
    async attach(size) {
      try {
        await open(size);
      } catch (e) {
        if (offset > 0 && ConnectError.from(e).code === Code.InvalidArgument) {
          offset = 0;
          handlers.reset?.();
          await open(size);
        } else throw e;
      }
    },
    write: send,
    resize: (cols, rows) => (attachId ? client.resize({ attachId, cols, rows }).then(() => {}) : Promise.resolve()),
    detach() {
      if (attachId) void client.detach({ attachId }).catch(() => {});
      ac?.abort();
      attachId = "";
      if (links.get(session.id) === link) links.delete(session.id);
    },
    offset: () => offset,
  };
  links.set(session.id, link);
  return link;
}
