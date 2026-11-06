// Storage and backup (plan S4.9). The scan, the backup and the purge are jobs of the repository's daemon, so a repository on
// another machine does them on its own disk; the lists and checks around a backup are unary calls. Restore is the one step the
// shell keeps (it stops the daemon first, 2.3.5), so the page asks the daemon to verify the archive and then calls `ipc.restoreBackup`.
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { BackupService } from "alinery-proto/alinery/v1/backups_pb";
import { type BackupResult, type Entity, type Job, JobKind, JobState, type StorageInfo as StorageInfoProto } from "alinery-proto/alinery/v1/entities_pb";
import { JobService } from "alinery-proto/alinery/v1/jobs_pb";
import { useCallback } from "react";
import { daemonTransport } from "../daemon/transport";
import type { BackupListItem, BackupMeta, BackupTrigger, PurgeArchivedResult, StorageInfo } from "../types";
import { acquireScope, REPO_SCOPE, useEntities, useScope } from "./hooks";
import { newMutationMeta } from "./mutation";

const jobs = (repo: string) => createClient(JobService, daemonTransport(repo));
const backups = (repo: string) => createClient(BackupService, daemonTransport(repo));

async function call<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    const err = ConnectError.from(e);
    throw new Error(err.code === Code.Unavailable && err.rawMessage === "" ? "the repository's daemon is not reachable" : err.rawMessage);
  }
}

const jobOf = (e: Entity | undefined): Job | undefined => (e?.value.case === "job" ? e.value.value : undefined);

/**
 * Starts a job and resolves with it when it is DONE. A failed or cancelled job rejects with the daemon's message, and so does a
 * link that drops while it runs (the job may still be running; the daemon outlives this window).
 */
async function runJob(repo: string, start: () => Promise<string>): Promise<Job> {
  const { replica, release } = acquireScope(repo, REPO_SCOPE);
  try {
    const id = await call(start);
    return await new Promise<Job>((resolve, reject) => {
      let off = () => {};
      const settle = (finish: () => void) => {
        off();
        finish();
      };
      const look = () => {
        const job = jobOf(replica.get(`job/_/${id}`));
        if (job?.state === JobState.DONE) return settle(() => resolve(job));
        if (job?.state === JobState.FAILED) return settle(() => reject(new Error(job.error || "the job failed")));
        if (job?.state === JobState.CANCELLED) return settle(() => reject(new Error("the job was cancelled")));
        if (replica.stale) settle(() => reject(new Error("lost the connection to the repository's daemon; the job may still be running")));
      };
      off = replica.listen(look);
      look();
    });
  } finally {
    release();
  }
}

const num = (n: bigint | number) => Number(n);

const storageOf = (s: StorageInfoProto): StorageInfo => ({
  app_config_path: s.appConfigPath,
  repo_path: s.repoPath,
  alinery_dir: s.alineryDir,
  repo_config_path: s.repoConfigPath,
  harnesses_path: s.harnessesPath,
  tasks_dir: s.tasksDir,
  worktrees_dir: s.worktreesDir,
  alineryd_socket_path: s.alinerydSocketPath,
  alineryd_lock_path: s.alinerydLockPath,
  mcp_socket_path: s.mcpSocketPath,
  mcp_status_path: s.mcpStatusPath,
  archived_task_count: s.archivedTaskCount,
  archived_session_count: s.archivedSessionCount,
  archived_bytes: num(s.archivedBytes),
  active_bytes: num(s.activeBytes),
});

const metaOf = (b: BackupResult): BackupMeta => ({
  repo_name: b.repoName,
  repo_path: b.repoPath,
  created_at: num(b.createdAt),
  schema_version: b.schemaVersion,
  alinery_version: b.alineryVersion,
  trigger: b.trigger as BackupTrigger,
  included_dirs: b.includedDirs,
});

/** Where a repository keeps its data and what that data weighs, measured by its daemon where the data lives. */
export async function storageInfo(repo: string): Promise<StorageInfo> {
  const job = await runJob(repo, async () => (await jobs(repo).startStorageScan({ meta: newMutationMeta() })).jobId);
  if (job.result.case !== "storage") throw new Error("the daemon returned no storage numbers");
  return storageOf(job.result.value);
}

/** Deletes every archived task, session and worktree (the daemon ends a session still running under one first). */
export async function deleteAllArchivedStorage(repo: string): Promise<PurgeArchivedResult> {
  const job = await runJob(repo, async () => (await jobs(repo).startPurge({ meta: newMutationMeta() })).jobId);
  if (job.result.case !== "purge") throw new Error("the daemon returned no purge result");
  const r = job.result.value;
  return {
    deleted_tasks: r.deletedTasks,
    deleted_sessions: r.deletedSessions,
    deleted_worktrees: r.deletedWorktrees,
    errors: r.errors.map((f) => ({ target: f.target, error: f.error })),
  };
}

/** A manual backup, with the repository's own settings. */
export async function backupNow(repo: string): Promise<BackupMeta> {
  const job = await runJob(repo, async () => (await jobs(repo).startBackup({ meta: newMutationMeta() })).jobId);
  if (job.result.case !== "backup") throw new Error("the daemon returned no backup");
  return metaOf(job.result.value);
}

/** The archives of the repository in the destination its settings name, newest first. */
export async function listBackups(repo: string): Promise<BackupListItem[]> {
  const r = await call(() => backups(repo).listBackups({}));
  return r.items.map((i) => ({ id: i.id, path: i.path, created_at: num(i.createdAt), trigger: i.trigger, size_bytes: num(i.sizeBytes), alinery_version: i.alineryVersion }));
}

/** Is `destination` a folder this repository may write backups to? Answers the path the daemon will use. */
export async function checkBackupDestination(repo: string, destination: string): Promise<string> {
  return (await call(() => backups(repo).checkBackupDestination({ destination }))).resolved;
}

/** Whether the archive belongs to this repository; rejects with the reason if not. Run before the restore stops anything. */
export async function verifyBackup(repo: string, path: string): Promise<BackupMeta> {
  const r = await call(() => backups(repo).verifyBackup({ path }));
  if (!r.meta) throw new Error("the daemon returned no backup details");
  return metaOf(r.meta);
}

/** Is a backup queued or running for this repository, whoever started it (this window, another one, an automatic trigger)? */
export function useBackupBusy(repo: string): boolean {
  const replica = useScope(repo, REPO_SCOPE);
  const running = useCallback((e: Entity) => {
    const job = jobOf(e);
    return job?.kind === JobKind.BACKUP && (job.state === JobState.QUEUED || job.state === JobState.RUNNING);
  }, []);
  return useEntities(replica, running).length > 0;
}
