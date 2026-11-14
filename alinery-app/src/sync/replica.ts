// Client replica of one daemon scope (plan 2.2.10). `apply` is the tested core of the spike's
// `Replica`; `runReplica` adds the resubscribe loop. No persistence on desktop.
import type { Cursor } from "alinery-proto/alinery/v1/common_pb";
import type { Entity } from "alinery-proto/alinery/v1/entities_pb";
import type { SubscribeResponse } from "alinery-proto/alinery/v1/sync_pb";

export class Replica {
  cursor: Cursor | undefined;
  /** A frame arrived on the current stream. The run loop owns it; `useDaemonStatus` reports it as `reachable`. */
  reachable = false;
  /** The link dropped after the replica had data: rows are the last known state, read-only. */
  stale = false;
  /** A complete snapshot has been swapped in at least once. */
  ready = false;
  private rows = new Map<string, Entity>();
  private building: Map<string, Entity> | null = null;
  private listeners = new Set<() => void>();
  private version = 0;
  private cached: { version: number; all: Entity[] } = { version: -1, all: [] };

  apply(r: SubscribeResponse): "ok" | "refetch" {
    const f = r.frame;
    switch (f.case) {
      case "snapshot":
        this.building ??= new Map();
        for (const e of f.value.entities) this.building.set(e.key, e);
        if (f.value.complete) {
          this.rows = this.building;
          this.building = null;
          this.cursor = f.value.cursor;
          this.ready = true;
          this.changed();
        }
        return "ok";
      case "delta":
        for (const c of f.value.changes) {
          if (c.op.case === "put") this.rows.set(c.op.value.key, c.op.value);
          else if (c.op.case === "delete") this.rows.delete(c.op.value);
        }
        this.cursor = f.value.cursor;
        this.changed();
        return "ok";
      case "upToDate":
      case "heartbeat":
        this.cursor = f.value.cursor;
        return "ok";
      case "mustRefetch":
        this.cursor = undefined;
        this.building = null;
        return "refetch";
      default:
        return "ok";
    }
  }

  /** Link state from the run loop. A change wakes listeners; rows are untouched. */
  setLink(up: boolean) {
    const stale = !up && this.ready;
    if (this.reachable === up && this.stale === stale) return;
    this.reachable = up;
    this.stale = stale;
    if (!up) this.building = null; // a half-received snapshot is worthless on a new stream
    this.changed();
  }

  get = (key: string) => this.rows.get(key);
  /** Every row, as one array per version: `useSyncExternalStore` needs a stable snapshot. */
  all = (): Entity[] => {
    if (this.cached.version !== this.version) this.cached = { version: this.version, all: [...this.rows.values()] };
    return this.cached.all;
  };
  listen = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  private changed() {
    this.version += 1;
    for (const fn of [...this.listeners]) fn();
  }
}

export type Subscribe = (cursor: Cursor | undefined, signal: AbortSignal) => AsyncIterable<SubscribeResponse>;

export const BACKOFF_MS = [500, 1000, 2000, 5000];

/** Keeps `replica` fed until the returned stop() is called: resubscribes with the last cursor, backing off 0.5, 1, 2, 5 s while the stream fails. */
export function runReplica(replica: Replica, subscribe: Subscribe, sleep: (ms: number, signal: AbortSignal) => Promise<void> = abortableSleep): () => void {
  const ctrl = new AbortController();
  const { signal } = ctrl;
  void (async () => {
    let failures = 0;
    while (!signal.aborted) {
      let refetch = false;
      try {
        for await (const frame of subscribe(replica.cursor, signal)) {
          if (signal.aborted) return;
          failures = 0;
          replica.setLink(true);
          if (replica.apply(frame) === "refetch") {
            refetch = true;
            break;
          }
          if (signal.aborted) return; // a listener let go of the scope while this frame applied; return closes the call
        }
      } catch {
        // falls through to the backoff below
      }
      if (signal.aborted) return;
      replica.setLink(false);
      if (refetch) continue; // the cursor is gone; resubscribe for a snapshot at once
      await sleep(BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)], signal);
      failures += 1;
    }
  })();
  return () => ctrl.abort();
}

function abortableSleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });
}
