// A task's execution state from the daemon's `execution/<slug>/<slug>` entity: what the shell's observation
// commands answered, and the approval that replaced the shell's allow command. The row is the Rust-shaped state plus the playbook
// definition; the engine behind it is the daemon's.

import type { JsonObject } from "@bufbuild/protobuf";
import { type Client, Code, ConnectError, createClient } from "@connectrpc/connect";
import type { Cursor } from "alinery-proto/alinery/v1/common_pb";
import type { Entity } from "alinery-proto/alinery/v1/entities_pb";
import { ExecutionService } from "alinery-proto/alinery/v1/executions_pb";
import { useMemo, useSyncExternalStore } from "react";
import { daemonTransport } from "../daemon/transport";
import type { NormalizedPlaybook, TaskExecutionReply, TaskExecutionState } from "../types";
import { acquireScope, REPO_SCOPE, useEntity, useLink, useScope } from "./hooks";
import { newMutationMeta } from "./mutation";
import type { Replica } from "./replica";

export const executionKey = (slug: string) => `execution/${slug}/${slug}`;

export type ExecutionRead = { repoPath: string; taskSlug: string };

/**
 * A definition from the row's free-form Struct. The daemon sends `definitionOf`, but a Struct carries
 * only the keys that were filled: a row written by an older build, or one still being written, arrives
 * without `step` or `section_order`. Normalize here, as `definitionOf` (`sync/playbooks.ts`) does for
 * the typed path, so no view has to defend against a half-filled definition.
 */
function definitionOfStruct(d: JsonObject): NormalizedPlaybook {
  const raw = d as Partial<NormalizedPlaybook>;
  return {
    version: raw.version ?? 2,
    key: raw.key ?? "",
    title: raw.title ?? "",
    description: raw.description ?? "",
    default_model: raw.default_model ?? "",
    default_harness: raw.default_harness ?? "",
    step: raw.step ?? [],
    preamble: raw.preamble ?? "",
    section_order: raw.section_order ?? [],
  };
}

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
    definition: definitionOfStruct(row.definition),
    live: { status: "available" },
    revision: e.revision,
  };
}

const NOTHING = () => () => {};

/** The task's execution while this component is mounted. `error` is set once the stream is up and the row is missing. */
export function useTaskExecution(repo: string, slug: string): { reply?: TaskExecutionReply; error: string; ready: boolean } {
  const replica = useScope(repo, REPO_SCOPE);
  const entity = useEntity(replica, executionKey(slug));
  const { stale } = useLink(replica);
  const subscribe = useMemo(() => (replica ? replica.listen : NOTHING), [replica]);
  const ready = useSyncExternalStore(subscribe, () => replica?.ready ?? false);
  return useMemo(() => {
    const reply = replyOf(entity);
    if (reply) {
      if (stale) reply.live = { status: "offline", detail: "The daemon disconnected. Showing the last known execution." };
      return { reply, error: "", ready };
    }
    return { error: ready && slug ? "task execution state unavailable" : "", ready };
  }, [entity, ready, slug, stale]);
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
 * Accepts the work the person reviewed in this session. An unrelated change to the task's entity
 * does not invalidate the review. New work or an owner change does.
 */
export function continueReviewed(repo: string, slug: string, executionId: string, sessionId: string, workRevision: number): Promise<void> {
  return writeExecution(repo, (client) => client.continueReviewed({ meta: newMutationMeta(), taskSlug: slug, executionId, sessionId, workRevision: BigInt(workRevision) }));
}

export function setStepContinuation(repo: string, slug: string, stepKey: string, automatic: boolean, expectedRevision: bigint): Promise<void> {
  return writeExecution(repo, (client) => client.setStepContinuation({ meta: newMutationMeta(), taskSlug: slug, stepKey, automatic, expectedRevision }));
}

async function writeExecution(repo: string, write: (client: Client<typeof ExecutionService>) => Promise<{ applied?: { cursor?: Cursor } }>): Promise<void> {
  const { replica, release } = acquireScope(repo, REPO_SCOPE);
  try {
    const client = createClient(ExecutionService, daemonTransport(repo));
    const reply = await write(client);
    await whenReaches(replica, reply.applied?.cursor, 3000);
  } catch (e) {
    const err = ConnectError.from(e);
    if (err.code === Code.Aborted) throw new ExecutionConflict(err.rawMessage);
    throw new Error(err.rawMessage);
  } finally {
    release();
  }
}
