// The sync store (plan 2.2.2 to 2.2.5, 2.2.9): the daemon's rows, a ring of recent changes, and the
// subscribers that stream them. Rules the tests pin down:
//  - commit() is synchronous: seq assignment, ring append and fan-out happen with no await.
//  - A put equal to the stored row (ignoring revision) is not a change and takes no seq.
//  - open() registers the subscriber and takes its snapshot or replay in the same tick, so no commit
//    can fall between the two.
//  - A heartbeat carries the store's current seq, and only when this subscriber's queue is empty:
//    that moves a quiet scope's cursor past commits outside it, so the ring can roll over without
//    forcing that client to refetch.
//  - The store never waits on a subscriber: a full queue is dropped and ends in one MustRefetch.
import { clone, create, equals, toBinary } from "@bufbuild/protobuf";
import type { Cursor } from "alinery-proto/alinery/v1/common_pb";
import { type Entity, EntitySchema } from "alinery-proto/alinery/v1/entities_pb";
import { type Change, ChangeSchema, type Scope, type SubscribeResponse } from "alinery-proto/alinery/v1/sync_pb";

/** Timers come in through the constructor so tests drive them. */
export type Timers = { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as Timer) };

export type Options = {
  ringSize?: number; // changes kept for replay
  queueFrames?: number; // per subscriber
  queueBytes?: number; // per subscriber
  snapshotChunk?: number; // entities per Snapshot frame
  coalesceMs?: number;
  heartbeatMs?: number;
  timers?: Timers;
};
type Settings = Required<Options>;

// Keys are `<kind>/<task slug or _>/<id>` (2.2.6).
const REPO_KINDS = new Set(["task", "draft", "execution", "daemon", "job", "settings", "playbook"]);

/** The filter for a scope: true for the keys it includes. */
export function matcher(scope: Scope): (key: string) => boolean {
  const kind = scope.kind;
  switch (kind.case) {
    case "repo":
      return (key) => REPO_KINDS.has(key.slice(0, key.indexOf("/")));
    case "task": {
      const slug = kind.value.slug;
      return (key) => key.split("/", 3)[1] === slug;
    }
    case "session": {
      const ref = kind.value.session;
      return (key) => {
        const [k, slug, ...rest] = key.split("/");
        return k === "session" && slug === (ref?.taskSlug || "_") && rest.join("/") === ref?.id;
      };
    }
    case "chat":
      return (key) => {
        const [k, slug] = key.split("/", 2);
        return k === "chat" || (k === "session" && slug === "_");
      };
    default:
      return () => false;
  }
}

const keyOf = (c: Change) => (c.op.case === "put" ? c.op.value.key : (c.op.value as string));

// A change's size is worked out once, however many subscribers queue it.
const sizes = new WeakMap<Change, number>();
const sizeOf = (c: Change) => {
  let n = sizes.get(c);
  if (n === undefined) sizes.set(c, (n = toBinary(ChangeSchema, c).length));
  return n;
};

const frame = (f: SubscribeResponse["frame"]) => ({ $typeName: "alinery.v1.SubscribeResponse" as const, frame: f });
const deltaFrame = (changes: Change[], cursor: Cursor) => frame({ case: "delta", value: { $typeName: "alinery.v1.Delta", changes, cursor } });
const heartbeatFrame = (cursor: Cursor) => frame({ case: "heartbeat", value: { $typeName: "alinery.v1.Heartbeat", cursor } });
const mustRefetchFrame = (reason: string) => frame({ case: "mustRefetch", value: { $typeName: "alinery.v1.MustRefetch", reason } });

type Commit = { seq: bigint; changes: Change[] };

/** One stream's bounded queue of commits and the loop that turns it into frames. */
export class Subscriber {
  private queue: Commit[] = [];
  private bytes = 0;
  private overflow = false;
  private wake: (() => void) | null = null;

  constructor(
    readonly matches: (key: string) => boolean,
    private readonly o: Settings,
    private readonly cursor: () => Cursor,
  ) {}

  /** Called by the store on every commit; never waits. */
  offer(seq: bigint, changes: Change[]) {
    if (this.overflow) return;
    const mine = changes.filter((c) => this.matches(keyOf(c)));
    if (!mine.length) return;
    this.queue.push({ seq, changes: mine });
    for (const c of mine) this.bytes += sizeOf(c);
    if (this.queue.length > this.o.queueFrames || this.bytes > this.o.queueBytes) {
      this.overflow = true;
      this.queue = [];
      this.bytes = 0;
    }
    this.wake?.();
  }

