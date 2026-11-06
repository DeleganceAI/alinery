// A real daemon (`bun src/main.ts`) on a fixture repository, and an AGENT token minted for it the way the shell mints one. The MCP tests
// run against this, so a reply is the daemon's and not a stub's.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { AdminService, Capability } from "alinery-proto/alinery/v1/admin_pb";
import { Endpoints } from "./endpoints.ts";
import type { Context } from "./handlers.ts";
import { buildFixture, type Fixture } from "./fixtureRepo.testutil.ts";

const MAIN = join(import.meta.dir, "..", "main.ts");
export const SECRET = "ab".repeat(32);

/** The protocol the daemon source under test speaks, as `--protocol-version` prints it. */
export const daemonProtocol = (): number => Number(Bun.spawnSync([process.execPath, MAIN, "--protocol-version"]).stdout.toString().trim());

export type RunningDaemon = { fixture: Fixture; process: Bun.Subprocess; socket: string; token: string; stop: () => Promise<void>; context: (extra?: Partial<Context>) => Context };

export async function startDaemon(fixture?: Fixture, protocol = daemonProtocol()): Promise<RunningDaemon> {
  const fx = fixture ?? (await buildFixture());
  const secretFile = join(fx.root, "rpc-secret");
  writeFileSync(secretFile, SECRET, { mode: 0o600 });
  mkdirSync(join(fx.repo, ".alinery"), { recursive: true });
  const proc = Bun.spawn([process.execPath, MAIN, "--repo", fx.repo, "--app-config", fx.appConfig, "--rpc-secret-file", secretFile], { stdout: "ignore", stderr: "ignore", env: { ...process.env, ALINERY_HOST_EXECUTABLE: undefined } });
  const socket = join(fx.repo, ".alinery", "rpc.sock");
  const transport = (token: string) =>
    createGrpcTransport({
      baseUrl: "http://daemon",
      nodeOptions: { createConnection: () => connect(socket) } as never,
      interceptors: [
        (next) => (req) => {
          req.header.set("authorization", `Bearer ${token}`);
          return next(req);
        },
      ],
    });
  const admin = createClient(AdminService, transport(SECRET));
  const end = Date.now() + 30_000;
  for (;;) {
    try {
      if (existsSync(socket)) {
        await admin.hello({});
        break;
      }
    } catch {
      /* not listening yet */
    }
    if (Date.now() > end) throw new Error("the daemon did not start");
    await Bun.sleep(100);
  }
  const { token } = await admin.mintToken({ capability: Capability.AGENT, label: "test-mcp" });
  return {
    fixture: fx,
    process: proc,
    socket,
    token,
    stop: async () => {
      proc.kill("SIGTERM");
      await proc.exited;
    },
    context: (extra = {}) => ({ protocol, processRepo: fx.repo, appConfig: fx.appConfig, endpoints: new Endpoints({ repo: fx.repo, endpoint: { socket, token } }, undefined), ...extra }),
  };
}
