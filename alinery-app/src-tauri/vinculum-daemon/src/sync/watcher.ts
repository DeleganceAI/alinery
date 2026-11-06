// The file watcher (plan S0.4 WA, 2.2.8): Bun `fs.watch`, one recursive watch on `.alinery/tasks`, one
// non-recursive on `.alinery/` for the three config files, and one on `.alinery/sessions` for taskless
// sessions when that directory exists. It trusts nothing in an event but the path: names that can't
// matter (`*.scrollback`, which every PTY byte appends to, and `.tmp.` files) are dropped before any
// I/O, the rest are debounced per path and handed on to be re-read. The 30 s reconcile covers misses.
import { type FSWatcher, existsSync, watch } from "node:fs";
import { basename, dirname, join } from "node:path";

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
    private readonly o: {
      debounceMs?: number;
      log?: (line: string) => void;
      /** The global `app.toml`, which sits outside `.alinery/`: its directory is watched and the file reported as `app.toml`. */
      appConfig?: string;
      /** The machine's playbook library, outside the repository (S4.6): reported as `global-playbooks/...`. */
      globalPlaybooks?: string;
    } = {},
  ) {}

  start() {
    this.add(join(this.alinery, "tasks"), true, (f) => `tasks/${f}`);
    this.add(this.alinery, false, (f) => (CONFIG_FILES.has(f) ? f : undefined));
    this.add(join(this.alinery, "sessions"), false, (f) => `sessions/${f}`);
    // The playbook library (S4.6): the repository's two directories and the machine's. The projector redoes the rows on any of them.
    this.add(join(this.alinery, "playbooks"), true, (f) => `playbooks/${f}`);
    this.add(join(dirname(this.alinery), "alinery", "playbooks"), true, (f) => `committed-playbooks/${f}`);
    if (this.o.globalPlaybooks) this.add(this.o.globalPlaybooks, true, (f) => `global-playbooks/${f}`);
    const app = this.o.appConfig;
    if (app) this.add(dirname(app), false, (f) => (f === basename(app) ? "app.toml" : undefined));
  }

  private add(abs: string, recursive: boolean, toRel: (filename: string) => string | undefined) {
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
