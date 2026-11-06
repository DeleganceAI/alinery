// S2.1 sample: the sync store from 2.2.2-2.2.5, small enough to read in one sitting.
// Rules the tests pin down:
//  - commit() is synchronous: seq assignment, ring append and fan-out happen with no await.
//  - A put equal to the stored row (ignoring revision) is not a change and takes no seq.
//  - open() registers the subscriber and takes its snapshot in the same tick, so no commit can
//    fall between the two.
//  - A heartbeat carries the store's current seq, and only when this subscriber's queue is empty:
//    that is what moves a quiet scope's cursor past commits outside it, so the ring can roll over
//    without forcing that client to refetch.
import { create, equals } from "@bufbuild/protobuf";
import { type Change, ChangeSchema, type Scope, type SubscribeResponse, SubscribeResponseSchema } from "../gen/alinery/v1/sync_pb";
import { type Entity, EntitySchema } from "../gen/alinery/v1/entities_pb";
import type { Cursor } from "../gen/alinery/v1/common_pb";

export type Options = { ringSize?: number; queueLimit?: number; snapshotChunk?: number; coalesceMs?: number; heartbeatMs?: number };

class Subscriber {
  queue: { seq: bigint; change: Change }[] = [];
  overflow = false;
  wake: (() => void) | null = null;
  constructor(readonly scope: Scope, private limit: number) {}
  offer(seq: bigint, changes: Change[]) {
    for (const change of changes) if (inScope(this.scope, keyOf(change))) this.queue.push({ seq, change });
    if (this.queue.length > this.limit) { this.overflow = true; this.queue = []; }
    this.wake?.();
  }
}

const keyOf = (c: Change) => (c.op.case === "put" ? c.op.value.key : (c.op.value as string));

// Keys are `<kind>/<slug or _>/<id>` (2.2.6).
export function inScope(scope: Scope, key: string): boolean {
  const [kind, slug, ...rest] = key.split("/");
  switch (scope.kind.case) {
    case "repo": return ["task", "draft", "execution", "daemon", "job", "settings", "playbook"].includes(kind);
    case "task": return slug === scope.kind.value.slug;
    case "session": { const r = scope.kind.value.session; return kind === "session" && slug === r?.taskSlug && rest.join("/") === r?.id; }
    case "chat": return kind === "chat" || (kind === "session" && slug === "_");
    default: return false;
  }
}

const frame = (f: SubscribeResponse["frame"]) => create(SubscribeResponseSchema, { frame: f });

export class Store {
  readonly epoch = crypto.randomUUID();
  seq = 0n;
  readonly rows = new Map<string, Entity>();
  private ring: { seq: bigint; change: Change }[] = [];
  private subs = new Set<Subscriber>();
  private o: Required<Options>;
  constructor(o: Options = {}) {
    this.o = { ringSize: 10_000, queueLimit: 1_000, snapshotChunk: 500, coalesceMs: 16, heartbeatMs: 15_000, ...o };
  }

  commit(puts: Entity[], deletes: string[] = []): bigint {
    const changes: Change[] = [];
    for (const e of puts) {
      const prev = this.rows.get(e.key);
      if (prev && equals(EntitySchema, { ...prev, revision: 0n }, { ...e, revision: 0n })) continue;
      changes.push(create(ChangeSchema, { op: { case: "put", value: e } }));
    }
    for (const key of deletes) if (this.rows.has(key)) changes.push(create(ChangeSchema, { op: { case: "delete", value: key } }));
    if (!changes.length) return this.seq;
    const seq = ++this.seq;
    for (const c of changes) {
      if (c.op.case === "put") { c.op.value.revision = seq; this.rows.set(c.op.value.key, c.op.value); }
      else this.rows.delete(c.op.value as string);
      this.ring.push({ seq, change: c });
    }
    if (this.ring.length > this.o.ringSize) this.ring.splice(0, this.ring.length - this.o.ringSize);
    for (const s of this.subs) s.offer(seq, changes);
    return seq;
  }

