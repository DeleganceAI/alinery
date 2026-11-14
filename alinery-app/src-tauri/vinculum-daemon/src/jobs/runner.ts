// Jobs (plan 2.3.5, S2.6): slow work runs in a child process of the daemon's own binary, so a crash
// in it fails only its job. The child reads its params from stdin and writes JSON lines on stdout:
// {progress:{done,total,label}}, {result:...} or {error:"..."}. Every state change is committed to
// the store as a `job/_/<id>` entity, so a client sees progress through Subscribe and, after the
// job, its result for `retainMs`.
import { create } from "@bufbuild/protobuf";
import { type Job, JobKind, JobSchema, JobState, EntitySchema } from "alinery-proto/alinery/v1/entities_pb";
import { signalChild, spawnDetached } from "../platform/process.ts";
import type { Store, Timers } from "../sync/store.ts";
import { jobCommand, resultOf } from "./kinds.ts";

export type RunnerOptions = {
  /** The argv for a kind. Defaults to this binary's `--job <kind>`; tests point it at a fake child. */
  command?: (kind: JobKind) => string[];
  /** Spacing of progress commits per job: about 4 a second (2.2.8). */
  progressMs?: number;
  /** How long an ended job stays in the store (24 h, WA) so a client that was closed sees its result. */
  retainMs?: number;
  timers?: Timers;
  now?: () => number;
  /** Told when a job reaches DONE, FAILED or CANCELLED, after its entity is committed. */
  onEnd?: (job: Job, params: unknown) => void;
};

const unref = <T>(t: T): T => {
  (t as { unref?: () => void }).unref?.();
  return t;
};
const realTimers: Timers = { set: (fn, ms) => unref(setTimeout(fn, ms)), clear: (h) => clearTimeout(h as Timer) };

const TERMINAL = new Set([JobState.DONE, JobState.FAILED, JobState.CANCELLED]);
const STDERR_TAIL = 2000;

export const jobKey = (id: string) => `job/_/${id}`;

type Entry = {
  job: Job;
  params: unknown;
  child?: Bun.Subprocess;
  cancelled: boolean;
  lastProgressAt: number;
  flush?: unknown;
  waiters: ((job: Job) => void)[];
};

export class JobRunner {
  private readonly entries = new Map<string, Entry>();
  // Per kind: whether one is running, and those waiting, in order.
  private readonly running = new Set<JobKind>();
  private readonly waiting = new Map<JobKind, Entry[]>();
  private readonly o: Required<RunnerOptions>;
  // Set by stopAll: nothing new starts, so a queued job cannot launch as a running one ends.
  private stopping = false;

  constructor(
    private readonly store: Store,
    o: RunnerOptions = {},
  ) {
    this.o = { command: jobCommand, progressMs: 250, retainMs: 24 * 3600 * 1000, timers: realTimers, now: Date.now, onEnd: () => {}, ...o };
  }

  /** Starts a job and returns its id. One job of a kind runs at a time and the rest wait in order; the
   * daemon serves one repo, so that is also "one backup per repo". */
  start(kind: JobKind, params: unknown): string {
    const id = crypto.randomUUID();
    const entry: Entry = { job: create(JobSchema, { id, kind, state: JobState.QUEUED }), params, cancelled: false, lastProgressAt: 0, waiters: [] };
    this.entries.set(id, entry);
    if (this.stopping) {
      entry.cancelled = true;
      this.end(entry, JobState.CANCELLED);
    } else if (this.running.has(kind)) {
      this.waiting.set(kind, [...(this.waiting.get(kind) ?? []), entry]);
      this.commit(entry);
    } else {
      this.launch(entry);
    }
    return id;
  }

  /** Whether a job of this kind is running or waiting: what keeps an automatic trigger from piling jobs up behind one. */
  busy(kind: JobKind): boolean {
    return this.running.has(kind) || (this.waiting.get(kind)?.length ?? 0) > 0;
  }

  /** Resolves with the job once it has ended (at once if it already has). An id this daemon doesn't know rejects. */
  finished(id: string): Promise<Job> {
    const entry = this.entries.get(id);
    if (!entry) return Promise.reject(new Error(`no job ${id}`));
    if (TERMINAL.has(entry.job.state)) return Promise.resolve(entry.job);
    return new Promise((resolve) => entry.waiters.push(resolve));
  }

  /** Cancels a job that has not ended: a waiting one at once, a running one by SIGTERM to its child
   * (it ends CANCELLED when the child has exited). Returns false for an id this daemon doesn't know. */
  cancel(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    if (TERMINAL.has(entry.job.state) || entry.cancelled) return true;
    entry.cancelled = true;
    if (entry.child) {
      signalChild(entry.child, "SIGTERM", "job-cancel");
    } else {
      const queue = this.waiting.get(entry.job.kind) ?? [];
      this.waiting.set(entry.job.kind, queue.filter((e) => e !== entry));
      this.end(entry, JobState.CANCELLED);
    }
    return true;
  }

