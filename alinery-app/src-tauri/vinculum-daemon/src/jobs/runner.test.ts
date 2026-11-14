import { expect, test } from "bun:test";
import { join } from "node:path";
import { type Entity, JobKind, JobState, type Job } from "alinery-proto/alinery/v1/entities_pb";
import { Store, type Timers } from "../sync/store.ts";
import { jobKey, JobRunner, type RunnerOptions } from "./runner.ts";

const FAKE = join(import.meta.dir, "fake-child.ts");
const fake = () => [process.execPath, FAKE];

/** A store whose commits are recorded, so a test counts them. */
function rig(o: RunnerOptions = {}) {
  const store = new Store();
  const commits: Job[] = [];
  const commit = store.commit.bind(store);
  store.commit = (puts: Entity[], deletes: string[] = []) => {
    for (const e of puts) if (e.value.case === "job") commits.push(structuredClone(e.value.value));
    return commit(puts, deletes);
  };
  const runner = new JobRunner(store, { command: fake, ...o });
  const job = (id: string) => (store.get(jobKey(id))?.value.value as Job | undefined)!;
  const ended = async (id: string) => {
    for (let i = 0; i < 500; i++) {
      const j = job(id);
      if (j && j.state >= JobState.DONE) return j;
      await Bun.sleep(10);
    }
    throw new Error(`job ${id} did not end; last state ${job(id)?.state}`);
  };
  return { store, runner, commits, job, ended };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("100 progress lines in about 100 ms commit one or two progress updates, then the result", async () => {
  const { runner, commits, ended } = rig({ progressMs: 1000 });
  const id = runner.start(JobKind.STORAGE_SCAN, { mode: "progress", lines: 100, gapMs: 1, tag: "/r" });
  const done = await ended(id);
  expect(done.state).toBe(JobState.DONE);
  expect(done.result).toMatchObject({ case: "storage", value: { repoPath: "/r" } });
  const progress = commits.filter((j) => j.state === JobState.RUNNING && j.progress);
  expect(progress.length).toBeGreaterThanOrEqual(1);
  expect(progress.length).toBeLessThanOrEqual(2);
  // The result carries the last progress, so nothing is lost to the throttle.
  expect(done.progress).toMatchObject({ done: 100n, total: 100n, label: "step 100" });
});

test("progress is committed about four times a second", async () => {
  const { runner, commits, ended } = rig(); // 250 ms
  const id = runner.start(JobKind.STORAGE_SCAN, { mode: "progress", lines: 40, gapMs: 25, tag: "x" }); // about 1 s
  await ended(id);
  const progress = commits.filter((j) => j.state === JobState.RUNNING && j.progress).length;
  expect(progress).toBeGreaterThanOrEqual(3);
  expect(progress).toBeLessThanOrEqual(7);
});

test("a child that exits 1 with no result ends FAILED with the tail of its stderr", async () => {
  const { runner, ended } = rig();
  const failed = await ended(runner.start(JobKind.STORAGE_SCAN, { mode: "fail" }));
  expect(failed.state).toBe(JobState.FAILED);
  expect(failed.error).toBe("exit code 1: first line\nthe real reason");
  expect(failed.result.case).toBeUndefined();
});

test("a child that exits 0 without a result, or cannot start, or reports an error, is FAILED", async () => {
  const { runner, ended } = rig();
  expect((await ended(runner.start(JobKind.STORAGE_SCAN, { mode: "silent" }))).error).toBe("exited without a result");
  expect((await ended(runner.start(JobKind.STORAGE_SCAN, { mode: "error" }))).error).toBe("it broke");
  const missing = rig({ command: () => ["/no/such/binary"] });
  const j = await missing.ended(missing.runner.start(JobKind.STORAGE_SCAN, {}));
  expect(j.state).toBe(JobState.FAILED);
  expect(j.error).not.toBe("");
});

test("cancel ends a running job CANCELLED and the child is gone", async () => {
  const { runner, job, ended } = rig();
  const id = runner.start(JobKind.STORAGE_SCAN, { mode: "hang" });
  let pid = 0;
  for (let i = 0; i < 300 && !pid; i++) {
    pid = Number(/pid (\d+)/.exec(job(id).progress?.label ?? "")?.[1] ?? 0);
    await Bun.sleep(10);
  }
  expect(alive(pid)).toBe(true);
  expect(runner.cancel(id)).toBe(true);
  const cancelled = await ended(id);
  expect(cancelled.state).toBe(JobState.CANCELLED);
  expect(alive(pid)).toBe(false);
  expect(runner.cancel("nope")).toBe(false);
  expect(runner.cancel(id)).toBe(true); // already ended: nothing to do
  expect(job(id).state).toBe(JobState.CANCELLED);
});

async function pidOf(job: () => Job | undefined) {
  let pid = 0;
  for (let i = 0; i < 300 && !pid; i++) {
    pid = Number(/pid (\d+)/.exec(job()?.progress?.label ?? "")?.[1] ?? 0);
    await Bun.sleep(10);
  }
  return pid;
}

test("stopAll ends a running job and a queued one, drain leaves no child alive, and nothing starts after", async () => {
  const { runner, job } = rig();
  const running = runner.start(JobKind.BACKUP, { mode: "hang" });
  const queued = runner.start(JobKind.BACKUP, { mode: "slow", ms: 10 });
  const pid = await pidOf(() => job(running));
  expect(alive(pid)).toBe(true);
  runner.stopAll();
  expect(job(queued).state).toBe(JobState.CANCELLED);
  await runner.drain(2000);
  expect(alive(pid)).toBe(false);
  expect(job(running).state).toBe(JobState.CANCELLED);
  expect(job(queued).startedAtMs).toBe(0n);
  const late = runner.start(JobKind.STORAGE_SCAN, { mode: "slow", ms: 10 });
  expect(job(late).state).toBe(JobState.CANCELLED);
  expect(job(late).startedAtMs).toBe(0n);
});

test("drain kills a job child that ignores SIGTERM once the grace has passed", async () => {
  const { runner, job } = rig();
  const id = runner.start(JobKind.PURGE, { mode: "ignore-term" });
  const pid = await pidOf(() => job(id));
  runner.stopAll();
  await Bun.sleep(100);
  expect(alive(pid)).toBe(true); // SIGTERM alone did not end it
  const began = Date.now();
  await runner.drain(200);
  expect(alive(pid)).toBe(false);
  expect(Date.now() - began).toBeGreaterThanOrEqual(150);
});

test("two backups run one after the other, in order; other kinds do not wait for them", async () => {
  const { runner, job, ended } = rig();
  const first = runner.start(JobKind.BACKUP, { mode: "slow", ms: 150 });
  const second = runner.start(JobKind.BACKUP, { mode: "slow", ms: 10 });
  expect(job(first).state).toBe(JobState.RUNNING);
  expect(job(second).state).toBe(JobState.QUEUED);
  const scan = runner.start(JobKind.STORAGE_SCAN, { mode: "silent" });
  expect(job(scan).state).toBe(JobState.RUNNING);
  await ended(second);
  expect(job(first).state).toBe(JobState.DONE);
  expect(job(second).state).toBe(JobState.DONE);
  // The second started only once the first had ended.
  expect(job(second).startedAtMs >= job(first).endedAtMs).toBe(true);
});

test("a queued job cancels at once and never runs", async () => {
  const { runner, job, ended } = rig();
  const first = runner.start(JobKind.BACKUP, { mode: "slow", ms: 100 });
  const second = runner.start(JobKind.BACKUP, { mode: "slow", ms: 10 });
  const third = runner.start(JobKind.BACKUP, { mode: "slow", ms: 10 });
  runner.cancel(second);
  expect(job(second).state).toBe(JobState.CANCELLED);
  await ended(third);
  expect(job(first).state).toBe(JobState.DONE);
  expect(job(second).state).toBe(JobState.CANCELLED);
  expect(job(second).startedAtMs).toBe(0n);
  expect(job(third).startedAtMs >= job(first).endedAtMs).toBe(true);
});

test("an ended job stays in the store for the retention time, then is deleted", async () => {
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const fakeTimers: Timers = { set: (fn, ms) => (timers.push({ fn, ms }), timers.length - 1), clear: () => {} };
  const { runner, store, ended, job } = rig({ timers: fakeTimers });
  const id = runner.start(JobKind.STORAGE_SCAN, { mode: "silent" });
  await ended(id);
  const retention = timers.find((t) => t.ms === 24 * 3600 * 1000);
  expect(retention).toBeDefined();
  expect(job(id).state).toBe(JobState.FAILED);
  retention!.fn();
  expect(store.get(jobKey(id))).toBeUndefined();
});
