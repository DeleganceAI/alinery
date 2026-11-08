// TerminalService (plan 2.1.5, O8 a): Attach streams a shell's output from a scrollback offset, and the
// input comes back as unary Write calls, which the daemon puts in input_seq order per attach.
import { randomUUID } from "node:crypto";
import { type MessageInitShape } from "@bufbuild/protobuf";
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import { Capability } from "alinery-proto/alinery/v1/admin_pb";
import { type AttachResponseSchema, TerminalService } from "alinery-proto/alinery/v1/terminal_pb";
import { OffsetAhead, resizePty, subscribeOutput, writePty, type OutputFrame } from "../terminal.ts";
import { capabilitiesOf, requireCapability } from "./auth.ts";

/** A write that arrives ahead of its turn waits this long for the ones before it, then goes in arrival order. */
export const GAP_MS = 2000;
/** A viewer more than this far behind is dropped; it reattaches from its last offset and loses nothing. */
const CLIENT_BACKLOG = 2 * 1024 * 1024;

type Attachment = {
  session: string;
  readOnly: boolean;
  next: number;
  held: Array<{ seq: number; data: Uint8Array }>;
  timer: ReturnType<typeof setTimeout> | undefined;
  close: () => void;
};

export function terminalService(gapMs = GAP_MS): ServiceImpl<typeof TerminalService> {
  const attachments = new Map<string, Attachment>();

  const attachment = (id: string): Attachment => {
    const found = attachments.get(id);
    if (!found) throw new ConnectError(`no attach ${id}; attach again`, Code.NotFound);
    return found;
  };

  const apply = (a: Attachment, data: Uint8Array) => {
    if (!writePty(a.session, data)) throw new ConnectError(`session ${a.session} is not running`, Code.FailedPrecondition);
  };

  const drain = (a: Attachment) => {
    clearTimeout(a.timer);
    a.timer = undefined;
    for (let i = a.held.findIndex((h) => h.seq === a.next); i >= 0; i = a.held.findIndex((h) => h.seq === a.next)) {
      apply(a, a.held.splice(i, 1)[0]!.data);
      a.next += 1;
    }
    if (a.held.length === 0) return;
    a.timer = setTimeout(() => {
      a.timer = undefined;
      console.error(`terminal ${a.session}: input_seq ${a.next} never arrived; applying ${a.held.length} held write(s) in arrival order`);
      const held = a.held.splice(0);
      a.next = Math.max(...held.map((h) => h.seq)) + 1;
      try {
        for (const h of held) apply(a, h.data);
      } catch {
        /* the shell ended while the writes waited */
      }
    }, gapMs);
  };

  return {
    async *attach(req, ctx) {
      requireCapability(ctx, Capability.VIEW);
      if (!req.session?.id) throw new ConnectError("Attach needs a session", Code.InvalidArgument);
      const id = req.session.id;
      const readOnly = req.readOnly || !capabilitiesOf(ctx).has(Capability.ACT);
      const queue: OutputFrame[] = [];
      let queued = 0;
      let done = false;
      let slow = false;
      let wake = () => {};
      const finish = () => {
        done = true;
        wake();
      };
      const sub = (() => {
        try {
          return subscribeOutput(id, Number(req.fromOffset), (frame) => {
            if ("exit" in frame) {
              queue.push(frame);
              return wake();
            }
            queued += frame.data.length;
            if (queued > CLIENT_BACKLOG) {
              slow = true;
              return finish();
            }
            queue.push(frame);
            wake();
          });
        } catch (e) {
          if (e instanceof OffsetAhead) throw new ConnectError(e.message, Code.InvalidArgument);
          throw e;
        }
      })();
      if (!sub) throw new ConnectError(`no running terminal ${id}`, Code.NotFound);
      const attachId = randomUUID();
      const att: Attachment = { session: id, readOnly, next: 0, held: [], timer: undefined, close: finish };
      attachments.set(attachId, att);
      ctx.signal.addEventListener("abort", finish, { once: true });
      try {
        if (!readOnly && req.cols > 0 && req.rows > 0) resizePty(id, req.cols, req.rows);
        const out = (frame: OutputFrame): MessageInitShape<typeof AttachResponseSchema> =>
          "exit" in frame ? { body: { case: "exit", value: frame.exit } } : { body: { case: "data", value: frame.data }, offset: BigInt(frame.offset) };
        let first = true;
        const head = (): Partial<MessageInitShape<typeof AttachResponseSchema>> => {
          if (!first) return {};
          first = false;
          return { attachId, truncated: sub.truncated };
        };
        const replayed = sub.frames.length ? sub.frames : [{ offset: Number(req.fromOffset), data: Buffer.alloc(0) }];
        for (const frame of replayed) yield { ...out(frame), ...head() };
        for (;;) {
          while (queue.length) {
            const frame = queue.shift()!;
            if ("data" in frame) queued -= frame.data.length;
            yield { ...out(frame), ...head() };
            if ("exit" in frame) return;
          }
          if (slow) throw new ConnectError("this viewer fell behind; attach again from the last offset", Code.ResourceExhausted);
          if (done) return;
          await new Promise<void>((resolve) => (wake = resolve));
        }
      } finally {
        sub.unsubscribe();
        attachments.delete(attachId);
        clearTimeout(att.timer);
      }
    },

    async write(req, ctx) {
      requireCapability(ctx, Capability.ACT);
      const a = attachment(req.attachId);
      if (a.readOnly) throw new ConnectError("this attach is read-only", Code.PermissionDenied);
      const seq = Number(req.inputSeq);
      if (seq < a.next || a.held.some((h) => h.seq === seq)) return {};
      if (seq > a.next) {
        a.held.push({ seq, data: req.data });
        if (!a.timer) drain(a);
        return {};
      }
      apply(a, req.data);
      a.next += 1;
      drain(a);
      return {};
    },

    async resize(req, ctx) {
      requireCapability(ctx, Capability.ACT);
      const a = attachment(req.attachId);
      if (a.readOnly) throw new ConnectError("this attach is read-only", Code.PermissionDenied);
      if (req.cols === 0 || req.rows === 0) throw new ConnectError("resize needs cols and rows", Code.InvalidArgument);
      resizePty(a.session, req.cols, req.rows);
      return {};
    },

    async detach(req, ctx) {
      requireCapability(ctx, Capability.VIEW);
      attachments.get(req.attachId)?.close();
      return {};
    },
  };
}