  /** Resolves on a wake (if `wakeable`), the timer, or the abort, and leaves no listener or timer behind. */
  private wait(signal: AbortSignal, ms: number, wakeable: boolean): Promise<"wake" | "timer" | "abort"> {
    if (signal.aborted) return Promise.resolve("abort");
    return new Promise((resolve) => {
      const done = (why: "wake" | "timer" | "abort") => {
        this.wake = null;
        this.o.timers.clear(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(why);
      };
      const onAbort = () => done("abort");
      const timer = this.o.timers.set(() => done("timer"), ms);
      this.wake = wakeable ? () => done("wake") : null;
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Live frames: deltas coalesced over `coalesceMs`, a heartbeat after `heartbeatMs` of nothing
   * queued, or one MustRefetch and the end of the stream. Wakes on `signal` (rule of 2.1.7). */
  async *frames(signal: AbortSignal): AsyncGenerator<SubscribeResponse> {
    while (!signal.aborted) {
      if (this.overflow) {
        yield mustRefetchFrame("subscriber queue overflow");
        return;
      }
      if (!this.queue.length) {
        const why = await this.wait(signal, this.o.heartbeatMs, true);
        if (why === "abort") return;
        if (why === "timer" && !this.queue.length && !this.overflow) yield heartbeatFrame(this.cursor());
        continue;
      }
      if (this.o.coalesceMs && (await this.wait(signal, this.o.coalesceMs, false)) === "abort") return;
      if (this.overflow) continue;
      // Every commit up to the store's seq that matches is queued, so the store's cursor is right.
      const batch = this.queue.flatMap((c) => c.changes);
      this.queue = [];
      this.bytes = 0;
      yield deltaFrame(batch, this.cursor());
    }
  }
}

export class Store {
  readonly epoch = crypto.randomUUID();
  seq = 0n;
  private readonly rows = new Map<string, Entity>();
  private ring: Commit[] = [];
  private ringChanges = 0;
  private readonly subs = new Set<Subscriber>();
  private readonly o: Settings;

  constructor(o: Options = {}) {
    this.o = { ringSize: 10_000, queueFrames: 1_000, queueBytes: 4 * 1024 * 1024, snapshotChunk: 500, coalesceMs: 16, heartbeatMs: 15_000, timers: realTimers, ...o };
  }

  get(key: string): Entity | undefined {
    return this.rows.get(key);
  }

  get size() {
    return this.rows.size;
  }

  get subscribers() {
    return this.subs.size;
  }

  cursor(seq = this.seq): Cursor {
    return { $typeName: "alinery.v1.Cursor", epoch: this.epoch, seq };
  }

  *rowsMatching(scope: Scope): IterableIterator<Entity> {
    const matches = matcher(scope);
    for (const e of this.rows.values()) if (matches(e.key)) yield e;
  }

  /** Synchronous on the event loop: no await between assigning seq and fanning out. */
  commit(puts: Entity[], deletes: string[] = []): bigint {
    const changes: Change[] = [];
    const seen = new Set<string>();
    for (const e of puts) {
      const prev = this.rows.get(e.key);
      if (prev && equals(EntitySchema, { ...prev, revision: 0n }, { ...e, revision: 0n })) continue;
      // A copy: the caller keeps its object, and a stored row never changes under a subscriber.
      changes.push(create(ChangeSchema, { op: { case: "put", value: clone(EntitySchema, e) } }));
      seen.add(e.key);
    }
    for (const key of deletes) if (this.rows.has(key) && !seen.has(key)) changes.push(create(ChangeSchema, { op: { case: "delete", value: key } }));
    if (!changes.length) return this.seq; // nothing changed: no seq taken, nothing sent
    const seq = ++this.seq;
    for (const c of changes) {
      if (c.op.case === "put") {
        c.op.value.revision = seq;
        this.rows.set(c.op.value.key, c.op.value);
      } else {
        this.rows.delete(c.op.value);
      }
    }
    this.ring.push({ seq, changes });
    this.ringChanges += changes.length;
    // Whole commits only, so a cursor never lands inside one.
    let drop = 0;
    while (drop < this.ring.length && this.ringChanges > this.o.ringSize) this.ringChanges -= this.ring[drop++].changes.length;
    if (drop) this.ring.splice(0, drop);
    for (const sub of this.subs) sub.offer(seq, changes);
    return seq;
  }

  /** The commits after `seq`, or undefined when the ring can't vouch for them (another epoch's
   * seq, a seq from the future, or one older than the ring). */
  private since(seq: bigint): Commit[] | undefined {
    if (seq > this.seq) return undefined;
    if (seq === this.seq) return [];
    const first = this.ring[0];
    if (!first || seq < first.seq - 1n) return undefined;
    return this.ring.filter((c) => c.seq > seq);
  }

  // Its own generator so the copied rows are released once the snapshot is out, not held by a
  // stream that may live for hours.
  private *snapshot(scope: Scope, at: Cursor): Generator<SubscribeResponse> {
    const rows = [...this.rowsMatching(scope)]; // copied now; later commits reach the queue
    for (let i = 0; i === 0 || i < rows.length; i += this.o.snapshotChunk) {
      yield frame({
        case: "snapshot",
        value: { $typeName: "alinery.v1.Snapshot", entities: rows.slice(i, i + this.o.snapshotChunk), cursor: at, complete: i + this.o.snapshotChunk >= rows.length },
      });
    }
  }

  async *open(scope: Scope, cursor: Cursor | undefined, signal: AbortSignal): AsyncGenerator<SubscribeResponse> {
    const sub = new Subscriber(matcher(scope), this.o, () => this.cursor());
    this.subs.add(sub); // same tick as the read below: no commit can fall between them
    try {
      const replay = cursor?.epoch === this.epoch ? this.since(cursor.seq) : undefined;
      const at = this.cursor();
      if (replay) {
        const mine = replay.flatMap((c) => c.changes.filter((ch) => sub.matches(keyOf(ch))));
        if (mine.length) yield deltaFrame(mine, at);
        yield frame({ case: "upToDate", value: { $typeName: "alinery.v1.UpToDate", cursor: at } });
      } else {
        yield* this.snapshot(scope, at);
      }
      yield* sub.frames(signal);
    } finally {
      this.subs.delete(sub);
    }
  }
}
