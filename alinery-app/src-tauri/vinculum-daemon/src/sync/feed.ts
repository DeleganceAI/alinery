// Files to store rows (plan 2.2.8, feed 2). `refresh(rel)` re-reads one path through its parser and
// commits the result: a put (the store drops it when nothing changed) or a delete. It trusts no
// event's kind: the answer is whatever the file is now. `scan()` runs every path through the same
// parsers at start, and `reconcile()` is the 30 s pass that covers missed events.
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
  ) {}

  /** One path at a time per file, so a slow read can't land after a newer one. */
  refresh(rel: string): Promise<void> {
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
    if (entity) this.store.commit([entity]);
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

  private async refreshAll(rels: string[]) {
    for (let i = 0; i < rels.length; i += BATCH) await Promise.all(rels.slice(i, i + BATCH).map((r) => this.refresh(r)));
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
