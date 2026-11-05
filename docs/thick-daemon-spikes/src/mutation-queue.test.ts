// withTaskMutation (plan 2.3.2, v0.7): a per-repo promise queue in front of the flock on
// .alinery/.task-mutation.lock, where each caller's 2 s deadline starts at enqueue. Against it, the
// v0.6 shape, where the 2 s wait starts only when the caller reaches the head of the queue.
// The competing holder is alinery-core's try_lock_exclusive through ../lock-rs, as in lock.test.ts.
//
//   (cd lock-rs && CARGO_TARGET_DIR=$T/lock cargo build --release --locked)
//   LOCK_RS_BIN=$T/lock/release/lock-rs bun test src/mutation-queue.test.ts
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LockHandle, tryLockExclusive } from "./lock";

const BIN = process.env.LOCK_RS_BIN ?? "";
if (!BIN) throw new Error("set LOCK_RS_BIN to the built lock-rs binary (see the header)");
const root = mkdtempSync(join(tmpdir(), "s06-mutq-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const report = (name: string, value: unknown) => console.log(`S06 ${name} ${JSON.stringify(value)}`);

const CONTENTION_WAIT_MS = 2_000; // TASK_MUTATION_CONTENTION_WAIT, lockfile.rs:118

class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const lockPath = (repo: string) => join(repo, ".alinery", ".task-mutation.lock");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retries tryLockExclusive with 10, 20, 40 ms ... capped at 100 ms until waitMs runs out; 0 tries once. */
async function waitForLock(path: string, waitMs: number): Promise<LockHandle | null> {
  const deadline = Date.now() + waitMs;
  let backoff = 10;
  for (;;) {
    const lock = tryLockExclusive(path);
    if (lock) return lock;
    const left = deadline - Date.now();
    if (left <= 0) return null;
    await sleep(Math.min(backoff, left));
    backoff = Math.min(backoff * 2, 100);
  }
}

type Mode = "enqueue" | "head";

function makeWithTaskMutation(mode: Mode) {
  const queues = new Map<string, Promise<unknown>>(); // per repo: serializes callers in this process
  return async function withTaskMutation<T>(repo: string, op: string, fn: () => T): Promise<T> {
    const prev = queues.get(repo) ?? Promise.resolve();
    const enqueuedAt = Date.now();
    const run = prev
      .catch(() => {})
      .then(async () => {
        // v0.7: the deadline was fixed at enqueue. v0.6: it starts now, at the head of the queue.
        const deadline = (mode === "enqueue" ? enqueuedAt : Date.now()) + CONTENTION_WAIT_MS;
        const lock = await waitForLock(lockPath(repo), Math.max(0, deadline - Date.now()));
        if (!lock) throw new DomainError("repo_busy", `task mutation busy during ${op}`);
        try {
          return fn();
        } finally {
          lock.release();
        }
      });
    queues.set(repo, run);
    return run;
  };
}

/** lock-rs holds LOCK_EX through alinery-core's try_lock_exclusive until stdin closes. */
async function rustHolds(path: string) {
  const child = Bun.spawn([BIN, "hold", path], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  const reader = child.stdout.getReader();
  let out = "";
  while (!out.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    out += new TextDecoder().decode(value);
  }
  expect(out).toBe("held\n");
  return {
    async release() {
      child.stdin.end();
      expect(await child.exited).toBe(0);
    },
  };
}

function newRepo(name: string): string {
  const repo = join(root, name);
  mkdirSync(join(repo, ".alinery"), { recursive: true });
  writeFileSync(join(repo, "counter"), "0");
  return repo;
}

/** n concurrent calls; each one reads, increments and writes a counter (a lost update would show). */
async function burst(mode: Mode, repo: string, n: number) {
  const withTaskMutation = makeWithTaskMutation(mode);
  const counter = join(repo, "counter");
  const t0 = performance.now();
  const results = await Promise.all(
    Array.from({ length: n }, (_, i) =>
      withTaskMutation(repo, `op${i}`, () => {
        writeFileSync(counter, String(Number(readFileSync(counter, "utf8")) + 1));
        return performance.now() - t0;
      }).then(
        (ms) => ({ ok: true as const, ms }),
        (e: DomainError) => ({ ok: false as const, code: e.code, ms: performance.now() - t0 }),
      ),
    ),
  );
  const ms = results.map((r) => r.ms);
  return {
    ok: results.filter((r) => r.ok).length,
    busy: results.filter((r) => !r.ok && r.code === "repo_busy").length,
    firstMs: Math.round(Math.min(...ms)),
    lastMs: Math.round(Math.max(...ms)),
    counter: Number(readFileSync(counter, "utf8")),
    settledMs: ms.map(Math.round),
  };
}

test("v0.7, 500 ms Rust hold: 50 concurrent calls all succeed, none lost", async () => {
  const repo = newRepo("hold-500");
  const held = await rustHolds(lockPath(repo));
  const releasing = sleep(500).then(() => held.release());
  const r = await burst("enqueue", repo, 50);
  await releasing;
  report("enqueue hold=500ms n=50", { ok: r.ok, busy: r.busy, counter: r.counter, firstMs: r.firstMs, lastMs: r.lastMs });
  expect(r.ok).toBe(50);
  expect(r.counter).toBe(50);
  expect(r.firstMs).toBeGreaterThanOrEqual(480);
  expect(r.lastMs).toBeLessThan(CONTENTION_WAIT_MS);
}, 10_000);

test("v0.7, 5 s Rust hold: all 50 fail repo_busy within ~2.2 s of the first call", async () => {
  const repo = newRepo("hold-5000");
  const held = await rustHolds(lockPath(repo));
  const r = await burst("enqueue", repo, 50);
  await held.release();
  report("enqueue hold=5000ms n=50", { ok: r.ok, busy: r.busy, counter: r.counter, firstMs: r.firstMs, lastMs: r.lastMs });
  expect(r.busy).toBe(50);
  expect(r.counter).toBe(0);
  expect(r.firstMs).toBeGreaterThanOrEqual(CONTENTION_WAIT_MS - 20);
  expect(r.lastMs).toBeLessThan(2_200);
}, 10_000);

test("v0.6 (deadline at queue head), 11 s Rust hold: 5 calls fail one after another, 2 s apart", async () => {
  // 5 calls x 2 s = 10 s, so the hold must outlast that or the 6th second's caller would succeed.
  const repo = newRepo("hold-head");
  const held = await rustHolds(lockPath(repo));
  const releasing = sleep(11_000).then(() => held.release());
  const r = await burst("head", repo, 5);
  await releasing;
  const sorted = [...r.settledMs].sort((a, b) => a - b);
  report("head hold=11000ms n=5", { busy: r.busy, settledMs: sorted, extrapolated50Ms: 50 * CONTENTION_WAIT_MS });
  expect(r.busy).toBe(5);
  sorted.forEach((ms, i) => {
    expect(ms).toBeGreaterThanOrEqual((i + 1) * CONTENTION_WAIT_MS - 20);
    expect(ms).toBeLessThan((i + 1) * CONTENTION_WAIT_MS + 300);
  });
}, 20_000);
