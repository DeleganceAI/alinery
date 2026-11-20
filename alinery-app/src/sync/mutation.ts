// What every mutation carries so the daemon can tell a retry from a second change: this window's client id,
// and an id that is new for each call.
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { type MutationMeta, MutationMetaSchema } from "alinery-proto/alinery/v1/common_pb";

const clientId = crypto.randomUUID();

export const newMutationMeta = (): MutationMeta => create(MutationMetaSchema, { clientId, mutationId: crypto.randomUUID() });

export class UnconfirmedDelivery extends Error {
  constructor(
    action: "retry" | "nudge",
    readonly checkDelivery: () => Promise<void>,
  ) {
    super(`The daemon has not confirmed this ${action}.`);
  }
}

/** Every attempt calls the same request, including its original mutation id and turn. */
export async function confirmDelivery(action: "retry" | "nudge", request: () => Promise<unknown>): Promise<void> {
  const deliver = async () => {
    try {
      await request();
    } catch (cause) {
      const error = ConnectError.from(cause);
      if ([Code.Unavailable, Code.Unknown, Code.DeadlineExceeded, Code.Canceled].includes(error.code)) throw new UnconfirmedDelivery(action, deliver);
      throw new Error(error.rawMessage || `The daemon refused this ${action}.`);
    }
  };
  try {
    await deliver();
  } catch (cause) {
    if (!(cause instanceof UnconfirmedDelivery)) throw cause;
    await cause.checkDelivery();
  }
}
