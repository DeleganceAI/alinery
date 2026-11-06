import { Code, type ServiceImpl } from "@connectrpc/connect";
import { Capability } from "alinery-proto/alinery/v1/admin_pb";
import { JobKind } from "alinery-proto/alinery/v1/entities_pb";
import type { JobService } from "alinery-proto/alinery/v1/jobs_pb";
import type { JobRunner } from "../jobs/runner.ts";
import type { StorageParams } from "../jobs/storage.ts";
import type { Dedupe } from "../sync/dedupe.ts";
import type { Store } from "../sync/store.ts";
import { requireCapability } from "./auth.ts";
import { fail, metaOf } from "./errors.ts";

// Each kind is its own RPC (O24 b), so a capability is per RPC. Start and Cancel need ACT; S4.9 makes
// the purge RPC need ADMIN.
export function jobService(runner: JobRunner, dedupe: Dedupe, store: Store, storageScan: StorageParams): ServiceImpl<typeof JobService> {
  const applied = () => ({ cursor: store.cursor() });
  return {
    startStorageScan: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return dedupe.once(metaOf(req.meta), () => ({ jobId: runner.start(JobKind.STORAGE_SCAN, storageScan), applied: applied() }));
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
