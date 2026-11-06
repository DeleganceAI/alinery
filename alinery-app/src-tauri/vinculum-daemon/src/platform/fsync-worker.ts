// Nothing but the F_FULLFSYNC binding, on a thread of its own so the loop that owns every PTY never waits on the disk (O26 a).
import { dlopen, FFIType } from "bun:ffi";
import { closeSync, fsyncSync, openSync } from "node:fs";

declare const self: Worker;

// Rust's File::sync_all is fcntl(F_FULLFSYNC) on Apple targets; Bun's fsyncSync is plain fsync(2).
// fcntl is variadic and bun:ffi has no variadic calls: this two-argument binding is valid only for
// a command with no third argument, such as F_FULLFSYNC.
const F_FULLFSYNC = 51;
const fcntl = process.platform === "darwin" ? dlopen("libSystem.B.dylib", { fcntl: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } }).symbols.fcntl : null;

let syncs = 0; // full syncs issued so far; the reply carries it so a test can count them
function fullSync(fd: number) {
  syncs++;
  if (fcntl) {
    if (fcntl(fd, F_FULLFSYNC) !== 0) throw new Error("fcntl(F_FULLFSYNC) failed");
  } else {
    fsyncSync(fd);
  }
}

self.onmessage = (event: MessageEvent<{ id: number; paths: string[] }>) => {
  const { id, paths } = event.data;
  try {
    for (const path of paths) {
      const fd = openSync(path, "r");
      try {
        fullSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    postMessage({ id, syncs });
  } catch (error) {
    postMessage({ id, syncs, error: String(error) });
  }
};
