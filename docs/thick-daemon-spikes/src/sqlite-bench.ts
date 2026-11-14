// O3 (b) spike: bun:sqlite as the daemon's source of truth, files as export.
// Usage:
//   bun src/sqlite-bench.ts commit <scratch dir> [n]      which SQLite, and one commit's cost per sync mode
//   bun src/sqlite-bench.ts import <real .alinery> <scratch dir> [copies...]
//        files -> SQLite import, start-up load, VACUUM INTO, full export, against the file scan
import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build, scan, time } from "./scan-bench";

// SQLITE_LIB=<path to libsqlite3> swaps in another SQLite (macOS: Bun uses /usr/lib/libsqlite3.dylib).
if (process.env.SQLITE_LIB) Database.setCustomSQLite(process.env.SQLITE_LIB);

const SCHEMA = `
  CREATE TABLE task      (slug TEXT PRIMARY KEY, revision INTEGER NOT NULL, doc TEXT NOT NULL);
  CREATE TABLE session   (slug TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, doc TEXT NOT NULL, PRIMARY KEY (slug, id));
  CREATE TABLE execution (slug TEXT PRIMARY KEY, revision INTEGER NOT NULL, doc TEXT NOT NULL);
  CREATE TABLE artifact  (slug TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, mtime REAL NOT NULL, PRIMARY KEY (slug, name));
  CREATE TABLE change    (seq INTEGER PRIMARY KEY, key TEXT NOT NULL);
`;

