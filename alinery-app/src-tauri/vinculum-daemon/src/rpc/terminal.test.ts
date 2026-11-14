import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Code, ConnectError, createClient, createContextValues } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { Capability } from "alinery-proto/alinery/v1/admin_pb";
import { TerminalService, type AttachResponse } from "alinery-proto/alinery/v1/terminal_pb";
import { killPty, replayRanges, startShell, writePty } from "../terminal.ts";
import { JobRunner } from "../jobs/runner.ts";
import { Store } from "../sync/store.ts";
import { CAPS } from "./auth.ts";
import { serveRpc } from "./server.ts";
import { terminalService } from "./terminal.ts";

const SECRET = "ef".repeat(32);
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

let n = 0;
function shell(): { id: string; file: () => Buffer } {
  const dir = mkdtempSync(join(tmpdir(), "rpc-term-"));
  const scroll = join(dir, "s.scrollback");
  const id = `rpc-term-${++n}`;
  startShell(id, dir, scroll, 80, 24, () => undefined, "/bin/sh");
  cleanup.push(() => killPty(id));
  return { id, file: () => existsOrEmpty(scroll) };
}
const existsOrEmpty = (path: string) => {
  try {
    return readFileSync(path);
  } catch {
    return Buffer.alloc(0);
  }
};

