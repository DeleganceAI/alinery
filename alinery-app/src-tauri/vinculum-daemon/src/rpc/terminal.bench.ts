// S3.4 measurement (plan O8, O5): keystroke-to-echo latency of a PTY, first through the JSON-line op path
// the app used before (re-created here: one connection per Write, one long Attach socket), then through
// TerminalService on rpc.sock. The `load` conditions run inside the same process as the PTY, as in the
// daemon. Run: bun src/rpc/terminal.bench.ts [samples] [condition...]   (conditions: idle create fsync atomic reconcile git tar all; fsync is a flood of 4 parallel writeDurable every 20 ms)
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { TerminalService } from "alinery-proto/alinery/v1/terminal_pb";
import { writeAtomic, writeDurable } from "../platform/fs.ts";
import { JobRunner } from "../jobs/runner.ts";
import { Feed } from "../sync/feed.ts";
import { Store } from "../sync/store.ts";
import { killPty, startShell, subscribeOutput, writePty } from "../terminal.ts";
import { serveRpc } from "./server.ts";

const SECRET = "ef".repeat(32);
const samples = Number(process.argv[2] ?? 1000);
const wanted = process.argv.slice(3);
const root = mkdtempSync(join(tmpdir(), "term-bench-"));
let n = 0;

function shell() {
  const id = `bench-${++n}`;
  startShell(id, root, join(root, `${id}.scrollback`), 80, 24, () => undefined, "/bin/sh");
  return id;
}
const pct = (xs: number[], p: number) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((xs.length * p) / 100))]!;
const KEYS = "abcdefghijklmnopqrstuvwxyz";

/** Types one character at a time, 5 ms apart, and times each until its echo is in the stream. */
async function run(type: (c: string) => Promise<unknown>, onData: (cb: (b: Buffer) => void) => void): Promise<number[]> {
  const out: number[] = [];
  let waiting: { c: string; t0: number; done: (ms: number) => void } | undefined;
  onData((b) => {
    if (waiting && b.includes(waiting.c)) {
      const w = waiting;
      waiting = undefined;
      w.done(performance.now() - w.t0);
    }
  });
  await Bun.sleep(300);
  for (let i = 0; i < samples; i++) {
    const c = KEYS[i % KEYS.length]!;
    const echoed = new Promise<number>((done) => (waiting = { c, t0: performance.now(), done }));
    void type(c).catch(() => {});
    out.push(await Promise.race([echoed, Bun.sleep(300).then(() => Number.NaN)]));
    await Bun.sleep(5);
  }
  return out.filter((x) => !Number.isNaN(x));
}

async function legacy(): Promise<number[]> {
  const id = shell();
  const sock = join(root, "legacy.sock");
  const server = createServer((s) => {
    let buf = "";
    s.on("data", (d) => {
      buf += d.toString();
      const i = buf.indexOf("\n");
      if (i < 0) return;
      const req = JSON.parse(buf.slice(0, i));
      if (req.op === "write") {
        writePty(id, req.data);
        s.end('{"ok":true}\n');
      } else {
        s.write('{"ok":true}\n');
        const sub = subscribeOutput(id, 0, (f) => "data" in f && s.write(f.data))!;
        s.on("close", sub.unsubscribe);
      }
    });
  }).listen(sock);
  const att = connect(sock);
  att.write('{"op":"attach"}\n');
  const times = await run(
    (c) => new Promise<void>((done) => connect(sock, function (this: ReturnType<typeof connect>) { this.write(JSON.stringify({ op: "write", data: c }) + "\n"); this.on("data", () => {}); this.on("close", done); })),
    (cb) => att.on("data", cb),
  );
  att.destroy();
  server.close();
  killPty(id);
  return times;
}

async function grpc(): Promise<number[]> {
  const id = shell();
  const socketPath = join(root, "rpc.sock");
  const store = new Store();
  const net = await serveRpc({
    socketPath, secret: Buffer.from(SECRET), hostExecutable: process.execPath,
    info: { protocol: 25, buildId: "b", repoRoot: "/repo", appConfigIdentity: "i" },
    lifecycle: { stop: () => 0, exit: () => {} }, store, jobs: new JobRunner(store),
    storageScan: { repo: "/repo", appConfig: "/app", namespace: "" }, transcripts: async () => undefined,
  });
  const client = createClient(TerminalService, createGrpcTransport({
    baseUrl: "http://daemon",
    nodeOptions: { createConnection: () => connect(socketPath) } as never,
    interceptors: [(next) => (req) => (req.header.set("authorization", `Bearer ${SECRET}`), next(req))],
  }));
  const ac = new AbortController();
  const it = client.attach({ session: { taskSlug: "", id } }, { signal: ac.signal })[Symbol.asyncIterator]();
  const attachId = (await it.next()).value!.attachId;
  const listeners: Array<(b: Buffer) => void> = [];
  void (async () => {
    try {
      for (;;) {
        const r = await it.next();
        if (r.done) return;
        if (r.value.body.case === "data") for (const l of listeners) l(Buffer.from(r.value.body.value));
      }
    } catch {
      /* aborted at the end of a run */
    }
  })();
  let seq = 0;
  const enc = new TextEncoder();
  const times = await run((c) => client.write({ attachId, inputSeq: BigInt(seq++), data: enc.encode(c) }), (cb) => listeners.push(cb));
  ac.abort();
  net.close();
  killPty(id);
  return times;
}

