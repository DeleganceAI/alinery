// The automatic backup triggers (S4.9), ported from the shell's `backup_queue.rs` and `publish_auto_backup`: archive, push and
// an artifact change must stay instant, so they publish here and return; a burst costs one backup, taken from the burst's end.
//
// Two slots, ever: the backup in flight (the job runner's) and the latest request waiting. Every publish replaces the waiting
// request and pushes its deadline out by `debounceMs` (2 s), so N artifact saves in a row are one archive, not N. A request
// whose deadline has passed while a backup is still running waits another window rather than queueing a second one behind it.
// The gate is the one a manual backup uses, with the trigger's own flag on top (`shouldPublish`), asked twice: when the trigger
// is published, so an unconfigured feature costs nothing, and when the deadline passes, because the person may have changed the
// destination or turned the feature off during the window.
import { type BackupSettings, type BackupTrigger, backupSettings, featureReady, shouldPublish } from "../domain/backup.ts";
import type { Timers } from "../sync/store.ts";

export const BACKUP_DEBOUNCE_MS = 2000;

export type AutoBackupOptions = {
  repo: string;
  appConfig: string;
  /** Starts a backup job; the settings are the ones in force when the deadline passed. */
  start: (settings: BackupSettings, trigger: BackupTrigger) => void;
  /** Whether a backup is running or waiting in the job runner. */
  busy: () => boolean;
  debounceMs?: number;
  timers?: Timers;
};

const unref = <T>(t: T): T => {
  (t as { unref?: () => void }).unref?.();
  return t;
};
const realTimers: Timers = { set: (fn, ms) => unref(setTimeout(fn, ms)), clear: (h) => clearTimeout(h as Timer) };

export class AutoBackup {
  private pending: BackupTrigger | undefined;
  private timer: unknown;
  private readonly debounceMs: number;
  private readonly timers: Timers;

  constructor(private readonly o: AutoBackupOptions) {
    this.debounceMs = o.debounceMs ?? BACKUP_DEBOUNCE_MS;
    this.timers = o.timers ?? realTimers;
  }

  /** Never throws and never waits: a backup that cannot be made must not fail the action that asked for it. */
  publish(trigger: BackupTrigger): void {
    try {
      if (!shouldPublish(backupSettings(this.o.repo, this.o.appConfig), this.o.repo, trigger)) return;
    } catch {
      return;
    }
    this.pending = trigger;
    this.arm();
  }

  private arm() {
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = this.timers.set(() => this.fire(), this.debounceMs);
  }

  private fire() {
    this.timer = undefined;
    const trigger = this.pending;
    if (trigger === undefined) return;
    if (this.o.busy()) return this.arm();
    this.pending = undefined;
    try {
      const settings = backupSettings(this.o.repo, this.o.appConfig);
      if (featureReady(settings, this.o.repo)) this.o.start(settings, trigger);
    } catch (e) {
      console.error(`vinculum: automatic backup not started: ${(e as Error).message}`);
    }
  }
}
