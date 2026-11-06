// S0.4 watcher spike (docs/thick-daemon-plan.md): Bun fs.watch(recursive) against @parcel/watcher 2.6.0
// on a synthetic `.alinery/tasks` tree. Same source runs under `bun run` and as a `bun build --compile` binary.
//
//   bun run src/watch.ts matrix [--reps 3] [--idle-seconds 60]   everything below, one table
//   bun run src/watch.ts churn --watcher bun|parcel|parcel-ignore --mode paced|burst [--seed N]
//   bun run src/watch.ts idle --watcher none|bun|parcel [--tasks 200] [--seconds 60]
//   bun run src/watch.ts reg                                     per-watcher registration cost (Bun #34160)
//
// Compiled: bun build src/watch.ts --compile --outfile <out>; then `<out> matrix`.
// `appender` and `workload` are internal: the watcher process spawns itself for them, so the writes
// come from other processes, as an agent's would.

import {
  appendFileSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  watch,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

type ParcelEvent = { path: string; type: "create" | "update" | "delete" };
type Parcel = {
  subscribe(
    dir: string,
    fn: (err: Error | null, events: ParcelEvent[]) => unknown,
    opts?: { ignore?: string[] },
  ): Promise<{ unsubscribe(): Promise<void> }>;
};

const argv = process.argv.slice(2);
const cmd = argv[0] ?? "matrix";
const opt = (name: string, def: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
};

// A compiled binary runs from Bun's embedded filesystem; it re-executes itself without a script path.
const compiled = import.meta.path.includes("$bunfs");
const self = (...a: string[]) => (compiled ? [process.execPath, ...a] : [process.execPath, import.meta.path, ...a]);
const runner = compiled ? "compiled" : "bun run";

function loadParcel(): Parcel {
  // `@parcel/watcher`'s index.js picks its prebuilt with require(`@parcel/watcher-${platform}-${arch}`).
  // A compiled binary cannot resolve that computed name, so name each addon literally: the bundler then
  // embeds the .node file, and an addon absent at build time becomes a throw on that branch only.
  const binding =
    process.platform === "darwin"
      ? require("@parcel/watcher-darwin-arm64/watcher.node")
      : process.arch === "arm64"
        ? require("@parcel/watcher-linux-arm64-glibc/watcher.node")
        : require("@parcel/watcher-linux-x64-glibc/watcher.node");
  return require("@parcel/watcher/wrapper.js").createWrapper(binding);
}

// ---- deterministic randomness -------------------------------------------------------------------------
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- synthetic repo ------------------------------------------------------------------------------------
const body = (n: number) => `+++\ntitle = "x"\n+++\n${"lorem ipsum dolor sit amet ".repeat(n)}\n`;

function makeTask(dir: string) {
  mkdirSync(join(dir, "artifacts"), { recursive: true });
  mkdirSync(join(dir, "sessions"), { recursive: true });
  writeFileSync(join(dir, "task.md"), body(20));
  for (let a = 1; a <= 5; a++) writeFileSync(join(dir, "artifacts", `0${a}-step.md`), body(80));
  for (let s = 1; s <= 3; s++) writeFileSync(join(dir, "sessions", `s${s}.meta.json`), JSON.stringify({ id: `s${s}` }));
}

function makeRoot(): { root: string; tasks: string } {
  const base = opt("root", "");
  const root = realpathSync(base ? (mkdirSync(base, { recursive: true }), base) : mkdtempSync(join(tmpdir(), "s04-")));
  const tasks = join(root, ".alinery", "tasks");
  mkdirSync(tasks, { recursive: true });
  return { root, tasks };
}

// ---- churn workload ------------------------------------------------------------------------------------
// 1,000 files over 50 task dirs (45 exist before watching, 5 are made during the run). 500 files exist
// before watching and get append, rename-over, delete; 500 do not and get create, append, rename-over
// (100 of them in the new dirs). So every path ends different from how it started.
type Op = "create" | "append" | "replace" | "delete" | "mkdir";
type Planned = { t: number; path: string; op: Op };
type Done = { path: string; op: Op; s: number; e: number };

const EXISTING_TASKS = 45;
const NEW_TASKS = 5;
const FILES_PER_TASK = 20;
const GAP_MS = 1000; // paced: time between two ops on one file
const SPAN_MS = 6000; // paced: file start times fall in [0, SPAN_MS]

function filePath(tasks: string, slug: string, j: number) {
  if (j < 2) return join(tasks, slug, `note-${j}.md`);
  if (j < 12) return join(tasks, slug, "artifacts", `${String(j).padStart(2, "0")}-f${j}.md`);
  return join(tasks, slug, "sessions", `s${j}.meta.json`);
}

function plan(tasks: string, mode: string, seed: number) {
  const r = rng(seed);
  const pre: string[] = []; // created before the watcher starts
  const files: { path: string; ops: Op[]; start: number; newDir?: string }[] = [];
  for (let k = 0; k < EXISTING_TASKS; k++) {
    const slug = `t${String(k).padStart(3, "0")}`;
    for (let j = 0; j < FILES_PER_TASK; j++) {
      const path = filePath(tasks, slug, j);
      // 500 of the 900 existing-dir files pre-exist; the other 400 are new files in old dirs.
      if ((k * FILES_PER_TASK + j) % 9 < 5 && pre.length < 500) {
        pre.push(path);
        files.push({ path, ops: ["append", "replace", "delete"], start: r() * SPAN_MS });
      } else files.push({ path, ops: ["create", "append", "replace"], start: r() * SPAN_MS });
    }
  }
  for (let k = 0; k < NEW_TASKS; k++) {
    const slug = `n${String(k).padStart(3, "0")}`;
    const made = 500 + k * 1200;
    for (let j = 0; j < FILES_PER_TASK; j++) {
      // The first file lands in the same millisecond as the mkdir: the inotify new-directory race.
      files.push({
        path: filePath(tasks, slug, j),
        ops: ["create", "append", "replace"],
        start: j === 0 ? made : made + r() * 50,
        newDir: join(tasks, slug),
      });
    }
  }
  const ops: Planned[] = [];
  if (mode === "paced") {
    for (const f of files) f.ops.forEach((op, i) => ops.push({ t: f.start + i * GAP_MS, path: f.path, op }));
    ops.sort((a, b) => a.t - b.t);
  } else {
    // burst: no sleeps; each file's ops back to back, files in start order.
    files.sort((a, b) => a.start - b.start);
    for (const f of files) for (const op of f.ops) ops.push({ t: 0, path: f.path, op });
  }
  return { pre, ops, newDirs: [...new Set(files.filter((f) => f.newDir).map((f) => f.newDir as string))] };
}

let tmpSeq = 0;
function doOp(path: string, op: Op) {
  switch (op) {
    case "create":
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, body(10));
      break;
    case "append":
      appendFileSync(path, "appended line\n");
      break;
    case "replace": {
      // alinery-core fs_atomic: same-dir `<stem>.tmp.<pid>.<nanos>.<seq>`, then rename onto the target.
      const tmp = path.replace(/\.[^./]+$/, `.tmp.${process.pid}.${tmpSeq++}`);
      writeFileSync(tmp, body(30));
      renameSync(tmp, path);
      break;
    }
    case "delete":
      unlinkSync(path);
      break;
  }
}