function open(path: string) {
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 2000;");
  return db;
}
const pct = (xs: number[], p: number) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];
const r3 = (n: number) => +n.toFixed(3);

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "commit") {
  const [dir, nArg = "1000"] = args;
  const n = Number(nArg);
  mkdirSync(dir, { recursive: true });
  const mem = new Database(":memory:");
  const info = {
    runtime: `bun ${Bun.version}`, platform: `${process.platform}-${process.arch}`, compiled: !process.execPath.endsWith("/bun"),
    sqlite: (mem.query("SELECT sqlite_version() AS v").get() as { v: string }).v,
  };
  console.log(JSON.stringify(info));
  const modes: [string, string][] = [
    ["WAL synchronous=NORMAL", "PRAGMA synchronous = NORMAL; PRAGMA fullfsync = 0;"],
    ["WAL synchronous=FULL", "PRAGMA synchronous = FULL; PRAGMA fullfsync = 0;"],
  ];
  if (process.platform === "darwin") modes.push(["WAL synchronous=FULL fullfsync=1", "PRAGMA synchronous = FULL; PRAGMA fullfsync = 1; PRAGMA checkpoint_fullfsync = 1;"]);
  const doc = JSON.stringify({ name: "x".repeat(1000) });
  for (const [name, pragmas] of modes) {
    const path = join(dir, `commit-${name.replace(/\W+/g, "-")}.db`);
    rmSync(path, { force: true }); rmSync(`${path}-wal`, { force: true }); rmSync(`${path}-shm`, { force: true });
    const db = open(path);
    db.exec(SCHEMA);
    db.exec(pragmas);
    for (let i = 0; i < 100; i++) db.query("INSERT INTO task VALUES (?, 0, ?)").run(`t${i}`, doc);
    const put = db.query("UPDATE task SET doc = ?, revision = ? WHERE slug = ?");
    const log = db.query("INSERT INTO change (seq, key) VALUES (?, ?)");
    // One domain write = one transaction: the row and its changelog entry.
    const commit = db.transaction((seq: number) => { put.run(doc, seq, `t${seq % 100}`); log.run(seq, `task/t${seq % 100}`); });
    const t: number[] = [];
    for (let i = 1; i <= n; i++) { const t0 = performance.now(); commit(i); t.push(performance.now() - t0); }
    console.log(JSON.stringify({ mode: name, commits: n, p50_ms: r3(pct(t, 50)), p99_ms: r3(pct(t, 99)), max_ms: r3(Math.max(...t)) }));
    db.close();
  }
} else if (cmd === "import") {
  const [realAlinery, scratch, ...copyArgs] = args;
  for (const copies of copyArgs.length ? copyArgs.map(Number) : [1, 25, 100]) {
    const root = build(realAlinery, scratch, copies);
    const [{ index, tracked }, scanMs] = time(() => scan(root));
    const dbPath = join(scratch, `x${copies}.db`);
    const db = open(dbPath);
    db.exec(SCHEMA);
    db.exec("PRAGMA synchronous = FULL;");
    const ins = {
      task: db.query("INSERT INTO task VALUES (?, 0, ?)"),
      session: db.query("INSERT INTO session VALUES (?, ?, 0, ?)"),
      execution: db.query("INSERT INTO execution VALUES (?, 0, ?)"),
      artifact: db.query("INSERT INTO artifact VALUES (?, ?, ?, ?)"),
    };
    // The one-time import: everything the scan found, in one transaction.
    const [, insertMs] = time(() => db.transaction(() => {
      for (const [key, value] of index) {
        const [kind, slug, id] = key.split("/");
        const doc = JSON.stringify(value);
        if (kind === "task") ins.task.run(slug, doc);
        else if (kind === "execution") ins.execution.run(slug, doc);
        else ins.session.run(slug, id, doc);
      }
      for (const t of tracked) {
        const m = t.path.match(/\/tasks\/([^/]+)\/artifacts\/([^/]+)$/);
        if (m) ins.artifact.run(m[1], m[2], t.size, t.mtimeMs);
      }
    })());
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    db.close();

    // Daemon start under O3 (b): load every row into the in-memory store instead of scanning files.
    Bun.gc(true);
    const [rows, loadMs] = time(() => {
      const d = open(dbPath);
      const m = new Map<string, unknown>();
      for (const r of d.query("SELECT slug, doc FROM task").all() as { slug: string; doc: string }[]) m.set(`task/${r.slug}`, JSON.parse(r.doc));
      for (const r of d.query("SELECT slug, doc FROM execution").all() as { slug: string; doc: string }[]) m.set(`execution/${r.slug}`, JSON.parse(r.doc));
      for (const r of d.query("SELECT slug, id, doc FROM session").all() as { slug: string; id: string; doc: string }[]) m.set(`session/${r.slug}/${r.id}`, JSON.parse(r.doc));
      for (const r of d.query("SELECT slug, name, size, mtime FROM artifact").all() as { slug: string; name: string }[]) m.set(`artifact/${r.slug}/${r.name}`, r);
      d.close();
      return m.size;
    });

    // A consistent snapshot for a backup (O11 b zips it with the rest of .alinery).
    const snap = join(scratch, `x${copies}.snapshot.db`);
    rmSync(snap, { force: true });
    const d = open(dbPath);
    const [, vacuumMs] = time(() => d.exec(`VACUUM INTO '${snap}'`));
    // Full export: every task.md written again from its row (temp file + rename, no sync).
    const [, exportMs] = time(() => {
      for (const r of d.query("SELECT slug, doc FROM task").all() as { slug: string; doc: string }[]) {
        const p = join(root, r.slug, "task.md");
        writeFileSync(`${p}.tmp`, Bun.TOML.stringify(JSON.parse(r.doc)));
        renameSync(`${p}.tmp`, p);
      }
    });
    d.close();
    console.log(JSON.stringify({
      tasks: readdirSync(root).length, rows, fileScanMs: r3(scanMs), importInsertMs: r3(insertMs), sqliteLoadMs: r3(loadMs),
      dbMB: r3(statSync(dbPath).size / 1e6), vacuumIntoMs: r3(vacuumMs), snapshotMB: r3(statSync(snap).size / 1e6), exportAllTaskMdMs: r3(exportMs),
    }));
  }
  rmSync(scratch, { recursive: true, force: true });
} else {
  throw new Error("usage: sqlite-bench.ts commit <dir> [n] | import <real .alinery> <scratch> [copies...]");
}
