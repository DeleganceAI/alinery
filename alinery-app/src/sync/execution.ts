// A task's execution state from the daemon's `execution/<slug>/<slug>` entity (plan S4.2): what the shell's observation
// commands answered, and the approval that replaced the shell's allow command. The row is the Rust-shaped state plus the playbook
// definition; the engine behind it is the daemon's.
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import type { Cursor } from "alinery-proto/alinery/v1/common_pb";
import type { Entity } from "alinery-proto/alinery/v1/entities_pb";
import { ExecutionService } from "alinery-proto/alinery/v1/executions_pb";
import { useMemo, useSyncExternalStore } from "react";
import { daemonTransport } from "../daemon/transport";
import type { NormalizedPlaybook, TaskExecutionReply, TaskExecutionState } from "../types";
import { acquireScope, REPO_SCOPE, useEntity, useScope } from "./hooks";
import { newMutationMeta } from "./mutation";
import type { Replica } from "./replica";

export const executionKey = (slug: string) => `execution/${slug}/${slug}`;

export type ExecutionRead = { repoPath: string; taskSlug: string };

/** The reply a row stands for. Its `live` is always available: a row only arrives over a working stream. */
export function replyOf(e: Entity | undefined): TaskExecutionReply | undefined {
  if (e?.value.case !== "execution") return undefined;
  const row = e.value.value;
  // The row is generated types on one side and the views' types on the other, so each half is
  // cast. Do not default a missing half to `{}` and cast that: an empty object satisfies the cast
  // and then throws in a view (`definition.step.find` on `{}`). A row without both halves is not
  // a reply, and the caller already has the "no row yet" path for it.
  if (!row.state || !row.definition) return undefined;
  return {
    state: row.state as unknown as TaskExecutionState,
    definition: row.definition as unknown as NormalizedPlaybook,
    live: { status: "available" },
    revision: e.revision,
  };
}

const NOTHING = () => () => {};

/** The task's execution while this component is mounted. `error` is set once the stream is up and the row is missing. */
export function useTaskExecution(repo: string, slug: string): { reply?: TaskExecutionReply; error: string; ready: boolean } {
  const replica = useScope(repo, REPO_SCOPE);
  const entity = useEntity(replica, executionKey(slug));
  const subscribe = useMemo(() => (replica ? replica.listen : NOTHING), [replica]);
  const ready = useSyncExternalStore(subscribe, () => replica?.ready ?? false);
  return useMemo(() => {
    const reply = replyOf(entity);
    if (reply) return { reply, error: "", ready };
    return { error: ready && slug ? "task execution state unavailable" : "", ready };
  }, [entity, ready, slug]);
}

/** One read: the row once the stream has its first snapshot, or a reason within `timeoutMs`. Rejects with a message, as the commands did. */
export function readTaskExecution(repo: string, slug: string, timeoutMs = 3000): Promise<TaskExecutionReply> {
  const { replica, release } = acquireScope(repo, REPO_SCOPE);
  return new Promise<TaskExecutionReply>((resolve, reject) => {
    let off = () => {};
    const done = (finish: () => void) => {
      clearTimeout(timer);
      off();
      release();
      finish();
    };
    const read = () => {
      if (!replica.ready) return;
      const reply = replyOf(replica.get(executionKey(slug)));
      if (reply) done(() => resolve(reply));
      else done(() => reject("task execution state unavailable"));
    };
    const timer = setTimeout(() => done(() => reject(`the daemon for ${repo} did not answer`)), timeoutMs);
    off = replica.listen(read);
    read();
  });
}

export async function readTaskExecutions(refs: readonly ExecutionRead[]): Promise<Array<{ ref: ExecutionRead; execution: TaskExecutionReply | null; error: string }>> {
  return Promise.all(
    refs.map(async (ref) => {
      try {
        return { ref, execution: await readTaskExecution(ref.repoPath, ref.taskSlug), error: "" };
      } catch (error) {
        return { ref, execution: null, error: String(error) };
      }
    }),
  );
}

/** The row changed between what the person saw and the approval: the view should show the newer row and say so. */
export class ExecutionConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionConflict";
  }
}

const reached = (at: Cursor | undefined, applied: Cursor | undefined) => !applied || (!!at && (at.epoch !== applied.epoch || at.seq >= applied.seq));

/** Resolves once `replica` has passed `applied`, or after `timeoutMs`: a read right after a write then shows the change. */
export function whenReaches(replica: Replica, applied: Cursor | undefined, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let off = () => {};
    const done = () => {
      clearTimeout(timer);
      off();
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    off = replica.listen(() => reached(replica.cursor, applied) && done());
    if (reached(replica.cursor, applied)) done();
  });
}

/**
 * Lets one live execution finish. `expectedRevision` is the row the person saw; a row that moved on is refused with
 * `ExecutionConflict`. Resolves once this window's replica has the change.
 */
export async function allowExecutionCompletion(repo: string, slug: string, executionId: string, expectedRevision?: bigint): Promise<void> {
  const { replica, release } = acquireScope(repo, REPO_SCOPE);
  try {
    const client = createClient(ExecutionService, daemonTransport(repo));
    const reply = await client.allowCompletion({ meta: newMutationMeta(), taskSlug: slug, executionId, expectedRevision: expectedRevision ?? 0n });
    await whenReaches(replica, reply.applied?.cursor, 3000);
  } catch (e) {
    const err = ConnectError.from(e);
    if (err.code === Code.Aborted) throw new ExecutionConflict(err.rawMessage);
    throw new Error(err.rawMessage);
  } finally {
    release();
  }
}
