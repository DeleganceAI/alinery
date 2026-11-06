// SubtaskService (plan S4.8): the sub-task controls of a task page, served by the daemon that owns the files and the sessions,
// so a repository on another machine answers the same calls. The state is a read; starting a manager and discarding are
// writes that name their mutation, and each answers with a cursor that covers the files it changed.
import type { ServiceImpl } from "@connectrpc/connect";
import { Capability } from "alinery-proto/alinery/v1/admin_pb";
import type { SubtaskService } from "alinery-proto/alinery/v1/subtasks_pb";
import { deleteExecutionRefs } from "../domain/gitActions.ts";
import { discardSubtask, subtaskState } from "../domain/subtasks.ts";
import { loadRelationships } from "../domain/artifactTree.ts";
import { DomainError } from "../platform/lock.ts";
import type { Dedupe } from "../sync/dedupe.ts";
import type { Store } from "../sync/store.ts";
import { requireCapability } from "./auth.ts";
import { domain, metaOf } from "./errors.ts";
import { metaRel, nameRel, ranOrFail, type SessionControl, started } from "./sessions.ts";

export function subtaskService(c: SessionControl, dedupe: Dedupe, store: Store): ServiceImpl<typeof SubtaskService> {
  const applied = () => ({ cursor: store.cursor() });
  return {
    subtaskState: (req, ctx) => {
      requireCapability(ctx, Capability.VIEW);
      return domain(() => subtaskState(c.repo, req.slug));
    },
    startManager: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return dedupe.once(metaOf(req.meta), () =>
        domain(async () => {
          let subtaskSlug: string | null = null;
          if (req.recover) {
            const active = String(loadRelationships(c.repo).get(req.slug)?.active_subtask ?? "");
            if (active === "") throw new DomainError("failed_precondition", "task has no active sub-task to recover");
            subtaskSlug = active;
          }
          const reply = ranOrFail(
            await c.runner.create({
              task_slug: req.slug,
              target: { kind: "subtask_manager", subtask_slug: subtaskSlug, recover: req.recover, harness: "omp", model: null },
              launch_override: null,
              prompt_extra: null,
              handoff_artifact: null,
              start: true,
            }),
          );
          await c.refresh(metaRel(req.slug, String((reply.session as Record<string, unknown>).id)));
          return { applied: applied(), started: started(reply) };
        }),
      );
    },
    discardSubtask: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return dedupe.once(metaOf(req.meta), () =>
        domain(async () => {
          const result = await discardSubtask(c.repo, req.slug, req.managerSessionId, (_slug, id) => {
            if (c.runner.isRunning(id)) c.runner.stop(id);
          });
          for (const s of result.sessions) {
            await c.refresh(metaRel(s.slug, s.id));
            await c.refresh(nameRel(s.slug, s.id));
          }
          for (const slug of [req.slug, ...result.killed]) await c.refresh(`tasks/${slug}/task.md`);
          // The kills are written; a ref that cannot be deleted is left for the next `git gc` to find, as an archive does.
          for (const slug of result.killed) {
            await deleteExecutionRefs(c.repo, slug).catch((e) => console.error(`vinculum: ${slug} execution refs not deleted: ${(e as Error).message}`));
          }
          return { applied: applied(), stoppedSessionIds: result.sessions.map((s) => s.id) };
        }),
      );
    },
  };
}
