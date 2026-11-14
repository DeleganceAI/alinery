// SubtaskService (plan S4.8): the sub-task controls of a task page, served by the daemon that owns the files and the sessions,
// so a repository on another machine answers the same calls. The state is a read; starting a manager and discarding are
// writes that name their mutation, and each answers with a cursor that covers the files it changed.
import type { ServiceImpl } from "@connectrpc/connect";
import type { JsonValue } from "@bufbuild/protobuf";
import { Capability } from "alinery-proto/alinery/v1/admin_pb";
import type { SubtaskService } from "alinery-proto/alinery/v1/subtasks_pb";
import { deleteExecutionRefs } from "../domain/gitActions.ts";
import { FINALIZE_MODES, type FinalizeMode, finalizeSubtask, inspectSubtaskFinish } from "../domain/subtaskFinish.ts";
import { discardSubtask, ownerSessionIds, subtaskState } from "../domain/subtasks.ts";
import { loadRelationships } from "../domain/artifactTree.ts";
import { DomainError } from "../platform/lock.ts";
import type { Dedupe } from "../sync/dedupe.ts";
import type { Store } from "../sync/store.ts";
import { requireCapability } from "./auth.ts";
import { domain, metaOf } from "./errors.ts";
import { metaRel, nameRel, ranOrFail, type SessionControl, started } from "./sessions.ts";
import { createSubtask, type TaskDeps } from "./tasks.ts";

type Struct = { [key: string]: JsonValue };

export function subtaskService(c: SessionControl, dedupe: Dedupe, store: Store, tasks?: TaskDeps): ServiceImpl<typeof SubtaskService> {
  const applied = () => ({ cursor: store.cursor() });
  return {
    // The manager agent's own calls (S5.1). The child is created inside the parent's reservation, as the page's manager flow does.
    createSubtask: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return dedupe.once(metaOf(req.meta), () =>
        domain(async () => {
          if (!tasks) throw new DomainError("failed_precondition", "this daemon was started without task creation");
          const result = await createSubtask(tasks, {
            manager_session_id: req.managerSessionId,
            name: req.name,
            slug: req.slug,
            playbook: req.playbookRef ? { reference: { scope: req.playbookRef.scope, key: req.playbookRef.key }, source: req.playbookSource } : null,
            instructions: req.instructions,
            start: req.start,
          });
          return { applied: applied(), result: result as Struct };
        }),
      );
    },
    inspectSubtaskFinish: (req, ctx) => {
      requireCapability(ctx, Capability.VIEW);
      return domain(async () => ({ inspection: (await inspectSubtaskFinish(c.repo, req.managerSessionId, ownerSessionIds(c.repo, req.managerSessionId).filter((id) => c.runner.isRunning(id)))) as Struct }));
    },
    finalizeSubtask: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return dedupe.once(metaOf(req.meta), () =>
        domain(async () => {
          if (!(FINALIZE_MODES as readonly string[]).includes(req.mode)) throw new DomainError("invalid_argument", `unknown finalize mode '${req.mode}'`);
          const mode = req.mode as FinalizeMode;
          // An archive waits for the backup it asks for, as TaskService.ArchiveTask does; a finish that cannot start leaves none behind.
          await tasks?.backups?.beforeArchive();
          const result = await finalizeSubtask(c.repo, req.managerSessionId, mode);
          const child = String((result.archived_child as { slug?: string }).slug ?? "");
          const parent = String((result.parent_task as { slug?: string }).slug ?? "");
          for (const slug of [parent, child]) if (slug) await c.refresh(`tasks/${slug}/task.md`);
          if (child) await deleteExecutionRefs(c.repo, child).catch((e) => console.error(`vinculum: ${child} execution refs not deleted: ${(e as Error).message}`));
          return { applied: applied(), result: result as Struct };
        }),
      );
    },
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
              target: { kind: "subtask_manager", subtask_slug: subtaskSlug, recover: req.recover, harness: "vinculum", model: null },
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
          // Queued before the kills, as the page did: it never stops the discard, and its archive is made after the debounce.
          c.backups?.publish("pre_archive");
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
