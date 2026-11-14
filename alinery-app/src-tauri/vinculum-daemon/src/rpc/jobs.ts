import { Code, type ServiceImpl } from "@connectrpc/connect";
import { Capability } from "alinery-proto/alinery/v1/admin_pb";
import { JobKind } from "alinery-proto/alinery/v1/entities_pb";
import type { JobService } from "alinery-proto/alinery/v1/jobs_pb";
import type { BackupHost } from "../jobs/backupHost.ts";
import type { JobRunner } from "../jobs/runner.ts";
import type { StorageParams } from "../jobs/storage.ts";
import type { Dedupe } from "../sync/dedupe.ts";
import type { Store } from "../sync/store.ts";
import { requireCapability } from "./auth.ts";
import { domain, fail, metaOf } from "./errors.ts";

// Each kind is its own RPC (O24 b), so a capability is per RPC. Scan, backup and cancel need ACT; the purge deletes
// archived work for good and needs ADMIN (from S5.1 AGENT reaches both, O18 b).
export function jobService(runner: JobRunner, dedupe: Dedupe, store: Store, storageScan: StorageParams, backups?: BackupHost): ServiceImpl<typeof JobService> {
  const applied = () => ({ cursor: store.cursor() });
  const host = () => {
    if (!backups) throw fail(Code.Unimplemented, "unimplemented", "this daemon was started without backups");
    return backups;
  };
  return {
    startStorageScan: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return dedupe.once(metaOf(req.meta), () => ({ jobId: runner.start(JobKind.STORAGE_SCAN, storageScan), applied: applied() }));
    },
    startBackup: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return dedupe.once(metaOf(req.meta), () => domain(() => ({ jobId: host().startManual(), applied: applied() })));
    },
    startPurge: (req, ctx) => {
      requireCapability(ctx, Capability.ADMIN);
      return dedupe.once(metaOf(req.meta), () => domain(async () => ({ jobId: await host().startPurge(), applied: applied() })));
    },
    cancelJob: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return dedupe.once(metaOf(req.meta), () => {
        if (!runner.cancel(req.jobId)) throw fail(Code.NotFound, "not_found", `no job ${req.jobId}`);
        return { applied: applied() };
      });
    },
  };
}
