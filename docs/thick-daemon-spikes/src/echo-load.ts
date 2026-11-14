// O5 sample (plan 1.7, S3.4): keystroke-to-echo latency on a Bun.Terminal PTY while the same
// single-threaded process does durable writes, an async reconcile, git children and a zip child.
//
//   bun src/echo-load.ts [samples=2000] [runs=2] [conditions,comma,separated]
//
// Keystrokes come from a Worker at ~200 Hz (postMessage, like bytes arriving on a client socket), so
// arrival time does not depend on the main loop. "e2e" = Worker send -> echoed byte read back in the
// main thread; "pty" = terminal.write -> echoed byte. The PTY child runs `stty raw -echo; exec cat`,
// so the echo is cat's write, not the kernel's line discipline.
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fullFsync } from "./lock.ts";

const [samplesArg, runsArg, condArg] = process.argv.slice(2);
const SAMPLES = Number(samplesArg ?? 2000);
const RUNS = Number(runsArg ?? 2);
const ALL = ["idle", "fsync", "reconcile", "git", "zip", "all", "fsync-worker", "fsync-child", "all-mitigated"];
const CONDITIONS = condArg ? condArg.split(",") : ALL;
const REPO = resolve(import.meta.dir, "../../..");
const scratch = mkdtempSync(join(tmpdir(), "echo-load-"));
const now = () => performance.timeOrigin + performance.now();

// ---------- PTY ----------
const pending: { sent: number; written: number }[] = [];
let e2e: number[] = [], pty: number[] = [];
let ready: (() => void) | null = null;
const terminal = new Bun.Terminal({
  cols: 80, rows: 24,
  data(_t, data) {
    const t = now();
    if (ready) { ready(); ready = null; return; }
    for (let i = 0; i < data.length; i++) {
      const p = pending.shift();
      if (!p) continue;
      e2e.push(t - p.sent); pty.push(t - p.written);
    }
  },
});
const child = Bun.spawn(["/bin/sh", "-c", "stty raw -echo; printf R; exec cat"], { terminal });
await new Promise<void>((r) => { ready = r; });

// ---------- loop gap ----------
let maxGap = 0, last = performance.now();
setInterval(() => { const t = performance.now(); maxGap = Math.max(maxGap, t - last); last = t; }, 1);

// ---------- loads ----------
type Load = { stop: () => Promise<void>; stats: () => string };

