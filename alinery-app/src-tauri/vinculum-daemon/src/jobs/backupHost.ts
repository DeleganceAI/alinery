// What the daemon does around the backup and purge jobs (S4.9): starts them, owns the automatic triggers, waits for the backup an
// archive needs, and reports each one that finished. The job bodies are jobs/child.ts (backup) and jobs/purge.ts; this is the
// part that runs in the daemon itself, because it needs the daemon's sessions, its telemetry and its store.
import { JobKind, type Job, JobState } from "alinery-proto/alinery/v1/entities_pb";
import { type BackupSettings, type BackupTrigger, backupSettings, validateDestination } from "../domain/backup.ts";
import { DomainError } from "../platform/lock.ts";
import type { Sender } from "../platform/telemetry.ts";
import type { BackupParams } from "./child.ts";
import { AutoBackup } from "./autoBackup.ts";
import { planPurge } from "./purge.ts";
import type { JobRunner } from "./runner.ts";

export type BackupHostOptions = {
  repo: string;
  appConfig: string;
  /** The app's version, stamped into every archive's name and meta so a restored zip names the build that wrote it. */
  version: string;
  telemetry: Sender;
  /** The live sessions: a purge ends the ones under archived tasks before their files go. */
  sessions: { isRunning(id: string): boolean; stop(id: string): unknown };
  /** Called after a purge so the store drops the rows of what it deleted. */
  afterPurge: () => Promise<void>;
  debounceMs?: number;
};

export class BackupHost {
  private readonly auto: AutoBackup;

  constructor(
    private readonly runner: JobRunner,
    private readonly o: BackupHostOptions,
  ) {
    this.auto = new AutoBackup({
      repo: o.repo,
      appConfig: o.appConfig,
      busy: () => runner.busy(JobKind.BACKUP),
      start: (settings, trigger) => this.startBackup(settings, trigger),
      debounceMs: o.debounceMs,
    });
  }

  private startBackup(settings: BackupSettings, trigger: BackupTrigger): string {
    const params: BackupParams = { repo: this.o.repo, settings, trigger, version: this.o.version };
    return this.runner.start(JobKind.BACKUP, params);
  }

  /** An automatic trigger (archive of a sub-task, push, an artifact change): debounced, gated by its own flag, never fails its caller. */
  publish(trigger: BackupTrigger): void {
    this.auto.publish(trigger);
  }

  /** BACKUP NOW. Refused up front, with the reason, when the feature is off or the destination is unusable, so no job is made to fail. */
  startManual(): string {
    const settings = backupSettings(this.o.repo, this.o.appConfig);
    if (!settings.enabled) throw new DomainError("failed_precondition", "backup is disabled for this repository");
    try {
      validateDestination(this.o.repo, settings.destination);
    } catch (e) {
      throw new DomainError("failed_precondition", (e as Error).message);
    }
    return this.startBackup(settings, "manual");
  }

  /**
   * The backup an archive waits for. Off, or no destination: nothing to do. Otherwise the backup runs as a job and the archive
   * goes ahead only if it succeeded, so a person who switched this on never archives a task without the copy they asked for.
   */
  async beforeArchive(): Promise<void> {
    const settings = backupSettings(this.o.repo, this.o.appConfig);
    if (!settings.enabled || !settings.triggerPreArchive || settings.destination === "") return;
    const job = await this.runner.finished(this.startBackup(settings, "pre_archive"));
    if (job.state !== JobState.DONE) throw new DomainError("failed_precondition", `the backup before the archive ${job.state === JobState.CANCELLED ? "was cancelled" : `failed: ${job.error}`}; the task was not archived`);
  }

  /** Ends the sessions that hold files the purge will delete, then starts the job. */
  async startPurge(): Promise<string> {
    for (const { id } of planPurge(this.o.repo).killIds) if (this.o.sessions.isRunning(id)) await this.o.sessions.stop(id);
    return this.runner.start(JobKind.PURGE, { repo: this.o.repo });
  }

  /** The runner's `onEnd`: usage events for the jobs that did something, and the store's rows after a purge. */
  ended(job: Job, params: unknown): void {
    if (job.state !== JobState.DONE) return;
    if (job.kind === JobKind.BACKUP) {
      const trigger = (params as BackupParams).trigger;
      this.o.telemetry.record(() => ({ event: "backup.create", source: "alineryd", trigger }));
    } else if (job.kind === JobKind.PURGE) {
      this.o.telemetry.record(() => ({ event: "storage.purge", source: "alineryd" }));
      void this.o.afterPurge().catch((e) => console.error(`vinculum: rows after a purge not refreshed: ${(e as Error).message}`));
    }
  }
}
