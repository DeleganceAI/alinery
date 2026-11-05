// Every daemon file write goes through here (check-daemon-fs-writes.sh). Mirrors alinery-core/src/fs_atomic.rs.
import { dlopen, FFIType } from "bun:ffi";
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";

let tmpSeq = 0;

// Rust's File::sync_all is fcntl(F_FULLFSYNC) on Apple targets; Bun's fsyncSync is plain fsync(2).
// fcntl is variadic and bun:ffi has no variadic calls: this two-argument binding is valid only for
// a command with no third argument, such as F_FULLFSYNC.
const F_FULLFSYNC = 51;
const darwin = process.platform === "darwin";
const fcntl = darwin ? dlopen("libSystem.B.dylib", { fcntl: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } }).symbols.fcntl : null;

function fullSync(fd: number) {
  if (fcntl) {
    if (fcntl(fd, F_FULLFSYNC) !== 0) throw new Error("fcntl(F_FULLFSYNC) failed");
  } else {
    fsyncSync(fd);
  }
}

function writeTemp(path: string, data: string | Uint8Array, mode: number, sync: boolean): string {
  const tmp = `${path}.tmp.${process.pid}.${process.hrtime.bigint()}.${tmpSeq++}`;
  const fd = openSync(tmp, "wx", mode);
  try {
    writeSync(fd, data);
    if (sync) fullSync(fd);
  } finally {
    closeSync(fd);
  }
  return tmp;
}

/** fs_atomic.rs write_bytes_atomic: temp file in the same directory, then rename. */
export function writeAtomic(path: string, data: string | Uint8Array, mode = 0o644) {
  renameSync(writeTemp(path, data, mode, false), path);
}

/** fs_atomic.rs write_bytes_durable: as writeAtomic, plus a full sync of the file and its directory. */
export function writeDurable(path: string, data: string | Uint8Array, mode = 0o644) {
  renameSync(writeTemp(path, data, mode, true), path);
  const dir = openSync(dirname(path), "r");
  try {
    fullSync(dir);
  } finally {
    closeSync(dir);
  }
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
