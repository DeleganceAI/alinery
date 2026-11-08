// What every mutation carries so the daemon can tell a retry from a second change (plan 2.2.7): this window's client id,
// and an id that is new for each call.
import { create } from "@bufbuild/protobuf";
import { type MutationMeta, MutationMetaSchema } from "alinery-proto/alinery/v1/common_pb";

const clientId = crypto.randomUUID();

export const newMutationMeta = (): MutationMeta => create(MutationMetaSchema, { clientId, mutationId: crypto.randomUUID() });
