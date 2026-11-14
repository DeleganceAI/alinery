// Files to store rows (plan 2.2.8, feed 2). `refresh(rel)` re-reads one path through its parser and
// commits the result: a put (the store drops it when nothing changed) or a delete. It trusts no
// event's kind: the answer is whatever the file is now. `scan()` runs every path through the same
// parsers at start, and `reconcile()` is the 30 s pass that covers missed events.
import type { Entity } from "alinery-proto/alinery/v1/entities_pb";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { parsers, route } from "./parsers/index.ts";
import type { Store } from "./store.ts";

const BATCH = 256; // stats or reads in flight at once; a synchronous pass would block the loop (2.2.8)

const MISSING = -1; // a `present` path whose file does not exist
type Tracked = { key: string; mtimeMs: number; size: number };

export class Feed {
  readonly tracked = new Map<string, Tracked>(); // by path relative to `.alinery/`
  /** Told of every path a `refresh` re-read, matched by a parser or not: rows that derive from a whole directory (S4.5). */
  onChanged?: (rel: string) => void;
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    readonly store: Store,
    readonly alinery: string,
    /** Applied to each entity before it is committed: the live state a file cannot hold (S2.5). */
    private readonly decorate: (entity: Entity) => Entity = (e) => e,
    /** The paths to re-read after a path changed: rows derived from more than their own file (S3.5). Applied once, never to a path it caused. */
    private readonly dependents: (rel: string) => string[] = () => [],
    /** Paths that live outside `.alinery/`, by the name the feed knows them as (`app.toml`, S4.1). */
    private readonly outside: Record<string, string> = {},
  ) {}

  private abs(rel: string): string {
    return this.outside[rel] ?? join(this.alinery, rel);
  }

  /** The path re-read, then the paths derived from it. */
  async refresh(rel: string): Promise<void> {
    await this.reread(rel);
    for (const d of this.dependents(rel)) await this.reread(d).catch(() => {});
    this.onChanged?.(rel);
  }

  /** One read at a time per row, so a slow read can't land after a newer one (several paths may feed one row). */
  private reread(rel: string): Promise<void> {
    const r = route(rel);
    if (!r) return Promise.resolve();
    const run = (this.chains.get(r.key) ?? Promise.resolve()).then(() => this.read(rel));
    const tail = run.catch(() => {});
    this.chains.set(r.key, tail);
    void tail.then(() => this.chains.get(r.key) === tail && this.chains.delete(r.key));
    return run;
  }

  private async read(rel: string): Promise<void> {
    const r = route(rel);
    if (!r) return;
    const abs = this.abs(rel);
    // Stat first: a write that lands during the read changes mtime or size, so the next pass re-reads.
    const s = await stat(abs).catch(() => undefined);
    const present = r.parser.present?.includes(rel) ?? false;
    if (!s?.isFile() && !present) {
      this.tracked.delete(rel);
      this.store.commit([], [r.key]);
      return;
    }
    const entity = await r.parser.parse(abs, r.m);
    this.tracked.set(rel, { key: r.key, mtimeMs: s?.isFile() ? s.mtimeMs : MISSING, size: s?.isFile() ? s.size : MISSING });
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
    out.push(...parsers.flatMap((p) => p.present ?? []).filter((rel) => !out.includes(rel)));
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
          const s = await stat(this.abs(rel)).catch(() => undefined);
          const file = s?.isFile() ? s : undefined;
          if ((file?.mtimeMs ?? MISSING) !== t.mtimeMs || (file?.size ?? MISSING) !== t.size) stale.push(rel);
        }),
      );
    }
    await this.refreshAll(stale);
    return stale.length;
  }
}
