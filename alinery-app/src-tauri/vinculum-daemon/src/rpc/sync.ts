import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import { Capability } from "alinery-proto/alinery/v1/admin_pb";
import type { SyncService } from "alinery-proto/alinery/v1/sync_pb";
import type { Store } from "../sync/store.ts";
import { requireCapability } from "./auth.ts";

export function syncService(store: Store): ServiceImpl<typeof SyncService> {
  return {
    async *subscribe(req, ctx) {
      requireCapability(ctx, Capability.VIEW);
      if (!req.scope || req.scope.kind.case === undefined) throw new ConnectError("Subscribe needs a scope", Code.InvalidArgument);
      yield* store.open(req.scope, req.cursor, ctx.signal);
    },
  };
}