async function workload(tasks: string, mode: string, seed: number) {
  const { ops } = plan(tasks, mode, seed);
  const log: Done[] = [];
  const made = new Set<string>();
  const t0 = Date.now();
  for (const p of ops) {
    if (mode === "paced") {
      const wait = t0 + p.t - Date.now();
      if (wait > 1) await Bun.sleep(wait);
    }
    // A new task dir (and its artifacts/ or sessions/) is made right before its first file.
    const d = dirname(p.path);
    if (p.op === "create" && !made.has(d)) {
      for (const dir of [dirname(d), d]) {
        if (made.has(dir)) continue;
        const s = Date.now();
        mkdirSync(dir, { recursive: true });
        log.push({ path: dir, op: "mkdir", s, e: Date.now() });
        made.add(dir);
      }
    }
    const s = Date.now();
    doOp(p.path, p.op);
    log.push({ path: p.path, op: p.op, s, e: Date.now() });
  }
  process.stdout.write(JSON.stringify(log));
}

// ---- 10 MB/s scrollback appender --------------------------------------------------------------------------
// `open-close` is what vinculum-daemon does today (terminal.ts fanout: appendFileSync per PTY chunk).
// It matters on macOS, where FSEvents reports a content change when a written file is closed.
async function appender(file: string, bytesPerSec: number, style: string) {
  const fd = style === "held" ? openSync(file, "a") : -1;
  const chunk = Buffer.alloc(16 * 1024, 0x61);
  let written = 0;
  const t0 = performance.now();
  let stop = false;
  process.on("SIGTERM", () => {
    stop = true;
  });
  while (!stop) {
    const due = ((performance.now() - t0) / 1000) * bytesPerSec;
    while (written + chunk.length <= due) {
      if (fd >= 0) written += writeSync(fd, chunk);
      else {
        appendFileSync(file, chunk);
        written += chunk.length;
      }
    }
    await Bun.sleep(5);
  }
  if (fd >= 0) closeSync(fd);
  process.stdout.write(JSON.stringify({ bytes: written, seconds: (performance.now() - t0) / 1000 }));
  process.exit(0);
}

