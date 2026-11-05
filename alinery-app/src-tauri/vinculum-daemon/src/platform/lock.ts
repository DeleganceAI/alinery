// flock(2) through bun:ffi, ported from alinery-core/src/lockfile.rs. Lock markers are 0-byte files, never unlinked.
import { dlopen, FFIType, type Pointer, read } from "bun:ffi";
import { closeSync, constants, fstatSync, openSync, statSync } from "node:fs";
import { join } from "node:path";

const LOCK_SH = 1;
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const darwin = process.platform === "darwin";
/** EWOULDBLOCK, which equals EAGAIN on both: 35 on macOS, 11 on Linux. */
const EWOULDBLOCK = darwin ? 35 : 11;
const ERRNO_FN = darwin ? "__error" : "__errno_location";

const libc = dlopen(darwin ? "libSystem.B.dylib" : "libc.so.6", {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  [ERRNO_FN]: { args: [], returns: FFIType.ptr },
});

// bun:ffi cannot capture errno, so nothing may run between the failed flock and this read.
function flockErrno(fd: number, op: number): number {
  if (libc.symbols.flock(fd, op) === 0) return 0;
  return read.i32(libc.symbols[ERRNO_FN]() as Pointer, 0);
}

export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class LockHandle {
  constructor(readonly fd: number) {}
  release() {
    libc.symbols.flock(this.fd, LOCK_UN);
    closeSync(this.fd);
  }
}

/**
 * lockfile.rs try_lock_exclusive. Never flock without LOCK_NB: it would block the event loop.
 * `afterOpen` runs between the open and the flock, so a test can replace the file there.
 */
export function tryLockExclusive(path: string, afterOpen?: () => void): LockHandle | null {
  for (let attempt = 0; attempt < 5; attempt++) {
    const fd = openSync(path, constants.O_RDWR | constants.O_CREAT, 0o600);
    afterOpen?.();
    const err = flockErrno(fd, LOCK_EX | LOCK_NB);
    if (err !== 0) {
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

/**
 * lockfile.rs is_locked_by_other: is `path` held exclusively by someone else? A shared probe, so it
 * never competes with an owner's claim. A path that cannot be opened is not held.
 */
export function isLockedByOther(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDWR | constants.O_CREAT, 0o600);
  } catch {
    return false;
  }
  try {
    const err = flockErrno(fd, LOCK_SH | LOCK_NB);
    if (err !== 0) return err === EWOULDBLOCK;
    libc.symbols.flock(fd, LOCK_UN);
    return false;
  } finally {
    closeSync(fd);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Retry tryLockExclusive with a 10, 20, 40 ms (cap 100 ms) timer backoff until `waitMs` has passed; 0 tries once. */
export async function waitForLock(path: string, waitMs: number): Promise<LockHandle | null> {
  const end = Date.now() + waitMs;
  let delay = 10;
  for (;;) {
    const lock = tryLockExclusive(path);
    if (lock) return lock;
    const left = end - Date.now();
    if (left <= 0) return null;
    await sleep(Math.min(delay, left));
    delay = Math.min(delay * 2, 100);
  }
}

export const taskMutationLockPath = (repo: string) => join(repo, ".alinery", ".task-mutation.lock");

/** lockfile.rs TASK_MUTATION_CONTENTION_WAIT. */
export const TASK_MUTATION_WAIT_MS = 2_000;

const queues = new Map<string, Promise<unknown>>(); // per repo: serializes callers in this process

/**
 * with_task_mutation_lock: a process queue, then the flock on `.alinery/.task-mutation.lock`.
 * `fn` does no client I/O while the flock is held, so a slow client cannot hold the repo lock. It may
 * return a promise only to await a durable write's sync (writeDurable), which the disk bounds. The
 * deadline starts at enqueue, so N callers behind a long hold all fail `repo_busy` together.
 */
export function withTaskMutation<T>(repo: string, op: string, fn: () => T | Promise<T>): Promise<T> {
  const prev = queues.get(repo) ?? Promise.resolve();
  const deadline = Date.now() + TASK_MUTATION_WAIT_MS;
  const run = prev
    .catch(() => {})
    .then(async () => {
      const lock = await waitForLock(taskMutationLockPath(repo), Math.max(0, deadline - Date.now()));
      if (!lock) throw new DomainError("repo_busy", `task mutation busy during ${op}`);
      try {
        return await fn();
      } finally {
        lock.release();
      }
    });
  queues.set(repo, run);
  return run;
}
