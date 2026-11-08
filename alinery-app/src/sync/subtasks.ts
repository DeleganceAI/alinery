// The sub-task controls of a task page (plan S4.8): what it offers, the manager session, and killing a child or discarding
// a setup. The daemon owns the files and stops the sessions, so a repository on another machine answers the same calls.
import { createClient } from "@connectrpc/connect";
import type { Session } from "alinery-proto/alinery/v1/entities_pb";
import { SubtaskService, type SubtaskTaskSummary } from "alinery-proto/alinery/v1/subtasks_pb";
import { daemonTransport } from "../daemon/transport";
import type { CreateExecutionSessionReply, SubtaskManagerState, TaskSummary } from "../types";
import { sessionDisplayFromProto } from "./board";
import { newMutationMeta } from "./mutation";
import { call, startedOf } from "./sessions";

const subtasks = (repo: string) => createClient(SubtaskService, daemonTransport(repo));

const summaryOf = (t: SubtaskTaskSummary): TaskSummary => ({
  name: t.name,
  slug: t.slug,
  branch: t.branch,
  worktree: t.worktree,
  has_worktree: t.hasWorktree,
  playbook: t.playbook,
  archived: t.archived,
  draft: t.draft,
  subtask_outcome: t.subtaskOutcome as TaskSummary["subtask_outcome"],
});
const managerOf = (s: Session | undefined) => (s ? sessionDisplayFromProto(s) : null);

export async function subtaskState(repo: string, taskSlug: string): Promise<SubtaskManagerState> {
  const r = await call(() => subtasks(repo).subtaskState({ slug: taskSlug }));
  if (!r.task) throw new Error("the daemon returned no task");
  return {
    task: summaryOf(r.task),
    parent_task: r.parentTask ? summaryOf(r.parentTask) : null,
    active_subtask: r.activeSubtask ? summaryOf(r.activeSubtask) : null,
    parent_manager_session: managerOf(r.parentManagerSession),
    parent_manager_owner_task_slug: r.parentManagerOwnerTaskSlug,
    manager_session: managerOf(r.managerSession),
    manager_owner_task_slug: r.managerOwnerTaskSlug,
    can_start: r.canStart,
    can_recover: r.canRecover,
    disabled_reason: r.disabledReason,
  };
}

/** Creates and starts the task's manager session; `recover` binds it to the task's active child. */
export async function startSubtaskManager(repo: string, taskSlug: string, recover = false): Promise<CreateExecutionSessionReply> {
  const r = await call(() => subtasks(repo).startManager({ meta: newMutationMeta(), slug: taskSlug, recover }));
  return startedOf(r.started);
}

/** An empty `managerSessionId` kills the task's active child. The daemon queues the automatic backup itself, and a failure of it never stops the discard. */
export async function discardSubtask(repo: string, taskSlug: string, managerSessionId: string): Promise<void> {
  await call(() => subtasks(repo).discardSubtask({ meta: newMutationMeta(), slug: taskSlug, managerSessionId }));
}
