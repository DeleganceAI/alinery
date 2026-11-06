// The other end of the runner (plan 2.3.5): `main.ts` hands `--job <kind>` here before any daemon
// start-up. Params arrive as JSON on stdin; the child answers with JSON lines on stdout, one of
// {progress}, {result} or {error}. A kind that throws is an {error} line and exit code 1.
import { type BackupSettings, type BackupTrigger, createBackup, restoreBackup } from "../domain/backup.ts";
import { purgeArchived } from "./purge.ts";
import { type StorageParams, scanStorage } from "./storage.ts";

export type BackupParams = { repo: string; settings: BackupSettings; trigger: BackupTrigger; version: string };

export type Report = (progress: { done: number; total: number; label: string }) => void;
type Handler = (params: never, report: Report) => unknown | Promise<unknown>;

const HANDLERS: Record<string, Handler> = {
  "storage-scan": (params: StorageParams) => scanStorage(params),
  backup: (params: BackupParams, report) => createBackup(params.repo, params.settings, params.trigger, params.version, report),
  // A cancel (SIGTERM) is honoured between items: the item in hand is finished, so no task is left half deleted.
  purge: (params: { repo: string }, report) => {
    let stop = false;
    process.on("SIGTERM", () => {
      stop = true;
    });
    return purgeArchived(params.repo, () => stop, report);
  },
};

const emit = (line: object) => process.stdout.write(`${JSON.stringify(line)}\n`);

/**
 * `--restore-backup <repo> <archive>`: the one-shot restore (plan 2.3.5). It replaces the files under a daemon, so it runs only
 * after the shell has stopped that daemon, and it is not a job: nothing subscribes to it. One JSON line on stdout, `{result}` or `{error}`.
 */
export async function runRestoreBackup(repo: string, archive: string): Promise<number> {
  try {
    emit({ result: await restoreBackup(repo, archive) });
    return 0;
  } catch (e) {
    emit({ error: (e as Error).message });
    return 1;
  }
}

export async function runJobChild(kind: string): Promise<number> {
  const handler = HANDLERS[kind];
  if (!handler) {
    emit({ error: `unknown job kind ${kind}` });
    return 1;
  }
  try {
    const params = JSON.parse((await Bun.stdin.text()) || "{}");
    emit({ result: await handler(params, (progress) => emit({ progress })) });
    return 0;
  } catch (e) {
    emit({ error: (e as Error).message });
    return 1;
  }
}
