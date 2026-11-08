import { fstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { isLockedByOther, tryLockExclusive, taskMutationLockPath, waitForLock, withTaskMutation } from "./lock.ts";
import { holderBinary, holdFromRust } from "./rustHolder.ts";

const dir = mkdtempSync(join(tmpdir(), "daemon-lock-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
// Builds the Rust holder once, before any test's timer starts.
beforeAll(() => void holderBinary(), 120_000);

test("a lock held by the Rust lockfile.rs excludes tryLockExclusive, and releasing frees it", async () => {
  const path = join(dir, "a.lock");
  const holder = await holdFromRust(path);
  expect(tryLockExclusive(path)).toBeNull();
  await holder.release();
  const mine = tryLockExclusive(path);
  expect(mine).not.toBeNull();
  mine?.release();
});

test("tryLockExclusive excludes a second descriptor in this process", () => {
  const path = join(dir, "b.lock");
  const first = tryLockExclusive(path);
  expect(first).not.toBeNull();
  expect(tryLockExclusive(path)).toBeNull();
  first?.release();
  tryLockExclusive(path)?.release();
});

test("waitForLock returns once the Rust holder lets go, and null if the wait runs out first", async () => {
  const path = join(dir, "c.lock");
  const holder = await holdFromRust(path);
  expect(await waitForLock(path, 0)).toBeNull();
  const started = Date.now();
  const waiting = waitForLock(path, 3_000);
  setTimeout(() => void holder.release(), 300);
  const lock = await waiting;
  expect(lock).not.toBeNull();
  expect(Date.now() - started).toBeLessThan(1_000);
  lock?.release();

  const again = await holdFromRust(path);
  expect(await waitForLock(path, 150)).toBeNull();
  await again.release();
});

test("isLockedByOther is true while the Rust helper holds the lock and false after", async () => {
  const path = join(dir, "d.lock");
  expect(isLockedByOther(path)).toBe(false); // a path nobody holds, created on the way
  const holder = await holdFromRust(path);
  expect(isLockedByOther(path)).toBe(true);
  await holder.release();
  expect(isLockedByOther(path)).toBe(false);
});

test("isLockedByOther sees this process's own exclusive lock through another descriptor, and takes none itself", () => {
  const path = join(dir, "e.lock");
  const mine = tryLockExclusive(path);
  expect(isLockedByOther(path)).toBe(true);
  mine?.release();
  expect(isLockedByOther(path)).toBe(false);
  tryLockExclusive(path)?.release(); // the probe left nothing held
});

test("a lock file replaced between open and flock is retried and the new file is locked", () => {
  const path = join(dir, "f.lock");
  writeFileSync(path, "");
  const original = statSync(path).ino;
  let replaced = 0;
  const lock = tryLockExclusive(path, () => {
    if (replaced++ > 0) return;
    writeFileSync(`${path}.new`, "");
    renameSync(`${path}.new`, path); // the descriptor just opened now points at an unlinked inode
  });
  expect(replaced).toBe(2);
  expect(lock).not.toBeNull();
  const held = fstatSync(lock!.fd).ino;
  expect(held).toBe(statSync(path).ino);
  expect(held).not.toBe(original);
  expect(tryLockExclusive(path)).toBeNull(); // the file now at `path` is the locked one
  lock?.release();
});

test("withTaskMutation holds the flock until an awaited durable step finishes", async () => {
  const repo = mkdtempSync(join(dir, "repo-"));
  mkdirSync(join(repo, ".alinery"));
  const lockPath = taskMutationLockPath(repo);
  let heldDuring: boolean | undefined;
  await withTaskMutation(repo, "test", async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    heldDuring = isLockedByOther(lockPath);
  });
  expect(heldDuring).toBe(true);
  expect(isLockedByOther(lockPath)).toBe(false);
});