// Bun #44780's trigger in daemon terms: a build in a worktree replacing small files as fast as it can,
// outside the recursive watch but under non-recursive watches (`--flat`). Runs until killed.
function busy(dir: string) {
  mkdirSync(dir, { recursive: true });
  for (let n = 0; ; n++) {
    const f = join(dir, `f${n % 500}`);
    writeFileSync(`${f}.tmp`, "x");
    renameSync(`${f}.tmp`, f);
  }
}

// ---- watchers ----------------------------------------------------------------------------------------------
type Ev = { t: number; kind: string; path: string | null };

async function startWatcher(kind: string, dir: string, sink: (e: Ev) => void) {
  if (kind === "none") return async () => {};
  if (kind === "bun") {
    const w = watch(dir, { recursive: true }, (type, name) =>
      sink({ t: Date.now(), kind: type, path: name == null ? null : join(dir, String(name)) }),
    );
    w.on("error", (err) => sink({ t: Date.now(), kind: `error:${err}`, path: null }));
    return async () => w.close();
  }
  const parcel = loadParcel();
  const ignore = kind === "parcel-ignore" ? ["**/*.scrollback"] : [];
  const sub = await parcel.subscribe(
    dir,
    (err, events) => {
      const t = Date.now();
      if (err) sink({ t, kind: `error:${err}`, path: null });
      for (const e of events) sink({ t, kind: e.type, path: e.path });
    },
    { ignore },
  );
  return () => sub.unsubscribe();
}

function inotifyWatches(): number | null {
  if (process.platform !== "linux") return null;
  let n = 0;
  for (const fd of readdirSync("/proc/self/fd")) {
    try {
      if (readlinkSync(`/proc/self/fd/${fd}`) !== "anon_inode:inotify") continue;
      n += readFileSync(`/proc/self/fdinfo/${fd}`, "utf8")
        .split("\n")
        .filter((l) => l.startsWith("inotify wd:")).length;
    } catch {}
  }
  return n;
}

async function collect(p: { stdout: ReadableStream<Uint8Array> }) {
  return await new Response(p.stdout).text();
}