const conditions: Record<string, () => { stop: () => void }> = {
  idle: () => ({ stop() {} }),
  // A task creation with attachments: four writeDurable calls, over and over.
  fsync: () => {
    let stop = false;
    void (async () => { for (let i = 0; !stop; i++) { await Promise.all([0, 1, 2, 3].map((k) => writeDurable(join(root, `d${i % 8}-${k}`), "x".repeat(4096)))); await Bun.sleep(20); } })();
    return { stop: () => void (stop = true) };
  },
  // One task creation with attachments every 200 ms: task.md plus four attachments, written one after another.
  create: () => {
    let stop = false;
    void (async () => { for (let i = 0; !stop; i++) { for (let k = 0; k < 5; k++) await writeDurable(join(root, `c${i % 8}-${k}`), "x".repeat(4096)); await Bun.sleep(200); } })();
    return { stop: () => void (stop = true) };
  },
  // The same writes without the syncs: tells the main thread's own file calls apart from the sync wait.
  atomic: () => {
    let stop = false;
    void (async () => { for (let i = 0; !stop; i++) { for (const k of [0, 1, 2, 3]) writeAtomic(join(root, `a${i % 8}-${k}`), "x".repeat(4096)); await Bun.sleep(20); } })();
    return { stop: () => void (stop = true) };
  },
  // A reconcile pass over 1,000 tasks (3,000 session metas), repeatedly.
  reconcile: () => {
    const alinery = join(root, "rec", ".alinery");
    for (let i = 0; i < 1000; i++) {
      const sessions = join(alinery, "tasks", `task-${i}`, "sessions");
      mkdirSync(sessions, { recursive: true });
      for (let j = 0; j < 3; j++) writeAtomic(join(sessions, `s${j}.meta.json`), JSON.stringify({ id: `s${j}`, worktree: "/w", created: 1 }));
    }
    const feed = new Feed(new Store(), alinery);
    let stop = false;
    void (async () => { await feed.scan(); while (!stop) { await feed.reconcile(); await Bun.sleep(50); } })();
    return { stop: () => void (stop = true) };
  },
  git: () => {
    let stop = false;
    void (async () => { while (!stop) await Bun.spawn(["git", "status", "--porcelain"], { cwd: process.cwd(), stdout: "ignore" }).exited; })();
    return { stop: () => void (stop = true) };
  },
  // The backup job is a child process (O7 a): spawn and pipe a compression of a tree.
  tar: () => {
    const tree = join(root, "tree");
    mkdirSync(tree, { recursive: true });
    for (let i = 0; i < 2000; i++) writeAtomic(join(tree, `f${i}`), "y".repeat(32768));
    let stop = false;
    void (async () => { while (!stop) await Bun.spawn(["tar", "-czf", join(root, "b.tgz"), "-C", tree, "."], { stdout: "ignore" }).exited; })();
    return { stop: () => void (stop = true) };
  },
};
conditions.all = () => {
  const parts = ["fsync", "reconcile", "git", "tar"].map((k) => conditions[k]!());
  return { stop: () => parts.forEach((p) => p.stop()) };
};

const line = (label: string, xs: number[]) => console.log(`${label.padEnd(24)} n=${xs.length}/${samples} p50 ${pct(xs, 50).toFixed(3)} ms  p99 ${pct(xs, 99).toFixed(3)} ms  max ${Math.max(...xs).toFixed(2)} ms`);
console.log(`samples ${samples}`);
if (wanted.length === 0 || wanted.includes("paths")) {
  line("legacy JSON-line ops", await legacy());
  line("TerminalService local", await grpc());
}
for (const name of wanted.filter((w) => w in conditions)) {
  const load = conditions[name]!();
  await Bun.sleep(300);
  line(`gRPC under ${name}`, await grpc());
  load.stop();
  await Bun.sleep(300);
}
rmSync(root, { recursive: true, force: true });
process.exit(0);
