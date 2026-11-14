// The 30 s pass (plan 2.2.8): no watcher is trusted alone. The timer is re-armed when a pass ends, so
// passes never overlap. Timers come in through the constructor so tests drive the clock.
import type { Feed } from "./feed.ts";
import type { Timers } from "./store.ts";

export const RECONCILE_MS = 30_000;
const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as Timer) };

export class Reconciler {
  private handle: unknown;
  private stopped = true;
  /** Resolves when the pass in flight (or the last one) is done. */
  pass: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly feed: Feed,
    private readonly o: { everyMs?: number; timers?: Timers; log?: (line: string) => void } = {},
  ) {}

  start() {
    this.stopped = false;
    this.arm();
  }

  private arm() {
    const t = this.o.timers ?? realTimers;
    this.handle = t.set(() => {
      this.pass = this.feed
        .reconcile()
        .catch((e) => this.o.log?.(`reconcile failed: ${(e as Error).message}`))
        .finally(() => !this.stopped && this.arm());
    }, this.o.everyMs ?? RECONCILE_MS);
  }

  stop() {
    this.stopped = true;
    (this.o.timers ?? realTimers).clear(this.handle);
  }
}