  cursor(seq = this.seq): Cursor { return { $typeName: "alinery.v1.Cursor", epoch: this.epoch, seq }; }

  async *open(scope: Scope, cursor: Cursor | undefined, signal: AbortSignal): AsyncGenerator<SubscribeResponse> {
    const sub = new Subscriber(scope, this.o.queueLimit);
    this.subs.add(sub);
    try {
      // Same tick as subs.add: decide replay vs snapshot and copy what to send.
      const oldest = this.ring[0]?.seq ?? this.seq + 1n;
      const replay = cursor && cursor.epoch === this.epoch && cursor.seq >= oldest - 1n && cursor.seq <= this.seq;
      const at = this.seq;
      if (replay) {
        const changes = this.ring.filter((r) => r.seq > cursor.seq && inScope(scope, keyOf(r.change))).map((r) => r.change);
        if (changes.length) yield frame({ case: "delta", value: { $typeName: "alinery.v1.Delta", changes, cursor: this.cursor(at) } });
        yield frame({ case: "upToDate", value: { $typeName: "alinery.v1.UpToDate", cursor: this.cursor(at) } });
      } else {
        if (cursor) yield frame({ case: "mustRefetch", value: { $typeName: "alinery.v1.MustRefetch", reason: "cursor not in ring" } });
        const all = [...this.rows.values()].filter((e) => inScope(scope, e.key));
        for (let i = 0; i === 0 || i < all.length; i += this.o.snapshotChunk)
          yield frame({ case: "snapshot", value: { $typeName: "alinery.v1.Snapshot", entities: all.slice(i, i + this.o.snapshotChunk), cursor: this.cursor(at), complete: i + this.o.snapshotChunk >= all.length } });
      }
      while (!signal.aborted) {
        if (!sub.queue.length && !sub.overflow) {
          let timer: Timer | undefined;
          await new Promise<void>((r) => { sub.wake = r; timer = setTimeout(r, this.o.heartbeatMs); signal.addEventListener("abort", () => r(), { once: true }); });
          clearTimeout(timer);
          sub.wake = null;
          if (!sub.queue.length && !sub.overflow) {
            if (!signal.aborted) yield frame({ case: "heartbeat", value: { $typeName: "alinery.v1.Heartbeat", cursor: this.cursor() } });
            continue;
          }
          if (this.o.coalesceMs) await Bun.sleep(this.o.coalesceMs);
        }
        if (sub.overflow) { yield frame({ case: "mustRefetch", value: { $typeName: "alinery.v1.MustRefetch", reason: "subscriber queue overflow" } }); return; }
        if (!sub.queue.length) continue;
        const batch = sub.queue.splice(0);
        yield frame({ case: "delta", value: { $typeName: "alinery.v1.Delta", changes: batch.map((b) => b.change), cursor: this.cursor(batch.at(-1)!.seq) } });
      }
    } finally {
      this.subs.delete(sub);
    }
  }
}

// The client half: what the webview's replica does with frames (2.2.4).
export class Replica {
  rows = new Map<string, Entity>();
  cursor: Cursor | undefined;
  private building: Map<string, Entity> | null = null;
  apply(r: SubscribeResponse): "ok" | "refetch" {
    const f = r.frame;
    switch (f.case) {
      case "snapshot":
        this.building ??= new Map();
        for (const e of f.value.entities) this.building.set(e.key, e);
        if (f.value.complete) { this.rows = this.building; this.building = null; this.cursor = f.value.cursor; }
        return "ok";
      case "delta":
        for (const c of f.value.changes) c.op.case === "put" ? this.rows.set(c.op.value.key, c.op.value) : this.rows.delete(c.op.value as string);
        this.cursor = f.value.cursor;
        return "ok";
      case "upToDate": case "heartbeat":
        this.cursor = f.value.cursor;
        return "ok";
      case "mustRefetch":
        this.cursor = undefined;
        return "refetch";
      default:
        return "ok";
    }
  }
}
