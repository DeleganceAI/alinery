// S0.5 interop test: alinery-core's lockfile.rs (through ../lock-rs) and bun:ffi flock on the same
// file, both ways, plus errno after the failed call. The plan keeps it as the S2.2 test.
//
// macOS, from docs/thick-daemon-spikes:
//   (cd lock-rs && CARGO_TARGET_DIR=$T cargo build --release --locked)
//   LOCK_RS_BIN=$T/release/lock-rs bun test ./src/lock.test.ts
// Linux: cross-build lock-rs with `cargo zigbuild --target aarch64-unknown-linux-gnu`, then run the
// same `bun test` with a Linux Bun inside debian:12 (commands in the S0.5 report).
import { afterAll, expect, test } from "bun:test";
import { closeSync, constants, mkdtempSync, openSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EWOULDBLOCK, errno, flock, isLockedByOther, LOCK_EX, LOCK_NB, LOCK_SH, LOCK_UN, raw, tryLockExclusive } from "./lock";

const BIN = process.env.LOCK_RS_BIN ?? "";
if (!BIN) throw new Error("set LOCK_RS_BIN to the built lock-rs binary (see the header)");
const dir = mkdtempSync(join(tmpdir(), "s05-lock-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const TRIES = 1000;
const report = (name: string, value: unknown) => console.log(`S05 ${process.platform}/${process.arch} ${name} ${JSON.stringify(value)}`);

/** lock-rs holds LOCK_EX through try_lock_exclusive until release() closes its stdin. */
async function rustHolds(path: string) {
  const child = Bun.spawn([BIN, "hold", path], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (!out.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value);
  }
  expect(out).toBe("held\n");
  return {
    async release() {
      child.stdin.end();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        out += decoder.decode(value);
      }
      expect(await child.exited).toBe(0);
      expect(out).toBe("held\nreleased\n");
    },
  };
}

function rustTry(path: string): string {
  const result = Bun.spawnSync([BIN, "try", path]);
  expect(result.exitCode).toBe(0);
  return result.stdout.toString();
}

function openRw(path: string): number {
  return openSync(path, constants.O_RDWR | constants.O_CREAT, 0o600);
}

function tally(values: number[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const v of values) counts[v] = (counts[v] ?? 0) + 1;
  return counts;
}

test("Rust holds LOCK_EX: bun:ffi flock(LOCK_EX|LOCK_NB) gets -1 and EWOULDBLOCK", async () => {
  const path = join(dir, "rust-holds.lock");
  const held = await rustHolds(path);
  const fd = openRw(path);
  expect(flock(fd, LOCK_EX | LOCK_NB)).toEqual({ rc: -1, errno: EWOULDBLOCK });
  expect(flock(fd, LOCK_SH | LOCK_NB)).toEqual({ rc: -1, errno: EWOULDBLOCK });
  expect(tryLockExclusive(path)).toBeNull();
  expect(isLockedByOther(path)).toBe(true);
  await held.release();
  expect(flock(fd, LOCK_EX | LOCK_NB)).toEqual({ rc: 0, errno: 0 });
  expect(flock(fd, LOCK_UN).rc).toBe(0);
  closeSync(fd);
  expect(isLockedByOther(path)).toBe(false);
});

test("Bun holds LOCK_EX: Rust try_lock_exclusive reports busy, is_locked_by_other true", () => {
  const path = join(dir, "bun-holds.lock");
  const lock = tryLockExclusive(path);
  expect(lock).not.toBeNull();
  expect(rustTry(path)).toBe("busy\nlocked_by_other true\n");
  lock?.release();
  expect(rustTry(path)).toBe("acquired\nlocked_by_other false\n");
});

test(`errno read straight after the failed flock is EWOULDBLOCK on all ${TRIES} tries`, async () => {
  const path = join(dir, "errno.lock");
  const held = await rustHolds(path);
  const fd = openRw(path);
  const rcs: number[] = [];
  const errnos: number[] = [];
  for (let i = 0; i < TRIES; i++) {
    const r = flock(fd, LOCK_EX | LOCK_NB);
    rcs.push(r.rc);
    errnos.push(r.errno);
  }
  // The full port: open, flock, errno, close per try (it throws on any errno but EWOULDBLOCK).
  let nulls = 0;
  for (let i = 0; i < TRIES; i++) if (tryLockExclusive(path) === null) nulls++;
  closeSync(fd);
  await held.release();
  report("errno_back_to_back", { tries: TRIES, rc: tally(rcs), errno: tally(errnos), tryLockExclusive_null: nulls });
  expect(tally(rcs)).toEqual({ "-1": TRIES });
  expect(tally(errnos)).toEqual({ [EWOULDBLOCK]: TRIES });
  expect(nulls).toBe(TRIES);
});

test("back-to-back errno stays EWOULDBLOCK while the GC is busy around the pair", async () => {
  // Allocation between pairs keeps the collector running; the pair itself allocates nothing, so
  // no GC can be scheduled on this thread between the two FFI calls.
  const path = join(dir, "pressure.lock");
  const held = await rustHolds(path);
  const fd = openRw(path);
  const errnos: number[] = [];
  let keep: unknown[] = [];
  for (let i = 0; i < 20 * TRIES; i++) {
    keep = Array.from({ length: 200 }, (_, j) => ({ i, j, s: `x${i}.${j}` }));
    errnos.push(flock(fd, LOCK_EX | LOCK_NB).errno);
  }
  closeSync(fd);
  await held.release();
  report("errno_back_to_back_under_gc_pressure", { tries: 20 * TRIES, kept: keep.length, errno: tally(errnos) });
  expect(tally(errnos)).toEqual({ [EWOULDBLOCK]: 20 * TRIES });
}, 60_000);

test("a failing Bun call between flock and the errno read clobbers errno", async () => {
  // Measures the risk named in the plan: errno is per thread, and Bun's own syscalls on the JS
  // thread write it. statSync of a missing path fails with ENOENT inside Bun.
  const path = join(dir, "clobber.lock");
  const held = await rustHolds(path);
  const fd = openRw(path);
  const missing = join(dir, "does-not-exist");
  const statBetween: number[] = [];
  for (let i = 0; i < TRIES; i++) {
    raw.flock(fd, LOCK_EX | LOCK_NB);
    statSync(missing, { throwIfNoEntry: false });
    statBetween.push(errno());
  }
  const gcBetween: number[] = [];
  for (let i = 0; i < 100; i++) {
    raw.flock(fd, LOCK_EX | LOCK_NB);
    Bun.gc(true);
    gcBetween.push(errno());
  }
  const allocBetween: number[] = [];
  for (let i = 0; i < TRIES; i++) {
    raw.flock(fd, LOCK_EX | LOCK_NB);
    const junk = Array.from({ length: 2000 }, (_, j) => ({ j, s: `x${j}` }));
    if (junk.length !== 2000) throw new Error("unreachable");
    allocBetween.push(errno());
  }
  closeSync(fd);
  await held.release();
  report("errno_with_statSync_between", tally(statBetween));
  report("errno_with_Bun.gc(true)_between", tally(gcBetween));
  report("errno_with_allocation_between", tally(allocBetween));
  const ENOENT = 2; // same on macOS and Linux
  expect(tally(statBetween)).toEqual({ [ENOENT]: TRIES });
}, 60_000);

test("two descriptors in one process exclude each other", () => {
  const path = join(dir, "same-process.lock");
  const a = openRw(path);
  const b = openRw(path);
  const first = flock(a, LOCK_EX | LOCK_NB);
  const second = flock(b, LOCK_EX | LOCK_NB);
  report("same_process_two_fds", { first, second });
  expect(first.rc).toBe(0);
  expect(second).toEqual({ rc: -1, errno: EWOULDBLOCK });
  closeSync(a);
  expect(flock(b, LOCK_EX | LOCK_NB).rc).toBe(0);
  closeSync(b);
});
