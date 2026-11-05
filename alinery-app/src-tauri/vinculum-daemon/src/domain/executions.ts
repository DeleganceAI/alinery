// The execution entity (plan 2.2.8 feed 4, S2.4). It is what `getTaskExecution` returns, so the RPC
// read and the delta cannot differ: both come from that one builder.
import { create, fromJson, type JsonObject } from "@bufbuild/protobuf";
import { StructSchema } from "@bufbuild/protobuf/wkt";
import { EntitySchema } from "alinery-proto/alinery/v1/entities_pb";
import { getTaskExecution } from "../tasks.ts";
import type { Store } from "../sync/store.ts";

export const executionKey = (slug: string) => `execution/${slug}/${slug}`;

/** Commits the task's current execution state. A task with no readable state loses its row. */
export function commitExecution(store: Store, repo: string, slug: string, lane: string, appIdentity: string): void {
  const reply = getTaskExecution(repo, slug, lane, appIdentity);
  if (reply.error !== undefined) {
    store.commit([], [executionKey(slug)]);
    return;
  }
  const struct = (v: unknown) => fromJson(StructSchema, v as JsonObject);
  store.commit([create(EntitySchema, { key: executionKey(slug), value: { case: "execution", value: { slug, state: struct(reply.state), definition: struct(reply.definition) } } })]);
}