function loopLoad(body: () => Promise<number>, label: string): Load {
  let running = true; const costs: number[] = [];
  const done = (async () => { while (running) { costs.push(await body()); } })();
  return {
    stop: async () => { running = false; await done; },
    stats: () => `${label} n=${costs.length} p50=${q(costs, 0.5).toFixed(1)} max=${Math.max(...costs).toFixed(1)}ms`,
  };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// (1) a task creation: 4 files, each write + F_FULLFSYNC on file and on its dir, then 200 ms idle.
let taskN = 0;
function writeTaskFiles(): { files: string[]; dir: string } {
  const dir = join(scratch, "durable", `t${taskN++}`);
  mkdirSync(join(dir, "sessions"), { recursive: true });
  const files = ["task.md", "sessions/a.meta.json", "sessions/a.scrollback", "artifacts.json"].map((f) => join(dir, f));
  for (const f of files) writeFileSync(f, "x".repeat(1024));
  return { files, dir };
}
function syncFfi(paths: string[]) {
  for (const p of paths) { const fd = openSync(p, "r"); fullFsync(fd); closeSync(fd); }
}
const pathsFor = ({ files, dir }: { files: string[]; dir: string }) =>
  files.flatMap((f) => [f, f.includes("/sessions/") ? join(dir, "sessions") : dir]);

const fsyncLoad = () => loopLoad(async () => {
  const t0 = performance.now(); syncFfi(pathsFor(writeTaskFiles())); const c = performance.now() - t0;
  await sleep(200); return c;
}, "taskCreate(sync ffi)");

// Mitigation A: F_FULLFSYNC on a Worker thread (fds are process-wide).
const fsyncWorker = new Worker(new URL("./echo-load-fsync-worker.ts", import.meta.url));
let workerSeq = 0; const workerWait = new Map<number, () => void>();
fsyncWorker.onmessage = (e) => { workerWait.get(e.data)?.(); workerWait.delete(e.data); };
const fsyncWorkerLoad = () => loopLoad(async () => {
  const t0 = performance.now();
  const id = workerSeq++;
  await new Promise<void>((r) => { workerWait.set(id, r); fsyncWorker.postMessage({ id, paths: pathsFor(writeTaskFiles()) }); });
  const c = performance.now() - t0; await sleep(200); return c;
}, "taskCreate(worker fsync)");

// Mitigation B: one child process per task creation does the syncs.
const helper = join(import.meta.dir, "echo-load-fsync-helper.ts");
const fsyncChildLoad = () => loopLoad(async () => {
  const t0 = performance.now();
  const p = Bun.spawn([process.execPath, helper, ...pathsFor(writeTaskFiles())], { stdout: "ignore" });
  if ((await p.exited) !== 0) throw new Error("helper failed");
  const c = performance.now() - t0; await sleep(200); return c;
}, "taskCreate(child fsync)");

// (2) reconcile over ~1,000 synthetic task dirs, back to back (scan-bench.ts reconcileAsync shape).
const recRoot = join(scratch, "tasks");
const tracked: { path: string; mtimeMs: number; size: number }[] = [];
for (let i = 0; i < 1000; i++) {
  const d = join(recRoot, `task-${i}`);
  mkdirSync(join(d, "sessions"), { recursive: true }); mkdirSync(join(d, "artifacts"));
  for (const f of ["task.md", "sessions/s1.meta.json", "sessions/s2.meta.json", "artifacts/01-a.md", "artifacts/02-b.md"]) {
    writeFileSync(join(d, f), "y".repeat(512)); tracked.push({ path: join(d, f), mtimeMs: 0, size: 512 });
  }
}
const reconcileLoad = () => loopLoad(async () => {
  const t0 = performance.now();
  const slugs = await readdir(recRoot);
  await Promise.all(slugs.map((s) => Promise.all([readdir(join(recRoot, s, "sessions")), readdir(join(recRoot, s, "artifacts"))])));
  let changed = 0;
  for (let i = 0; i < tracked.length; i += 256)
    await Promise.all(tracked.slice(i, i + 256).map(async (t) => { const s = await stat(t.path); if (s.mtimeMs !== t.mtimeMs) changed++; }));
  return performance.now() - t0;
}, "reconcile(1000 tasks, 5000 files)");

// (3) git children on this worktree, two in flight, back to back.
const gitCmds = [["status", "--porcelain=v2", "--branch"], ["log", "-n", "500", "--stat", "--format=%H %s"], ["diff", "HEAD~5", "--stat"]];
let gi = 0;
const gitLoad = () => {
  const one = () => loopLoad(async () => {
    const t0 = performance.now();
    const p = Bun.spawn(["git", "-C", REPO, ...gitCmds[gi++ % gitCmds.length]], { stdout: "pipe", stderr: "ignore" });
    await new Response(p.stdout).arrayBuffer(); await p.exited;
    return performance.now() - t0;
  }, "git");
  const a = one(), b = one();
  return { stop: async () => { await a.stop(); await b.stop(); }, stats: () => `${a.stats()} | ${b.stats()}` };
};

// (4) zip child writing a few hundred MB: 300 MB random input, stored (-0) so it is I/O bound.
const zipIn = join(scratch, "zipin");
mkdirSync(zipIn);
for (let i = 0; i < 6; i++) {
  const fd = openSync(join(zipIn, `r${i}.bin`), "w");
  for (let j = 0; j < 50; j++) writeSync(fd, crypto.getRandomValues(new Uint8Array(1 << 20)).slice());
  closeSync(fd);
}
const zipLoad = () => loopLoad(async () => {
  const t0 = performance.now(); const out = join(scratch, "out.zip"); rmSync(out, { force: true });
  const p = Bun.spawn(["/usr/bin/zip", "-q", "-r", "-0", out, "."], { cwd: zipIn, stdout: "ignore", stderr: "ignore" });
  await p.exited; return performance.now() - t0;
}, "zip(300MB -0)");

const combine = (ls: Load[]): Load => ({
  stop: async () => { await Promise.all(ls.map((l) => l.stop())); },
  stats: () => ls.map((l) => l.stats()).join(" | "),
});
const loads: Record<string, () => Load | null> = {
  idle: () => null, fsync: fsyncLoad, reconcile: reconcileLoad, git: gitLoad, zip: zipLoad,
  all: () => combine([fsyncLoad(), reconcileLoad(), gitLoad(), zipLoad()]),
  "fsync-worker": fsyncWorkerLoad, "fsync-child": fsyncChildLoad,
  "all-mitigated": () => combine([fsyncWorkerLoad(), reconcileLoad(), gitLoad(), zipLoad()]),
};

// ---------- driver ----------
function q(a: number[], p: number) { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; }
const keyWorker = new Worker(new URL("./echo-load-keys.ts", import.meta.url));
keyWorker.onmessage = (e) => { pending.push({ sent: e.data, written: now() }); terminal.write("a"); };

async function measure(name: string, run: number) {
  const load = loads[name]();
  await sleep(500); // let the load get going
  e2e = []; pty = []; pending.length = 0; maxGap = 0; last = performance.now();
  await new Promise<void>((r) => {
    keyWorker.onmessage = (e) => {
      pending.push({ sent: e.data, written: now() }); terminal.write("a");
    };
    keyWorker.postMessage({ count: SAMPLES, hz: 200 });
    const check = setInterval(() => { if (e2e.length >= SAMPLES) { clearInterval(check); r(); } }, 20);
  });
  const gap = maxGap;
  await load?.stop();
  const f = (x: number) => x.toFixed(2);
  console.log(`| ${name} | ${run} | ${f(q(e2e, .5))} | ${f(q(e2e, .95))} | ${f(q(e2e, .99))} | ${f(Math.max(...e2e))} | ${f(q(pty, .99))} | ${f(Math.max(...pty))} | ${f(gap)} | ${load?.stats() ?? ""} |`);
}

console.log(`Bun ${Bun.version}, ${SAMPLES} samples @200Hz, scratch ${scratch}`);
console.log("| condition | run | e2e p50 | e2e p95 | e2e p99 | e2e max | pty p99 | pty max | loop gap max | load |");
console.log("|---|---|---|---|---|---|---|---|---|---|");
try {
  for (let run = 1; run <= RUNS; run++) for (const c of CONDITIONS) await measure(c, run);
} finally {
  child.kill(); terminal.close(); keyWorker.terminate(); fsyncWorker.terminate();
  rmSync(scratch, { recursive: true, force: true });
  process.exit(0);
}