async function client(gapMs = 2000) {
  const dir = mkdtempSync("/tmp/rpc-term-");
  const socketPath = join(dir, "rpc.sock");
  const store = new Store();
  const net = await serveRpc({
    socketPath,
    secret: Buffer.from(SECRET),
    hostExecutable: process.execPath,
    info: { protocol: 25, buildId: "b", repoRoot: "/repo", appConfigIdentity: "i" },
    lifecycle: { stop: () => 0, exit: () => {} },
    store,
    jobs: new JobRunner(store),
    storageScan: { repo: "/repo", appConfig: "/app", namespace: "" },
    transcripts: async () => undefined,
    terminalGapMs: gapMs,
  });
  cleanup.push(() => {
    net.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return createClient(
    TerminalService,
    createGrpcTransport({
      baseUrl: "http://daemon",
      nodeOptions: { createConnection: () => connect(socketPath) } as never,
      interceptors: [(next) => (req) => (req.header.set("authorization", `Bearer ${SECRET}`), next(req))],
    }),
  );
}

async function until(check: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

/** Reads frames from an attach until `done(bytes)` is true. */
async function collect(stream: AsyncIterable<AttachResponse>, done: (all: Buffer) => boolean) {
  const frames: AttachResponse[] = [];
  let all = Buffer.alloc(0);
  for await (const f of stream) {
    frames.push(f);
    if (f.body.case === "data") all = Buffer.concat([all, f.body.value]);
    if (done(all)) break;
  }
  return { frames, all };
}

test("a reattach from an offset gets exactly the bytes after it, and the first attach's frames are contiguous", async () => {
  const { id, file } = shell();
  const c = await client();
  const ac = new AbortController();
  const first = c.attach({ session: { taskSlug: "t", id }, fromOffset: 0n, cols: 80, rows: 24 }, { signal: ac.signal });
  const it = first[Symbol.asyncIterator]();
  const head = (await it.next()).value!;
  expect(head.attachId).not.toBe("");
  await c.write({ attachId: head.attachId, inputSeq: 0n, data: new TextEncoder().encode("echo FIRST-DONE\n") });
  let seen = Buffer.alloc(0);
  let end = -1;
  while (!seen.includes("\r\nFIRST-DONE\r\n")) {
    const f = (await it.next()).value!;
    if (f.body.case !== "data") continue;
    if (end >= 0) expect(Number(f.offset)).toBe(end);
    seen = Buffer.concat([seen, f.body.value]);
    end = Number(f.offset) + f.body.value.length;
  }
  await c.detach({ attachId: head.attachId });
  ac.abort();

  writePty(id, "echo SECOND-DONE\n");
  await until(() => file().includes("\r\nSECOND-DONE\r\n"));
  const total = file().length;
  const again = await collect(c.attach({ session: { taskSlug: "t", id }, fromOffset: BigInt(end) }), (all) => all.length >= total - end);
  expect(Number(again.frames[0]!.offset)).toBe(end);
  expect(again.frames[0]!.truncated).toBe(false);
  expect(again.all.subarray(0, total - end).equals(file().subarray(end, total))).toBe(true);
  expect(again.all.includes("FIRST-DONE\r\n")).toBe(false);
});

test("replay and live output meet with no gap and no repeat", async () => {
  const { id, file } = shell();
  const c = await client();
  writePty(id, "seq 1 30000\n");
  await until(() => file().length > 20000);
  const got = await collect(c.attach({ session: { taskSlug: "t", id }, fromOffset: 0n }), (all) => all.includes("\r\n30000\r\n"));
  let at = Number(got.frames[0]!.offset);
  expect(at).toBe(0);
  for (const f of got.frames) {
    if (f.body.case !== "data") continue;
    expect(Number(f.offset)).toBe(at);
    at += f.body.value.length;
  }
  expect(got.all.equals(file().subarray(0, got.all.length))).toBe(true);
});

test("a position past the end of the file is refused, and a missing terminal is not found", async () => {
  const { id } = shell();
  const c = await client();
  const ahead = await collect(c.attach({ session: { taskSlug: "t", id }, fromOffset: 99999999n }), () => true).catch((e) => e);
  expect(ConnectError.from(ahead).code).toBe(Code.InvalidArgument);
  const missing = await collect(c.attach({ session: { taskSlug: "t", id: "nope" } }), () => true).catch((e) => e);
  expect(ConnectError.from(missing).code).toBe(Code.NotFound);
});

test("writes sent out of order are applied in input_seq order", async () => {
  const { id, file } = shell();
  const c = await client();
  const ac = new AbortController();
  const it = c.attach({ session: { taskSlug: "t", id } }, { signal: ac.signal })[Symbol.asyncIterator]();
  const attachId = (await it.next()).value!.attachId;
  const enc = new TextEncoder();
  const send = (seq: number, text: string) => c.write({ attachId, inputSeq: BigInt(seq), data: enc.encode(text) });
  await send(2, "-OK\n");
  await send(1, "ORDER");
  await Bun.sleep(100);
  expect(file().includes("echo ORDER")).toBe(false);
  await send(0, "echo ");
  await until(() => file().includes("\r\nORDER-OK\r\n"));
  expect(file().includes("echo ORDER-OK")).toBe(true);
  await send(0, "echo DUPLICATE\n");
  await Bun.sleep(100);
  expect(file().includes("DUPLICATE")).toBe(false);
  ac.abort();
});

test("a gap that never fills is given up after the wait, and the held writes apply in arrival order", async () => {
  const { id, file } = shell();
  const c = await client(300);
  const ac = new AbortController();
  const it = c.attach({ session: { taskSlug: "t", id } }, { signal: ac.signal })[Symbol.asyncIterator]();
  const attachId = (await it.next()).value!.attachId;
  const enc = new TextEncoder();
  await c.write({ attachId, inputSeq: 2n, data: enc.encode("echo GAP-B\n") });
  await c.write({ attachId, inputSeq: 1n, data: enc.encode("echo GAP-A\n") });
  await Bun.sleep(100);
  expect(file().includes("GAP-")).toBe(false);
  await until(() => file().includes("\r\nGAP-A\r\n"));
  const text = file().toString();
  expect(text.indexOf("echo GAP-B")).toBeLessThan(text.indexOf("echo GAP-A"));
  // The sequence continues after the given-up gap.
  await c.write({ attachId, inputSeq: 3n, data: enc.encode("echo GAP-C\n") });
  await until(() => file().includes("\r\nGAP-C\r\n"));
  ac.abort();
});

test("a read-only attach cannot write or resize, and Write needs ACT", async () => {
  const { id } = shell();
  const ro = await client();
  const it = ro.attach({ session: { taskSlug: "t", id }, readOnly: true })[Symbol.asyncIterator]();
  const attachId = (await it.next()).value!.attachId;
  const denied = await ro.write({ attachId, inputSeq: 0n, data: new Uint8Array([97]) }).catch((e) => e);
  expect(ConnectError.from(denied).code).toBe(Code.PermissionDenied);
  const resize = await ro.resize({ attachId, cols: 10, rows: 10 }).catch((e) => e);
  expect(ConnectError.from(resize).code).toBe(Code.PermissionDenied);
  // A credential with VIEW only is read-only whatever it asks for.
  const ctx = { values: createContextValues().set(CAPS, new Set([Capability.VIEW])), signal: new AbortController().signal } as never;
  const svc = terminalService();
  const v = svc.attach!({ session: { taskSlug: "t", id }, fromOffset: 0n, cols: 0, rows: 0, readOnly: false } as never, ctx)[Symbol.asyncIterator]();
  const viewId = (await v.next()).value!.attachId;
  const noAct = await svc.write!({ attachId: viewId, inputSeq: 0n, data: new Uint8Array([97]) } as never, ctx).catch((e: unknown) => e);
  expect(ConnectError.from(noAct).code).toBe(Code.PermissionDenied);
  await it.return?.();
  await v.return?.();
});

test("replay leaves terminal queries out and keeps every other byte at its true offset", () => {
  const text = Buffer.from("ab\x1b[6ncd\x1b]11;?\x07ef\x1b[31mgh\x1b[");
  const kept = replayRanges(text).map(([a, b]) => [a, text.subarray(a, b).toString()]);
  expect(kept).toEqual([
    [0, "ab"],
    [6, "cd"],
    [15, "ef\x1b[31mgh\x1b["],
  ]);
});

test("a shell that exits ends the stream with an Exit frame", async () => {
  const { id } = shell();
  const c = await client();
  const it = c.attach({ session: { taskSlug: "t", id } })[Symbol.asyncIterator]();
  const attachId = (await it.next()).value!.attachId;
  await c.write({ attachId, inputSeq: 0n, data: new TextEncoder().encode("exit 3\n") });
  let exit: AttachResponse | undefined;
  for (;;) {
    const r = await it.next();
    if (r.done) break;
    if (r.value.body.case === "exit") exit = r.value;
  }
  expect(exit?.body.case === "exit" && exit.body.value.code).toBe(3);
});
