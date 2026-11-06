import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import { Capability, ShutdownOrigin, type AdminService } from "alinery-proto/alinery/v1/admin_pb";
import { capabilitiesOf, requireCapability, type TokenRegistry } from "./auth.ts";

export type DaemonInfo = { protocol: number; buildId: string; repoRoot: string; appConfigIdentity: string };

/** What the daemon does for `Shutdown`: `stop` ends every session and removes the sockets and returns how many sessions it
 * ended; `exit` ends the process. `live` names the sessions whose process is running (`LiveSessions`). */
export type Lifecycle = { stop: () => number; exit: () => void; live?: () => string[] };

// Time for the reply to leave the socket before the process goes.
const EXIT_DELAY_MS = 100;

export function adminService(info: DaemonInfo, lifecycle: Lifecycle, epoch: string, tokens: TokenRegistry): ServiceImpl<typeof AdminService> {
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
    // O20 (c): the shell asks for the token its managed MCP runs with. Only AGENT can be minted, so no credential can be made that
    // holds more than the RPCs behind MCP's tools.
    mintToken: (req, ctx) => {
      requireCapability(ctx, Capability.ADMIN);
      if (req.capability !== Capability.AGENT) throw new ConnectError("only an AGENT token can be minted", Code.InvalidArgument);
      console.error(`agent token minted: label=${JSON.stringify(req.label)}`);
      return { token: tokens.mint(req.label) };
    },
    // What a takeover or a restart would end, for the consent it asks for.
    liveSessions: (_req, ctx) => {
      requireCapability(ctx, Capability.ADMIN);
      return { sessions: (lifecycle.live?.() ?? []).map((id) => ({ id })) };
    },
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
