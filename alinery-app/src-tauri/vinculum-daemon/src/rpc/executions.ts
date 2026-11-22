// ExecutionService: the person's permission for one live execution to finish. The read side is the
// `execution/<slug>/<slug>` entity; what an execution may do, and when it ends, is the playbook engine's.
import { Code, type ServiceImpl } from "@connectrpc/connect";
import { Capability } from "alinery-proto/alinery/v1/admin_pb";
import type { ExecutionService } from "alinery-proto/alinery/v1/executions_pb";
import { executionKey } from "../domain/executions.ts";
import { continueReviewed, nudgeExecution, permitExecution, setStepContinuation } from "../graph.ts";
import type { Dedupe } from "../sync/dedupe.ts";
import type { Store } from "../sync/store.ts";
import { requireCapability } from "./auth.ts";
import { domain, fail, metaOf } from "./errors.ts";

/** The slug is a directory name in the repository; anything else is not a task. */
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function executionService(dedupe: Dedupe, store: Store): ServiceImpl<typeof ExecutionService> {
  const checkRevision = (slug: string, expected: bigint) => {
    const row = store.get(executionKey(slug));
    if (!row) throw fail(Code.NotFound, "not_found", `no execution state for task ${slug}`);
    if (expected !== 0n && row.revision !== expected) {
      throw fail(Code.Aborted, "aborted", `the execution changed since revision ${expected} (now ${row.revision})`);
    }
  };
  return {
    nudgeExecution: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      const meta = metaOf(req.meta);
      // An admitted nudge can still be canceled with its run. Reconcile from the durable submission.
      return domain(async () => {
        if (!SLUG.test(req.taskSlug) || !req.executionId || !req.sessionId || !req.runId) {
          throw fail(Code.InvalidArgument, "invalid_argument", "NudgeExecution needs a task, execution, owner session, and active run");
        }
        const deliveryId = await nudgeExecution(req.taskSlug, req.executionId, req.sessionId, req.runId, meta.mutationId);
        return { deliveryId };
      });
    },
    setStepContinuation: (req, ctx) => {
      requireCapability(ctx, Capability.APPROVE);
      return dedupe.once(metaOf(req.meta), () =>
        domain(async () => {
          if (!SLUG.test(req.taskSlug) || !req.stepKey) throw fail(Code.InvalidArgument, "invalid_argument", "SetStepContinuation needs task_slug and step_key");
          await setStepContinuation(req.taskSlug, req.stepKey, req.automatic, () => checkRevision(req.taskSlug, req.expectedRevision));
          return { applied: { cursor: store.cursor() } };
        }),
      );
    },
    continueReviewed: (req, ctx) => {
      requireCapability(ctx, Capability.APPROVE);
      return dedupe.once(metaOf(req.meta), () =>
        domain(async () => {
          if (!SLUG.test(req.taskSlug) || !req.executionId || !req.sessionId || req.workRevision === 0n || !Number.isSafeInteger(Number(req.workRevision))) {
            throw fail(Code.InvalidArgument, "invalid_argument", "ContinueReviewed needs a task, execution, owner session, and positive work revision");
          }
          await continueReviewed(req.taskSlug, req.executionId, req.sessionId, Number(req.workRevision));
          return { applied: { cursor: store.cursor() } };
        }),
      );
    },
    allowCompletion: (req, ctx) => {
      requireCapability(ctx, Capability.APPROVE);
      return dedupe.once(metaOf(req.meta), () =>
        domain(async () => {
          if (!SLUG.test(req.taskSlug) || !req.executionId) throw fail(Code.InvalidArgument, "invalid_argument", "AllowCompletion needs task_slug and execution_id");
          checkRevision(req.taskSlug, req.expectedRevision);
          await permitExecution(req.taskSlug, req.executionId);
          return { applied: { cursor: store.cursor() } };
        }),
      );
    },
  };
}
