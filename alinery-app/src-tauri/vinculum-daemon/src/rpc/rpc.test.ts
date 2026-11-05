import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect, type Server } from "node:net";
import { join } from "node:path";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { AdminService, Capability, ShutdownOrigin } from "alinery-proto/alinery/v1/admin_pb";
import { ErrorDetailSchema } from "alinery-proto/alinery/v1/common_pb";
import { takeSecretFile } from "./auth.ts";
import { serveRpc } from "./server.ts";

const SECRET = "ab".repeat(32);
const info = { protocol: 25, buildId: "build-1", repoRoot: "/repo", appConfigIdentity: "identity-1" };
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

// A short path: a unix socket's path is limited to about 100 bytes.
async function start(hostExecutable: string | undefined) {
  const dir = mkdtempSync("/tmp/rpc-t-");
  const socketPath = join(dir, "rpc.sock");
  const net: Server = await serveRpc({ socketPath, secret: Buffer.from(SECRET), hostExecutable, info });
  cleanup.push(() => {
    net.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { socketPath, dir };
}

function client(socketPath: string, header?: string) {
  const transport = createGrpcTransport({
    baseUrl: "http://daemon",
    nodeOptions: { createConnection: () => connect(socketPath) } as never,
    interceptors: [
      (next) => (req) => {
        if (header !== undefined) req.header.set("authorization", header);
        return next(req);
      },
    ],
  });
  return createClient(AdminService, transport);
}

const code = async (call: Promise<unknown>) => ConnectError.from(await call.then(() => null, (e) => e)).code;

test("a wrong token is UNAUTHENTICATED, never treated as no token", async () => {
  const { socketPath } = await start(process.execPath);
  for (const header of [`Bearer ${"cd".repeat(32)}`, "Bearer 00", "Bearer ", "Basic abc", "Bearer"]) {
    expect(await code(client(socketPath, header).hello({}))).toBe(Code.Unauthenticated);
  }
});

test("no token is AGENT only: Hello works, any other capability is PERMISSION_DENIED", async () => {
  const { socketPath } = await start(process.execPath);
  const c = client(socketPath);
  expect((await c.hello({})).capabilities).toEqual([Capability.AGENT]);
  const denied = await c.shutdown({ origin: ShutdownOrigin.STOP_DAEMON }).catch((e) => ConnectError.from(e));
  expect((denied as ConnectError).code).toBe(Code.PermissionDenied);
  // The detail travels in grpc-status-details-bin and reads back.
  expect((denied as ConnectError).findDetails(ErrorDetailSchema)[0]?.code).toBe("permission_denied");
});

test("the right token from the expected executable holds VIEW, ACT, APPROVE and ADMIN", async () => {
  // This test process is the peer, so its own executable is the "shell".
  const { socketPath } = await start(process.execPath);
  const c = client(socketPath, `Bearer ${SECRET}`);
  const hello = await c.hello({ clientId: "t", clientKind: "desktop", protocol: 25 });
  expect(hello.capabilities).toEqual([Capability.VIEW, Capability.ACT, Capability.APPROVE, Capability.ADMIN]);
  expect(hello).toMatchObject({ protocol: 25, buildId: "build-1", repoRoot: "/repo", appConfigIdentity: "identity-1" });
  expect(hello.epoch).toMatch(/^[0-9a-f-]{36}$/);
  expect((await client(socketPath, `Bearer ${SECRET}`).hello({})).epoch).toBe(hello.epoch);
  // ADMIN passes the gate; the shutdown itself is S1.4's.
  expect(await code(c.shutdown({ origin: ShutdownOrigin.STOP_DAEMON }))).toBe(Code.Unimplemented);
});

test("the right token from another executable holds VIEW and ACT only", async () => {
  const { socketPath } = await start("/bin/sh");
  const c = client(socketPath, `Bearer ${SECRET}`);
  expect((await c.hello({})).capabilities).toEqual([Capability.VIEW, Capability.ACT]);
  expect(await code(c.shutdown({ origin: ShutdownOrigin.STOP_DAEMON }))).toBe(Code.PermissionDenied);
});

test("a daemon with no host executable (started over ssh) trusts the token alone", async () => {
  const { socketPath } = await start(undefined);
  expect((await client(socketPath, `Bearer ${SECRET}`).hello({})).capabilities).toEqual([
    Capability.VIEW,
    Capability.ACT,
    Capability.APPROVE,
    Capability.ADMIN,
  ]);
});

test("a daemon started without a secret rejects every token", async () => {
  const dir = mkdtempSync("/tmp/rpc-t-");
  const socketPath = join(dir, "rpc.sock");
  const net = await serveRpc({ socketPath, secret: Buffer.alloc(0), hostExecutable: process.execPath, info });
  cleanup.push(() => {
    net.close();
    rmSync(dir, { recursive: true, force: true });
  });
  expect(await code(client(socketPath, "Bearer ").hello({}))).toBe(Code.Unauthenticated);
  expect(await code(client(socketPath, `Bearer ${SECRET}`).hello({}))).toBe(Code.Unauthenticated);
  expect((await client(socketPath).hello({})).capabilities).toEqual([Capability.AGENT]);
});

test("the secret file is read and deleted before the socket exists", async () => {
  const dir = mkdtempSync("/tmp/rpc-t-");
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "rpc.secret");
  writeFileSync(file, `${SECRET}\n`, { mode: 0o600 });
  const secret = takeSecretFile(file);
  expect(existsSync(file)).toBe(false);
  expect(secret.toString()).toBe(SECRET);
  const socketPath = join(dir, "rpc.sock");
  expect(existsSync(socketPath)).toBe(false);
  const net = await serveRpc({ socketPath, secret, hostExecutable: process.execPath, info });
  cleanup.push(() => net.close());
  expect((await client(socketPath, `Bearer ${SECRET}`).hello({})).capabilities).toContain(Capability.ADMIN);
  expect(takeSecretFile(join(dir, "missing")).length).toBe(0);
});

test("the socket is created 0600 whatever the inherited umask, and the umask is put back", async () => {
  const before = process.umask(0);
  cleanup.push(() => process.umask(before));
  const { socketPath } = await start(process.execPath);
  expect(statSync(socketPath).mode & 0o777).toBe(0o600);
  expect(process.umask(0)).toBe(0);
});
