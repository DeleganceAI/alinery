import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { tryLockExclusive, waitForLock } from "./lock.ts";
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
