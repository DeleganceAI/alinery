// BackupService (plan S4.9): the reads and checks around a backup. The daemon runs `zip` and `unzip` where the repository lives,
// so a repository on another machine lists and checks the archives on its own disk.
import { dirname } from "node:path";
import { realpathSync } from "node:fs";
import type { ServiceImpl } from "@connectrpc/connect";
import { Capability } from "alinery-proto/alinery/v1/admin_pb";
import type { BackupService } from "alinery-proto/alinery/v1/backups_pb";
import { type BackupMeta, backupSettings, listBackups, validateDestination, verifyBackup } from "../domain/backup.ts";
import { DomainError } from "../platform/lock.ts";
import { requireCapability } from "./auth.ts";
import { domain } from "./errors.ts";

export type BackupServiceDeps = { repo: string; appConfig: string };

/** A refusal is a precondition the person can fix (a folder that cannot be written, a backup of another repository), not an internal error. */
async function refused<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw e instanceof DomainError ? e : new DomainError("failed_precondition", (e as Error).message);
  }
}

export const resultOfMeta = (m: BackupMeta, path: string) => ({
  path,
  repoName: m.repo_name,
  repoPath: m.repo_path,
  createdAt: BigInt(m.created_at),
  schemaVersion: m.schema_version,
  alineryVersion: m.alinery_version,
  trigger: m.trigger,
  includedDirs: m.included_dirs,
});

export function backupService(d: BackupServiceDeps): ServiceImpl<typeof BackupService> {
  return {
    listBackups: (_req, ctx) => {
      requireCapability(ctx, Capability.VIEW);
      return domain(() =>
        refused(async () => ({
          items: (await listBackups(d.repo, backupSettings(d.repo, d.appConfig))).map((i) => ({
            id: i.id,
            path: i.path,
            createdAt: BigInt(i.created_at),
            trigger: i.trigger,
            sizeBytes: BigInt(i.size_bytes),
            alineryVersion: i.alinery_version,
          })),
        })),
      );
    },
    checkBackupDestination: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return domain(() => refused(() => ({ resolved: validateDestination(d.repo, req.destination) })));
    },
    verifyBackup: (req, ctx) => {
      requireCapability(ctx, Capability.VIEW);
      return domain(() =>
        refused(async () => {
          // Only an archive in the destination the settings name: this is a VIEW call, and it reads a file the caller names.
          const dest = validateDestination(d.repo, backupSettings(d.repo, d.appConfig).destination);
          if (dirname(realpathSync(req.path)) !== dest) throw new Error(`${req.path} is not in the backup destination`);
          return { meta: resultOfMeta(await verifyBackup(d.repo, req.path), req.path) };
        }),
      );
    },
  };
}
