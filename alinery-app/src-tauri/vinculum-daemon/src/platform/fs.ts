// Every daemon file write goes through here (check-daemon-fs-writes.sh). Mirrors alinery-core/src/fs_atomic.rs.
import { chmodSync, closeSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";

let tmpSeq = 0;

// The syncs of writeDurable run on one long-lived Worker (O26 a); see fsync-worker.ts.
let worker: Worker | undefined;
let syncSeq = 0;
let syncsIssued = 0;
const waiting = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();

function syncWorker(): Worker {
  if (worker) return worker;
  // In the compiled daemon every module's import.meta.url is the entry's, so the worker (a second
  // entry point of the build, see dev-fetch-bun.sh) is addressed inside the embedded filesystem.
  const compiled = import.meta.url.includes("/$bunfs/");
  const created = new Worker(compiled ? "/$bunfs/root/platform/fsync-worker.js" : new URL("./fsync-worker.ts", import.meta.url));
  created.onmessage = (event: MessageEvent<{ id: number; syncs: number; error?: string }>) => {
    const { id, syncs, error } = event.data;
    syncsIssued = syncs;
    const wait = waiting.get(id);
    waiting.delete(id);
    if (error) wait?.reject(new Error(error));
    else wait?.resolve();
  };
  created.onerror = (event) => {
    worker = undefined;
    for (const wait of waiting.values()) wait.reject(new Error(`fsync worker failed: ${event.message}`));
    waiting.clear();
  };
  created.unref(); // an idle worker must not keep the daemon alive
  worker = created;
  return created;
}

function fullSync(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const id = syncSeq++;
    waiting.set(id, { resolve, reject });
    syncWorker().postMessage({ id, paths: [path] });
  });
}

/** How many full syncs the worker has issued since it started (a test reads this). */
export const fullSyncsIssued = () => syncsIssued;

function writeTemp(path: string, data: string | Uint8Array, mode: number): string {
  const tmp = `${path}.tmp.${process.pid}.${process.hrtime.bigint()}.${tmpSeq++}`;
  const fd = openSync(tmp, "wx", mode);
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
  return tmp;
}

/** fs_atomic.rs write_bytes_atomic: temp file in the same directory, then rename. */
export function writeAtomic(path: string, data: string | Uint8Array, mode = 0o644) {
  renameSync(writeTemp(path, data, mode), path);
}

/**
 * fs_atomic.rs write_bytes_durable: as writeAtomic, plus a full sync of the file before the rename
 * and of its directory after, the same order as Rust. Write and rename run here; the syncs run on the
 * fsync Worker, and the returned promise settles when both are on disk. A caller inside
 * withTaskMutation awaits it with the flock held; the wait is bounded by the disk, not by a client.
 */
export async function writeDurable(path: string, data: string | Uint8Array, mode = 0o644): Promise<void> {
  const tmp = writeTemp(path, data, mode);
  try {
    await fullSync(tmp);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  renameSync(tmp, path);
  await fullSync(dirname(path));
}

/** 0700 directory for anything secret. */
export function mkdirOwnerOnly(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

/** 0600 file, replaced atomically. */
export function writeOwnerOnly(path: string, data: string | Uint8Array) {
  writeAtomic(path, data, 0o600);
}
