// S0.5: cost of one 1 KiB atomic replace (create tmp, write, sync, close, rename, sync dir) per
// sync mode, the shape of fs_atomic.rs write_bytes_durable (:30-53). The dir is synced the same
// way as the file, as Rust's File::sync_all does both. Usage: bun src/fsync-bench.ts <dir> [n]
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";
import { fsyncRaw, fullFsync } from "./lock";

const dir = process.argv[2];
const n = Number(process.argv[3] ?? 1000);
if (!dir) throw new Error("usage: bun src/fsync-bench.ts <dir> [n]");
mkdirSync(dir, { recursive: true });

function ok(rc: number) {
  if (rc !== 0) throw new Error(`sync failed: rc ${rc}`);
}
const modes: [string, ((fd: number) => void) | null][] = [
  ["no sync", null],
  ["fsync(2) via bun:ffi", (fd) => ok(fsyncRaw(fd))],
  ["fs.fsyncSync", (fd) => fsyncSync(fd)],
];
if (process.platform === "darwin") modes.push(["F_FULLFSYNC via bun:ffi", (fd) => ok(fullFsync(fd))]);

const data = new Uint8Array(1024).fill(120);
let seq = 0;
function writeOnce(path: string, sync: ((fd: number) => void) | null) {
  const tmp = `${path}.tmp.${process.pid}.${seq++}`;
  const fd = openSync(tmp, "wx", 0o644);
  try {
    writeSync(fd, data);
    sync?.(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  if (sync) {
    const dfd = openSync(dir, "r");
    try {
      sync(dfd);
    } finally {
      closeSync(dfd);
    }
  }
}

for (const [mode, sync] of modes) {
  const path = join(dir, `bun-${mode.replace(/\W+/g, "-")}.json`);
  for (let i = 0; i < 20; i++) writeOnce(path, sync);
  const ms: number[] = [];
  for (let i = 0; i < n; i++) {
    const start = Bun.nanoseconds();
    writeOnce(path, sync);
    ms.push((Bun.nanoseconds() - start) / 1e6);
  }
  ms.sort((a, b) => a - b);
  const pick = (q: number) => ms[Math.max(0, Math.ceil(ms.length * q) - 1)];
  const mean = ms.reduce((a, b) => a + b, 0) / ms.length;
  console.log(JSON.stringify({ mode, n, p50_ms: +pick(0.5).toFixed(3), p99_ms: +pick(0.99).toFixed(3), mean_ms: +mean.toFixed(3) }));
}
