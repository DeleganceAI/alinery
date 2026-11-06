// The error shapes every mutation RPC shares: a ConnectError that carries the plan's machine-readable
// code as an ErrorDetail, the mutation id check, and the mapping from a domain refusal to a gRPC code.
import { Code, ConnectError } from "@connectrpc/connect";
import { ErrorDetailSchema, type MutationMeta } from "alinery-proto/alinery/v1/common_pb";
import { DomainError } from "../platform/lock.ts";

export const fail = (code: Code, detail: string, message: string) => new ConnectError(message, code, undefined, [{ desc: ErrorDetailSchema, value: { code: detail, message } }]);

/** A mutation without an id could not be deduplicated, so it is refused rather than run twice on a retry. */
export function metaOf(meta: MutationMeta | undefined) {
  if (!meta?.clientId || !meta.mutationId) throw fail(Code.InvalidArgument, "invalid_argument", "a mutation needs meta.client_id and meta.mutation_id");
  return meta;
}

const CODES: Record<string, Code> = {
  invalid_argument: Code.InvalidArgument,
  not_found: Code.NotFound,
  permission_denied: Code.PermissionDenied,
  repo_busy: Code.Unavailable,
  failed_precondition: Code.FailedPrecondition,
};

/** Runs `fn`; a DomainError leaves as its gRPC code (anything else is an Internal error, which Connect does by itself). */
export async function domain<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof DomainError) throw fail(CODES[e.code] ?? Code.Internal, e.code, e.message);
    throw e;
  }
}
