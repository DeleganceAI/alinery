// The execution entity (plan 2.2.8 feed 4, S2.4). It is what `getTaskExecution` returns, so the RPC
// read and the delta cannot differ: both come from that one builder.
import { create, type JsonObject } from "@bufbuild/protobuf";
import { type Entity, EntitySchema } from "alinery-proto/alinery/v1/entities_pb";
import type { Parser } from "../sync/parsers/index.ts";
import { getTaskExecution } from "../tasks.ts";
import type { Store } from "../sync/store.ts";

export const executionKey = (slug: string) => `execution/${slug}/${slug}`;

/** The task's execution row as `getTaskExecution` answers it; undefined for a task with no readable state. */
export function executionEntity(repo: string, slug: string, lane: string, appIdentity: string): Entity | undefined {
  const reply = getTaskExecution(repo, slug, lane, appIdentity);
  if (reply.error !== undefined) return undefined;
  // The generated fields are `JsonObject`: the runtime does the Struct conversion. A `fromJson(StructSchema, …)` here
  // is a message, which the runtime then encodes as JSON, so clients received `{ $typeName, fields }`.
  const json = (v: unknown) => v as JsonObject;
  return create(EntitySchema, { key: executionKey(slug), value: { case: "execution", value: { slug, state: json(reply.state), definition: json(reply.definition) } } });
}

/** Commits the task's current execution state. A task with no readable state loses its row. */
export function commitExecution(store: Store, repo: string, slug: string, lane: string, appIdentity: string): void {
  const entity = executionEntity(repo, slug, lane, appIdentity);
  if (entity) store.commit([entity]);
  else store.commit([], [executionKey(slug)]);
}

/** The feed's parser for `execution.json`, so a Rust writer or a restart reaches the store as well as an engine event. */
export function executionParser(repo: string, lane: string, appIdentity: string): Parser {
  return {
    match: /^tasks\/([^/]+)\/execution\.json$/,
    key: (m) => executionKey(m[1]),
    parse: async (_abs, m) => executionEntity(repo, m[1], lane, appIdentity) ?? null,
  };
}