  /** Shutdown (plan invariant 1): ends every job that has not ended, a waiting one at once and a running one
   * by SIGTERM to its child, and starts none after. A job child is in its own process group, so it would
   * otherwise outlive the daemon and go on deleting or reading `.alinery` while a restore rewrites it. */
  stopAll(): void {
    this.stopping = true;
    for (const [id, entry] of this.entries) if (!TERMINAL.has(entry.job.state)) this.cancel(id);
  }

  /** After stopAll: resolves once every job child has exited. A child still alive after `graceMs` (purge
   * finishes the item in hand first) gets SIGKILL and `killMs` more. */
  async drain(graceMs: number, killMs = 500): Promise<void> {
    const live = () => [...this.entries.values()].flatMap((e) => (e.child && e.child.exitCode === null && e.child.signalCode === null ? [e.child] : []));
    const within = (ms: number) => Promise.race([Promise.all(live().map((c) => c.exited)), Bun.sleep(ms)]);
    await within(graceMs);
    for (const child of live()) signalChild(child, "SIGKILL", "job-cancel");
    await within(killMs);
  }

  private commit(entry: Entry) {
    this.store.commit([create(EntitySchema, { key: jobKey(entry.job.id), value: { case: "job", value: entry.job } })]);
  }

  private end(entry: Entry, state: JobState, error = "") {
    if (entry.flush !== undefined) this.o.timers.clear(entry.flush);
    entry.flush = undefined;
    entry.job.state = state;
    entry.job.error = error;
    entry.job.endedAtMs = BigInt(this.o.now());
    this.commit(entry);
    for (const waiter of entry.waiters) waiter(entry.job);
    entry.waiters = [];
    this.o.onEnd(entry.job, entry.params);
    const id = entry.job.id;
    this.o.timers.set(() => {
      this.entries.delete(id);
      this.store.commit([], [jobKey(id)]);
    }, this.o.retainMs);
  }

  private launch(entry: Entry) {
    const { kind } = entry.job;
    this.running.add(kind);
    entry.job.state = JobState.RUNNING;
    entry.job.startedAtMs = BigInt(this.o.now());
    this.commit(entry);
    void this.run(entry).catch((e) => {
      if (!TERMINAL.has(entry.job.state)) this.end(entry, JobState.FAILED, (e as Error).message);
    }).finally(() => {
      this.running.delete(kind);
      const next = this.waiting.get(kind)?.shift();
      if (next) this.launch(next);
    });
  }

  private async run(entry: Entry) {
    const { kind } = entry.job;
    const child = spawnDetached(this.o.command(kind), { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: process.env });
    entry.child = child;
    child.stdin.write(JSON.stringify(entry.params ?? {}));
    child.stdin.end();
    const stderr = collectTail(child.stderr);
    await readLines(child.stdout, (line) => this.onLine(entry, line));
    const tail = await stderr;
    const code = await child.exited;
    if (TERMINAL.has(entry.job.state)) return; // a result or error line already ended it
    if (entry.cancelled) return this.end(entry, JobState.CANCELLED);
    const why = code === 0 ? "exited without a result" : `exit code ${code}`;
    this.end(entry, JobState.FAILED, tail ? `${why}: ${tail}` : why);
  }

  private onLine(entry: Entry, line: string) {
    if (entry.cancelled || TERMINAL.has(entry.job.state)) return;
    let msg: { progress?: { done?: number; total?: number; label?: string }; result?: unknown; error?: string };
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not a protocol line; stderr is for logs, but a stray print must not fail the job
    }
    if (msg.progress) this.progress(entry, msg.progress);
    else if (msg.result !== undefined) {
      try {
        entry.job.result = resultOf(entry.job.kind, msg.result);
      } catch (e) {
        return this.end(entry, JobState.FAILED, `unreadable result: ${(e as Error).message}`);
      }
      this.end(entry, JobState.DONE);
    } else if (msg.error !== undefined) this.end(entry, JobState.FAILED, String(msg.error));
  }

  // The latest value is always on the entity; it is committed at most once per `progressMs`, the
  // first at once and a held one when the window ends.
  private progress(entry: Entry, p: { done?: number; total?: number; label?: string }) {
    entry.job.progress = { $typeName: "alinery.v1.Progress", done: BigInt(Math.floor(p.done ?? 0)), total: BigInt(Math.floor(p.total ?? 0)), label: p.label ?? "" };
    const wait = entry.lastProgressAt + this.o.progressMs - this.o.now();
    if (wait <= 0) {
      entry.lastProgressAt = this.o.now();
      this.commit(entry);
    } else if (entry.flush === undefined) {
      entry.flush = this.o.timers.set(() => {
        entry.flush = undefined;
        entry.lastProgressAt = this.o.now();
        this.commit(entry);
      }, wait);
    }
  }
}

async function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void) {
  const decoder = new TextDecoder();
  let rest = "";
  for await (const chunk of stream) {
    rest += decoder.decode(chunk, { stream: true });
    let at: number;
    while ((at = rest.indexOf("\n")) >= 0) {
      const line = rest.slice(0, at).trim();
      rest = rest.slice(at + 1);
      if (line) onLine(line);
    }
  }
  if (rest.trim()) onLine(rest.trim());
}

async function collectTail(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) text = (text + decoder.decode(chunk, { stream: true })).slice(-STDERR_TAIL);
  return text.trim();
}