const pct = (xs: number[], q: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

// ---- churn run -----------------------------------------------------------------------------------------------
async function churn() {
  const kind = opt("watcher", "bun");
  const mode = opt("mode", "paced");
  const seed = Number(opt("seed", "1"));
  const { root, tasks } = makeRoot();
  for (let k = 0; k < EXISTING_TASKS; k++) makeTask(join(tasks, `t${String(k).padStart(3, "0")}`));
  const { pre, newDirs } = plan(tasks, mode, seed);
  for (const p of pre) writeFileSync(p, body(10));
  const scrollback = join(tasks, "t000", "sessions", "x.scrollback");
  writeFileSync(scrollback, "");

  const events: Ev[] = [];
  const stopWatch = await startWatcher(kind, tasks, (e) => events.push(e));
  // --flat: non-recursive fs.watch on every folder from the busy worktree dir up to the repo root
  // (5 watches), plus 2 busy writers in that dir. Bun on macOS feeds all of them into one FSEvents stream.
  const flat = argv.includes("--flat");
  const busyDir = join(root, ".alinery", "worktrees", "w", "src");
  const flatWatches: { close(): void }[] = [];
  const busyKids: ReturnType<typeof Bun.spawn>[] = [];
  if (flat) {
    mkdirSync(busyDir, { recursive: true });
    for (let d = busyDir; d.length >= root.length; d = dirname(d)) flatWatches.push(watch(d, () => {}));
    for (let i = 0; i < 2; i++) busyKids.push(Bun.spawn(self("busy", join(busyDir, `w${i}`)), { stdout: "ignore" }));
  }
  await Bun.sleep(2000); // let setup writes drain before measuring
  const settleEvents = events.length;
  events.length = 0;

  const appendStyle = opt("append", "open-close");
  const app = Bun.spawn(self("appender", scrollback, String(10 * 1024 * 1024), appendStyle), { stdout: "pipe" });
  await Bun.sleep(500);
  const cpu0 = process.cpuUsage();
  const w0 = performance.now();
  const tStart = Date.now();
  const wl = Bun.spawn(self("workload", tasks, mode, String(seed)), { stdout: "pipe" });
  const log: Done[] = JSON.parse(await collect(wl));
  const tEnd = Date.now();
  await Bun.sleep(3000); // grace: FSEvents latency and parcel's debounce
  app.kill("SIGTERM");
  const appOut = JSON.parse(await collect(app));
  const cpu = process.cpuUsage(cpu0);
  const wall = performance.now() - w0;
  for (const k of busyKids) k.kill("SIGKILL");
  for (const w of flatWatches) w.close();
  await stopWatch();

  // ---- score --------------------------------------------------------------------------------------------------
  const byPath = new Map<string, number[]>();
  const cls = { workload: 0, tmp: 0, scrollback: 0, dir: 0, nullName: 0, error: 0, other: 0, beforeStart: 0 };
  const otherSamples: string[] = [];
  const opsByPath = new Map<string, Done[]>();
  for (const d of log) if (d.op !== "mkdir") (opsByPath.get(d.path) ?? opsByPath.set(d.path, []).get(d.path)!).push(d);
  const dirs = new Set(log.filter((d) => d.op === "mkdir").map((d) => d.path));
  for (const e of events) {
    if (e.t < tStart) cls.beforeStart++;
    if (e.kind.startsWith("error")) cls.error++;
    else if (e.path === null) cls.nullName++;
    else if (e.path.endsWith(".scrollback")) cls.scrollback++;
    else if (basename(e.path).includes(".tmp.")) cls.tmp++;
    else if (opsByPath.has(e.path)) {
      cls.workload++;
      (byPath.get(e.path) ?? byPath.set(e.path, []).get(e.path)!).push(e.t);
    } else if (dirs.has(e.path) || isDir(e.path)) cls.dir++;
    else {
      cls.other++;
      if (otherSamples.length < 5) otherSamples.push(`${e.kind} ${e.path}`);
    }
  }
  const missedOps: Record<string, number> = {};
  const opCount: Record<string, number> = {};
  let missedOpsTotal = 0;
  let dupOps = 0;
  let missedFinal = 0;
  let excess = 0;
  let newDirCreatesMissed = 0;
  let newDirFirstCreateMissed = 0;
  const lat: number[] = [];
  const firstInNewDir = new Set<string>();
  for (const nd of newDirs) {
    const first = log.find((d) => d.op === "create" && d.path.startsWith(`${nd}/`));
    if (first) firstInNewDir.add(first.path);
  }
  for (const [path, ops] of opsByPath) {
    const ts = byPath.get(path) ?? [];
    const inNewDir = newDirs.some((nd) => path.startsWith(`${nd}/`));
    excess += Math.max(0, ts.length - ops.length);
    const last = ops[ops.length - 1];
    if (!ts.some((t) => t >= last.s)) missedFinal++;
    ops.forEach((o, i) => {
      opCount[o.op] = (opCount[o.op] ?? 0) + 1;
      const hi = i + 1 < ops.length ? ops[i + 1].s : Number.POSITIVE_INFINITY;
      const inWin = ts.filter((t) => t >= o.s && t < hi);
      if (inWin.length === 0) {
        missedOps[o.op] = (missedOps[o.op] ?? 0) + 1;
        missedOpsTotal++;
        if (inNewDir && o.op === "create") newDirCreatesMissed++;
        if (o.op === "create" && firstInNewDir.has(path)) newDirFirstCreateMissed++;
      } else {
        dupOps += inWin.length - 1;
        lat.push(inWin[0] - o.s);
      }
    });
  }
  const result = {
    platform: `${process.platform}-${process.arch}`,
    runner,
    bun: Bun.version,
    watcher: kind,
    mode,
    seed,
    appendStyle,
    flatWatches: flatWatches.length,
    ops: log.filter((d) => d.op !== "mkdir").length,
    opCount,
    paths: opsByPath.size,
    workloadSeconds: (tEnd - tStart) / 1000,
    // paced only: an op with no event for its path before the path's next op (or the end, for the last op)
    missedOps: mode === "paced" ? missedOpsTotal : null,
    missedOpsByType: mode === "paced" ? missedOps : null,
    // paced only: extra events for one op beyond the first
    duplicateEvents: mode === "paced" ? dupOps : null,
    // both modes: a path whose last op was never followed by an event for it (the daemon would keep stale state)
    missedFinal,
    // both modes: events for a path beyond one per op
    excessEvents: excess,
    newDirCreatesMissed: mode === "paced" ? newDirCreatesMissed : null,
    newDirFirstCreateMissed: mode === "paced" ? newDirFirstCreateMissed : null,
    newDirFilesMissedFinal: [...opsByPath.keys()].filter(
      (p) => newDirs.some((nd) => p.startsWith(`${nd}/`)) && !(byPath.get(p) ?? []).some((t) => t >= opsByPath.get(p)!.at(-1)!.s),
    ).length,
    events: events.length,
    classes: cls,
    otherSamples,
    latencyMs: mode === "paced" ? { p50: pct(lat, 0.5), p95: pct(lat, 0.95), max: pct(lat, 1) } : null,
    scrollbackMBps: +(appOut.bytes / 1048576 / appOut.seconds).toFixed(2),
    scrollbackEventsPerSec: +(cls.scrollback / appOut.seconds).toFixed(1),
    watcherCpuPct: +(((cpu.user + cpu.system) / 1000 / wall) * 100).toFixed(1),
    settleEvents,
    inotifyWatches: inotifyWatches(),
  };
  rmSync(root, { recursive: true, force: true });
  console.log(JSON.stringify(result));
}

function isDir(p: string) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ---- idle CPU ----------------------------------------------------------------------------------------------------
async function idle() {
  const kind = opt("watcher", "bun");
  const n = Number(opt("tasks", "200"));
  const secs = Number(opt("seconds", "60"));
  const { root, tasks } = makeRoot();
  for (let k = 0; k < n; k++) makeTask(join(tasks, `t${String(k).padStart(3, "0")}`));
  await Bun.sleep(1000);
  const events: Ev[] = [];
  const s0 = performance.now();
  const stop = await startWatcher(kind, tasks, (e) => events.push(e));
  const subscribeMs = +(performance.now() - s0).toFixed(1);
  const watches = inotifyWatches();
  await Bun.sleep(5000);
  const settleEvents = events.length;
  const cpu0 = process.cpuUsage();
  const w0 = performance.now();
  const e0 = events.length;
  await Bun.sleep(secs * 1000);
  const cpu = process.cpuUsage(cpu0);
  const wall = performance.now() - w0;
  const result = {
    platform: `${process.platform}-${process.arch}`,
    runner,
    bun: Bun.version,
    watcher: kind,
    tasks: n,
    seconds: +(wall / 1000).toFixed(1),
    cpuPct: +(((cpu.user + cpu.system) / 1000 / wall) * 100).toFixed(3),
    cpuMs: +((cpu.user + cpu.system) / 1000).toFixed(1),
    subscribeMs,
    inotifyWatches: watches,
    rssMB: +(process.memoryUsage().rss / 1048576).toFixed(1),
    settleEvents,
    idleEvents: events.length - e0,
  };
  await stop();
  rmSync(root, { recursive: true, force: true });
  console.log(JSON.stringify(result));
}

// ---- Bun #34160: cost of each further non-recursive fs.watch --------------------------------------------------
async function reg() {
  const { root } = makeRoot();
  const files: string[] = [];
  for (let i = 0; i < 3000; i++) {
    const f = join(root, `file-${i}.txt`);
    writeFileSync(f, "x");
    files.push(f);
  }
  const handles: { close(): void }[] = [];
  const out: string[] = [];
  for (const mark of [500, 1500, 3000]) {
    const t = performance.now();
    while (handles.length < mark) handles.push(watch(files[handles.length], () => {}));
    out.push(`${mark} watchers: last batch ${(performance.now() - t).toFixed(0)} ms`);
  }
  for (const h of handles) h.close();
  rmSync(root, { recursive: true, force: true });
  console.log(JSON.stringify({ platform: `${process.platform}-${process.arch}`, runner, reg: out }));
}

// ---- matrix --------------------------------------------------------------------------------------------------------
async function runSelf(args: string[]) {
  const p = Bun.spawn(self(...args), { stdout: "pipe", stderr: "inherit" });
  const out = await collect(p);
  await p.exited;
  const line = out.trim().split("\n").at(-1) ?? "";
  try {
    return JSON.parse(line);
  } catch {
    return { error: out.slice(-500), args };
  }
}

async function matrix() {
  const reps = Number(opt("reps", "3"));
  const idleSecs = opt("idle-seconds", "60");
  const rows: any[] = [];
  for (const mode of ["paced", "burst"])
    for (const w of ["bun", "parcel", "parcel-ignore"])
      for (let r = 1; r <= reps; r++) {
        const res = await runSelf(["churn", "--watcher", w, "--mode", mode, "--seed", String(r)]);
        console.log(JSON.stringify(res));
        rows.push(res);
      }
  // One paced run per watcher with the scrollback fd held open, for contrast with the daemon's open-close.
  for (const w of ["bun", "parcel"])
    console.log(JSON.stringify(await runSelf(["churn", "--watcher", w, "--mode", "paced", "--append", "held"])));
  // Bun #44780's trigger: busy worktree writers under 5 non-recursive watches.
  for (const w of ["bun", "parcel"])
    for (let r = 1; r <= reps; r++)
      console.log(JSON.stringify(await runSelf(["churn", "--watcher", w, "--mode", "paced", "--seed", String(r), "--flat"])));
  // Idle runs go in parallel: each has its own tree and does nothing for the window.
  const idles = await Promise.all(
    ["none", "bun", "parcel"].map((w) => runSelf(["idle", "--watcher", w, "--seconds", idleSecs])),
  );
  for (const r of idles) console.log(JSON.stringify(r));
  console.log(JSON.stringify(await runSelf(["reg"])));
}

switch (cmd) {
  case "workload":
    await workload(argv[1], argv[2], Number(argv[3]));
    break;
  case "appender":
    await appender(argv[1], Number(argv[2]), argv[3] ?? "open-close");
    break;
  case "busy":
    busy(argv[1]);
    break;
  case "churn":
    await churn();
    break;
  case "idle":
    await idle();
    break;
  case "reg":
    await reg();
    break;
  case "matrix":
    await matrix();
    break;
  default:
    console.error(`unknown command ${cmd}`);
    process.exit(2);
}
