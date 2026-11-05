import { randomUUID } from "node:crypto";
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import { Capability, type AdminService } from "alinery-proto/alinery/v1/admin_pb";
import { capabilitiesOf, requireCapability } from "./auth.ts";

export type DaemonInfo = { protocol: number; buildId: string; repoRoot: string; appConfigIdentity: string };

// The epoch is a random id per daemon start until the store (S2.1) owns it.
export function adminService(info: DaemonInfo): ServiceImpl<typeof AdminService> {
  const epoch = randomUUID();
  return {
    // Needs any one capability, which every credential that passes auth holds, so it is also the
    // liveness probe.
    hello: (_req, ctx) => ({
      protocol: info.protocol,
      buildId: info.buildId,
      epoch,
      capabilities: [...capabilitiesOf(ctx)].sort((a, b) => a - b),
      repoRoot: info.repoRoot,
      appConfigIdentity: info.appConfigIdentity,
    }),
    // The capability gate is real; the shutdown itself still goes through the JSON op until S1.4.
    shutdown: (_req, ctx) => {
      requireCapability(ctx, Capability.ADMIN);
      throw new ConnectError("Shutdown over RPC arrives with S1.4; use the daemon's shutdown op", Code.Unimplemented);
    },
  };
}
