// S0.5 sample: flock(2), errno and F_FULLFSYNC through bun:ffi, the primitives under
// platform/lock.ts and platform/fs.ts (docs/thick-daemon-plan.md 2.3.2). tryLockExclusive and
// isLockedByOther port alinery-core/src/lockfile.rs:36-93; lock.test.ts runs them against it.
import { dlopen, FFIType, type Pointer, read } from "bun:ffi";
import { closeSync, constants, fstatSync, openSync, statSync } from "node:fs";

// Same values on macOS and Linux.
export const LOCK_SH = 1;
export const LOCK_EX = 2;
export const LOCK_NB = 4;
export const LOCK_UN = 8;

const darwin = process.platform === "darwin";
/** EWOULDBLOCK, which equals EAGAIN on both: 35 on macOS, 11 on Linux. */
export const EWOULDBLOCK = darwin ? 35 : 11;
/** macOS <sys/fcntl.h>. */
export const F_FULLFSYNC = 51;
const ERRNO_FN = darwin ? "__error" : "__errno_location";

const libc = dlopen(darwin ? "libSystem.B.dylib" : "libc.so.6", {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  fsync: { args: [FFIType.i32], returns: FFIType.i32 },
  // fcntl is variadic and bun:ffi has no variadic calls. On Apple arm64 a variadic argument is
  // passed on the stack, not in a register, so this two-argument binding is only valid for a
  // command that takes no third argument, such as F_FULLFSYNC.
  fcntl: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  // Both return the calling thread's errno address (int *).
  [ERRNO_FN]: { args: [], returns: FFIType.ptr },
});

/** The calling thread's errno. Only meaningful as the very next FFI call after the failed one. */
export function errno(): number {
  return read.i32(libc.symbols[ERRNO_FN]() as Pointer, 0);
}

/** flock(2); on failure errno is read by the next FFI call, with no Bun API call between. */
export function flock(fd: number, op: number): { rc: number; errno: number } {
  const rc = libc.symbols.flock(fd, op);
  const err = rc === 0 ? 0 : errno();
  return { rc, errno: err };
}

/** The raw symbols, for the errno-clobber measurement in lock.test.ts. */
export const raw = libc.symbols;

export function fsyncRaw(fd: number): number {
  return libc.symbols.fsync(fd);
}

/** macOS only: fcntl(fd, F_FULLFSYNC), what Rust's File::sync_all calls on Apple targets. */
export function fullFsync(fd: number): number {
  return libc.symbols.fcntl(fd, F_FULLFSYNC);
}

export class LockHandle {
  constructor(readonly fd: number) {}
  release() {
    libc.symbols.flock(this.fd, LOCK_UN);
    closeSync(this.fd);
  }
}

function openMarker(path: string): number {
  // lockfile.rs:42-47: read+write, create, never truncate (a 0-byte marker, never unlinked).
  return openSync(path, constants.O_RDWR | constants.O_CREAT, 0o600);
}

// lockfile.rs:25 try_lock_exclusive. Never flock without LOCK_NB here: it would block the event loop.
export function tryLockExclusive(path: string): LockHandle | null {
  for (let attempt = 0; attempt < 5; attempt++) {
    const fd = openMarker(path);
    const { rc, errno: err } = flock(fd, LOCK_EX | LOCK_NB);
    if (rc !== 0) {
      closeSync(fd);
      if (err === EWOULDBLOCK) return null;
      throw new Error(`flock ${path}: errno ${err}`);
    }
    // flock is per inode: if the file was replaced between open and flock, lock the new one.
    const held = fstatSync(fd);
    const now = statSync(path, { throwIfNoEntry: false });
    if (now && now.dev === held.dev && now.ino === held.ino) return new LockHandle(fd);
    closeSync(fd);
  }
  throw new Error(`lock file kept being replaced underneath: ${path}`);
}

// lockfile.rs:82 is_locked_by_other: a shared probe, so it never competes with an owner's claim.
export function isLockedByOther(path: string): boolean {
  let fd: number;
  try {
    fd = openMarker(path);
  } catch {
    return false;
  }
  try {
    const { rc, errno: err } = flock(fd, LOCK_SH | LOCK_NB);
    if (rc !== 0) return err === EWOULDBLOCK;
    libc.symbols.flock(fd, LOCK_UN);
    return false;
  } finally {
    closeSync(fd);
  }
}
