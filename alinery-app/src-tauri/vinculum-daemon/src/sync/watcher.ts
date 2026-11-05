// The file watcher (plan S0.4 WA, 2.2.8): Bun `fs.watch`, one recursive watch on `.alinery/tasks`, one
// non-recursive on `.alinery/` for the three config files, and one on `.alinery/sessions` for taskless
// sessions when that directory exists. It trusts nothing in an event but the path: names that can't
// matter (`*.scrollback`, which every PTY byte appends to, and `.tmp.` files) are dropped before any
// I/O, the rest are debounced per path and handed on to be re-read. The 30 s reconcile covers misses.
import { type FSWatcher, existsSync, watch } from "node:fs";
import { join } from "node:path";

export const CONFIG_FILES = new Set(["config.toml", "harnesses.toml", "playbooks.toml"]);

export type WatcherStatus = { watching: number; events: number; enospc: boolean };

export function ignoredName(rel: string): boolean {
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  return name.endsWith(".scrollback") || name.includes(".tmp.");
}

export class Watcher {
  private readonly watchers: FSWatcher[] = [];
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly status: WatcherStatus = { watching: 0, events: 0, enospc: false };

  constructor(
    private readonly alinery: string,
    private readonly onPath: (rel: string) => void,
    private readonly o: { debounceMs?: number; log?: (line: string) => void } = {},
  ) {}

  start() {
    this.add("tasks", true, (f) => `tasks/${f}`);
    this.add("", false, (f) => (CONFIG_FILES.has(f) ? f : undefined));
    this.add("sessions", false, (f) => `sessions/${f}`);
  }

  private add(dir: string, recursive: boolean, toRel: (filename: string) => string | undefined) {
    const abs = join(this.alinery, dir);
    if (!existsSync(abs)) return; // the reconcile pass finds what appears later
    try {
      const w = watch(abs, { recursive }, (_event, filename) => {
        if (!filename) return;
        const rel = toRel(String(filename).replaceAll("\\", "/"));
        if (!rel || ignoredName(rel)) return;
        this.status.events++;
        this.debounce(rel);
      });
      w.on("error", (e) => this.failed(abs, e));
      this.watchers.push(w);
      this.status.watching++;
    } catch (e) {
      this.failed(abs, e);
    }
  }

  // ENOSPC is inotify's watch limit. The store stays right through the reconcile pass; the status is
  // what `daemon/_/status` reports (S2.5).
  private failed(dir: string, e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOSPC") this.status.enospc = true;
    this.o.log?.(`watcher: cannot watch ${dir}: ${(e as Error)?.message ?? e}`);
  }

  private debounce(rel: string) {
    clearTimeout(this.timers.get(rel));
    this.timers.set(
      rel,
      setTimeout(() => {
        this.timers.delete(rel);
        this.onPath(rel);
      }, this.o.debounceMs ?? 50),
    );
  }

  stop() {
    for (const w of this.watchers.splice(0)) w.close();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.status.watching = 0;
  }
}
