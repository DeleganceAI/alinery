// Shared by the sync tests: entity builders, a manual clock, and the client half that applies frames.
import { create, equals } from "@bufbuild/protobuf";
import type { Cursor } from "alinery-proto/alinery/v1/common_pb";
import { type Entity, EntitySchema } from "alinery-proto/alinery/v1/entities_pb";
import { ScopeSchema, type SubscribeResponse } from "alinery-proto/alinery/v1/sync_pb";
import { expect } from "bun:test";
import type { Store, Timers } from "./store.ts";

export const task = (slug: string, title = "", id = slug): Entity =>
  create(EntitySchema, { key: `task/${slug}/${id}`, value: { case: "task", value: { slug, title } } });
export const session = (slug: string, id: string, status: string): Entity =>
  create(EntitySchema, { key: `session/${slug || "_"}/${id}`, value: { case: "session", value: { ref: { taskSlug: slug, id }, status } } });

export const repoScope = create(ScopeSchema, { kind: { case: "repo", value: {} } });
export const taskScope = (slug: string) => create(ScopeSchema, { kind: { case: "task", value: { slug } } });

/** A clock the test turns by hand. */
export class FakeTimers implements Timers {
  private now = 0;
  private next = 1;
  private pending = new Map<number, { at: number; fn: () => void }>();
  set(fn: () => void, ms: number) {
    const id = this.next++;
    this.pending.set(id, { at: this.now + ms, fn });
    return id;
  }
  clear(handle: unknown) {
    this.pending.delete(handle as number);
  }
  get count() {
    return this.pending.size;
  }
  /** Moves the clock and fires what comes due, in time order. */
  tick(ms: number) {
    const end = this.now + ms;
    for (;;) {
      const due = [...this.pending.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.pending.delete(due[0]);
      this.now = due[1].at;
      due[1].fn();
    }
    this.now = end;
  }
}

/** Let queued promise callbacks and the generators waiting on them run. */
export const flush = () => Bun.sleep(0);

/** What the webview's replica does with frames (2.2.4); S3.1 builds the real one. */
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
        if (f.value.complete) {
          this.rows = this.building;
          this.building = null;
          this.cursor = f.value.cursor;
        }
        return "ok";
      case "delta":
        for (const c of f.value.changes) c.op.case === "put" ? this.rows.set(c.op.value.key, c.op.value) : this.rows.delete(c.op.value as string);
        this.cursor = f.value.cursor;
        return "ok";
      case "upToDate":
      case "heartbeat":
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

export function same(a: Map<string, Entity>, b: Map<string, Entity>) {
  expect([...a.keys()].sort()).toEqual([...b.keys()].sort());
  for (const [k, v] of a) expect(equals(EntitySchema, v, b.get(k)!)).toBe(true);
}

export const expected = (store: Store, scope = repoScope) => new Map([...store.rowsMatching(scope)].map((e) => [e.key, e]));
