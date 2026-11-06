// Files to store rows (plan 2.2.8, feed 2). `refresh(rel)` re-reads one path through its parser and
// commits the result: a put (the store drops it when nothing changed) or a delete. It trusts no
// event's kind: the answer is whatever the file is now. `scan()` runs every path through the same
// parsers at start, and `reconcile()` is the 30 s pass that covers missed events.
import type { Entity } from "alinery-proto/alinery/v1/entities_pb";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { route } from "./parsers/index.ts";
import type { Store } from "./store.ts";

const BATCH = 256; // stats or reads in flight at once; a synchronous pass would block the loop (2.2.8)

type Tracked = { key: string; mtimeMs: number; size: number };

export class Feed {
  readonly tracked = new Map<string, Tracked>(); // by path relative to `.alinery/`
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    readonly store: Store,
    readonly alinery: string,
    /** Applied to each entity before it is committed: the live state a file cannot hold (S2.5). */
    private readonly decorate: (entity: Entity) => Entity = (e) => e,
    /** The paths to re-read after a path changed: rows derived from more than their own file (S3.5). Applied once, never to a path it caused. */
    private readonly dependents: (rel: string) => string[] = () => [],
  ) {}

  /** The path re-read, then the paths derived from it. */
  async refresh(rel: string): Promise<void> {
    await this.reread(rel);
    for (const d of this.dependents(rel)) await this.reread(d).catch(() => {});
  }

  /** One path at a time per file, so a slow read can't land after a newer one. */
  private reread(rel: string): Promise<void> {
    if (!route(rel)) return Promise.resolve();
    const run = (this.chains.get(rel) ?? Promise.resolve()).then(() => this.read(rel));
    const tail = run.catch(() => {});
    this.chains.set(rel, tail);
    void tail.then(() => this.chains.get(rel) === tail && this.chains.delete(rel));
    return run;
  }

  private async read(rel: string): Promise<void> {
    const r = route(rel);
    if (!r) return;
    const abs = join(this.alinery, rel);
    // Stat first: a write that lands during the read changes mtime or size, so the next pass re-reads.
    const s = await stat(abs).catch(() => undefined);
    if (!s?.isFile()) {
      this.tracked.delete(rel);
      this.store.commit([], [r.key]);
      return;
    }
    const entity = await r.parser.parse(abs, r.m);
    this.tracked.set(rel, { key: r.key, mtimeMs: s.mtimeMs, size: s.size });
    if (entity) this.store.commit([this.decorate(entity)]);
    else this.store.commit([], [r.key]);
  }

  /** Every path a parser could own, found by listing the directories they live in. */
  private async candidates(): Promise<string[]> {
    const out: string[] = [];
    const list = async (dir: string) => {
      for (const name of await readdir(join(this.alinery, dir)).catch(() => [] as string[])) {
        const rel = dir ? `${dir}/${name}` : name;
        if (route(rel)) out.push(rel);
      }
    };
    await list("");
    await list("sessions");
    const slugs = await readdir(join(this.alinery, "tasks")).catch(() => [] as string[]);
    for (let i = 0; i < slugs.length; i += BATCH) {
      await Promise.all(slugs.slice(i, i + BATCH).flatMap((s) => [list(`tasks/${s}`), list(`tasks/${s}/sessions`), list(`tasks/${s}/artifacts`)]));
    }
    return out;
  }

  /** Every path once, then each path derived from them once: a scan of 10,000 artifacts re-reads each task one time, not ten. */
  private async refreshAll(rels: string[]) {
    for (let i = 0; i < rels.length; i += BATCH) await Promise.all(rels.slice(i, i + BATCH).map((r) => this.reread(r)));
    const derived = [...new Set(rels.flatMap((r) => this.dependents(r)))];
    for (let i = 0; i < derived.length; i += BATCH) await Promise.all(derived.slice(i, i + BATCH).map((r) => this.reread(r)));
  }

  /** Start-up: every file through its parser. */
  async scan(): Promise<void> {
    await this.refreshAll(await this.candidates());
  }

  /** New files, changed files (mtime or size) and vanished files; returns how many it re-read. */
  async reconcile(): Promise<number> {
    const stale = (await this.candidates()).filter((rel) => !this.tracked.has(rel));
    const entries = [...this.tracked.entries()];
    for (let i = 0; i < entries.length; i += BATCH) {
      await Promise.all(
        entries.slice(i, i + BATCH).map(async ([rel, t]) => {
          const s = await stat(join(this.alinery, rel)).catch(() => undefined);
          if (!s || s.mtimeMs !== t.mtimeMs || s.size !== t.size) stale.push(rel);
        }),
      );
    }
    await this.refreshAll(stale);
    return stale.length;
  }
}
