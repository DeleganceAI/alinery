// A real connect router in memory for tests that read through src/sync (plan 2.5): the test serves
// the daemon's services, a Replica or hook talks to them over `transport`, and nothing is canned
// on the client side.
import { create } from "@bufbuild/protobuf";
import { createRouterTransport, type ServiceImpl } from "@connectrpc/connect";
import { type Cursor, CursorSchema } from "alinery-proto/alinery/v1/common_pb";
import { type Entity, EntitySchema } from "alinery-proto/alinery/v1/entities_pb";
import { type SubscribeRequest, type SubscribeResponse, SubscribeResponseSchema, SyncService } from "alinery-proto/alinery/v1/sync_pb";

export type Services = { sync: ServiceImpl<typeof SyncService> };

export function daemonHarness(services: Partial<Services>) {
  const transport = createRouterTransport((router) => {
    if (services.sync) router.service(SyncService, services.sync);
  });
  return { transport };
}

export const cursor = (seq: number, epoch = "e1"): Cursor => create(CursorSchema, { epoch, seq: BigInt(seq) });
export const frame = (f: SubscribeResponse["frame"]): SubscribeResponse => create(SubscribeResponseSchema, { frame: f });
export const snapshot = (entities: Entity[], seq: number): SubscribeResponse => frame({ case: "snapshot", value: { entities, cursor: cursor(seq), complete: true } as never });
export const put = (e: Entity, seq: number): SubscribeResponse => frame({ case: "delta", value: { changes: [{ op: { case: "put", value: e } }], cursor: cursor(seq) } as never });
export const entity = (key: string, value: Entity["value"]): Entity => create(EntitySchema, { key, value });

/** A fake daemon sync service: each Subscribe call runs `script(request, callIndex)` and yields what it yields; throwing ends the stream with an error. */
export function scriptedSync(script: (req: SubscribeRequest, call: number, signal: AbortSignal) => AsyncGenerator<SubscribeResponse>) {
  const requests: SubscribeRequest[] = [];
  const sync: ServiceImpl<typeof SyncService> = {
    async *subscribe(req, ctx) {
      requests.push(req);
      yield* script(req, requests.length - 1, ctx.signal);
    },
  };
  return { sync, requests };
}

/** Resolves when the client cancels the call. */
export const untilAborted = (signal: AbortSignal) => new Promise<void>((r) => (signal.aborted ? r() : signal.addEventListener("abort", () => r(), { once: true })));
