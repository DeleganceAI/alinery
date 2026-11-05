import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import { Capability } from "alinery-proto/alinery/v1/admin_pb";
import { ErrorDetailSchema, type MutationMeta } from "alinery-proto/alinery/v1/common_pb";
import { JobKind } from "alinery-proto/alinery/v1/entities_pb";
import type { JobService } from "alinery-proto/alinery/v1/jobs_pb";
import type { JobRunner } from "../jobs/runner.ts";
import type { StorageParams } from "../jobs/storage.ts";
import type { Dedupe } from "../sync/dedupe.ts";
import type { Store } from "../sync/store.ts";
import { requireCapability } from "./auth.ts";

const fail = (code: Code, detail: string, message: string) => new ConnectError(message, code, undefined, [{ desc: ErrorDetailSchema, value: { code: detail, message } }]);

/** A mutation without an id could not be deduplicated, so it is refused rather than run twice on a retry. */
function metaOf(meta: MutationMeta | undefined) {
  if (!meta?.clientId || !meta.mutationId) throw fail(Code.InvalidArgument, "invalid_argument", "a mutation needs meta.client_id and meta.mutation_id");
  return meta;
}

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
