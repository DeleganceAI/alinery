// ExecutionService (plan S4.2): the person's permission for one live execution to finish. The read side is the
// `execution/<slug>/<slug>` entity; what an execution may do, and when it ends, is the playbook engine's.
import { Code, type ServiceImpl } from "@connectrpc/connect";
import { Capability } from "alinery-proto/alinery/v1/admin_pb";
import type { ExecutionService } from "alinery-proto/alinery/v1/executions_pb";
import { executionKey } from "../domain/executions.ts";
import { permitExecution } from "../graph.ts";
import type { Dedupe } from "../sync/dedupe.ts";
import type { Store } from "../sync/store.ts";
import { requireCapability } from "./auth.ts";
import { domain, fail, metaOf } from "./errors.ts";

/** The slug is a directory name in the repository; anything else is not a task. */
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function executionService(dedupe: Dedupe, store: Store): ServiceImpl<typeof ExecutionService> {
  return {
    allowCompletion: (req, ctx) => {
      requireCapability(ctx, Capability.APPROVE);
      return dedupe.once(metaOf(req.meta), () =>
        domain(async () => {
          if (!SLUG.test(req.taskSlug) || !req.executionId) throw fail(Code.InvalidArgument, "invalid_argument", "AllowCompletion needs task_slug and execution_id");
          const row = store.get(executionKey(req.taskSlug));
          if (!row) throw fail(Code.NotFound, "not_found", `no execution state for task ${req.taskSlug}`);
          if (req.expectedRevision !== 0n && row.revision !== req.expectedRevision) {
            throw fail(Code.Aborted, "aborted", `the execution changed since revision ${req.expectedRevision} (now ${row.revision})`);
          }
          await permitExecution(req.taskSlug, req.executionId);
          return { applied: { cursor: store.cursor() } };
        }),
      );
    },
  };
}
