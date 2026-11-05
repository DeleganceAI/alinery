import { randomUUID } from "node:crypto";
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import { Capability, ShutdownOrigin, type AdminService } from "alinery-proto/alinery/v1/admin_pb";
import { capabilitiesOf, requireCapability } from "./auth.ts";

export type DaemonInfo = { protocol: number; buildId: string; repoRoot: string; appConfigIdentity: string };

/** What the daemon does for `Shutdown`: `stop` ends every session and removes the sockets (the same
 * teardown as the JSON `shutdown` op) and returns how many sessions it ended; `exit` ends the process. */
export type Lifecycle = { stop: () => number; exit: () => void };

// Time for the reply to leave the socket before the process goes.
const EXIT_DELAY_MS = 100;

// The epoch is a random id per daemon start until the store (S2.1) owns it.
export function adminService(info: DaemonInfo, lifecycle: Lifecycle): ServiceImpl<typeof AdminService> {
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
    // Invariant 1: the five origins are the only ways to stop a daemon, so an unnamed one is refused
    // before anything stops. A takeover also names the confirmation the app consumed for it; the
    // daemon cannot check that against the app's store, so it requires only that there is one.
    shutdown: (req, ctx) => {
      requireCapability(ctx, Capability.ADMIN);
      const origin = ShutdownOrigin[req.origin];
      if (origin === undefined || req.origin === ShutdownOrigin.UNSPECIFIED) {
        throw new ConnectError("Shutdown needs one of the five origins", Code.InvalidArgument);
      }
      if (req.origin === ShutdownOrigin.CONFIRMED_TAKEOVER && req.confirmationId === "") {
        throw new ConnectError("a takeover shutdown needs its confirmation_id", Code.InvalidArgument);
      }
      console.error(`shutdown requested: origin=${origin}${req.confirmationId ? ` confirmation=${req.confirmationId}` : ""}`);
      const sessionsStopped = lifecycle.stop();
      setTimeout(lifecycle.exit, EXIT_DELAY_MS);
      return { sessionsStopped };
    },
  };
}
