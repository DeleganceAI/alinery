import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect, type Server } from "node:net";
import { join } from "node:path";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { AdminService, Capability, ShutdownOrigin } from "alinery-proto/alinery/v1/admin_pb";
import { ErrorDetailSchema } from "alinery-proto/alinery/v1/common_pb";
import { takeSecretFile } from "./auth.ts";
import { Store } from "../sync/store.ts";
import { serveRpc } from "./server.ts";

const SECRET = "ab".repeat(32);
const info = { protocol: 25, buildId: "build-1", repoRoot: "/repo", appConfigIdentity: "identity-1" };
const cleanup: Array<() => void> = [];
// What the daemon would do on Shutdown, recorded instead of done.
const events: string[] = [];
const lifecycle = {
  stop: () => {
    events.push("stop");
    return 3;
  },
  exit: () => {
    events.push("exit");
  },
};
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
  events.length = 0;
});

// A short path: a unix socket's path is limited to about 100 bytes.
async function start(hostExecutable: string | undefined) {
  const dir = mkdtempSync("/tmp/rpc-t-");
  const socketPath = join(dir, "rpc.sock");
  const store = new Store();
  const net: Server = await serveRpc({ socketPath, secret: Buffer.from(SECRET), hostExecutable, info, lifecycle, store });
  cleanup.push(() => {
    net.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { socketPath, dir, store };
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
  expect(events).toEqual([]);
});

test("the right token from the expected executable holds VIEW, ACT, APPROVE and ADMIN", async () => {
  // This test process is the peer, so its own executable is the "shell".
  const { socketPath, store } = await start(process.execPath);
  const c = client(socketPath, `Bearer ${SECRET}`);
  const hello = await c.hello({ clientId: "t", clientKind: "desktop", protocol: 25 });
  expect(hello.capabilities).toEqual([Capability.VIEW, Capability.ACT, Capability.APPROVE, Capability.ADMIN]);
  expect(hello).toMatchObject({ protocol: 25, buildId: "build-1", repoRoot: "/repo", appConfigIdentity: "identity-1" });
  expect(hello.epoch).toMatch(/^[0-9a-f-]{36}$/);
  expect(hello.epoch).toBe(store.epoch);
  expect((await client(socketPath, `Bearer ${SECRET}`).hello({})).epoch).toBe(hello.epoch);
});

test("the right token from another executable holds VIEW and ACT only", async () => {
  const { socketPath } = await start("/bin/sh");
  const c = client(socketPath, `Bearer ${SECRET}`);
  expect((await c.hello({})).capabilities).toEqual([Capability.VIEW, Capability.ACT]);
  expect(await code(c.shutdown({ origin: ShutdownOrigin.STOP_DAEMON }))).toBe(Code.PermissionDenied);
  expect(events).toEqual([]);
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
  const net = await serveRpc({ socketPath, secret: Buffer.alloc(0), hostExecutable: process.execPath, info, lifecycle, store: new Store() });
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
  const net = await serveRpc({ socketPath, secret, hostExecutable: process.execPath, info, lifecycle, store: new Store() });
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

const ORIGINS = [
  ShutdownOrigin.STOP_DAEMON,
  ShutdownOrigin.CLOSE_REPO,
  ShutdownOrigin.RESTORE_BACKUP,
  ShutdownOrigin.CONFIRMED_TAKEOVER,
  ShutdownOrigin.STOP_REMOTE,
];

test("each of the five origins stops the daemon, answers with the sessions it ended, then exits", async () => {
  for (const origin of ORIGINS) {
    events.length = 0;
    const { socketPath } = await start(process.execPath);
    const reply = await client(socketPath, `Bearer ${SECRET}`).shutdown({ origin, confirmationId: "confirm-1" });
    expect(reply.sessionsStopped).toBe(3);
    // The teardown ran before the reply; the exit comes after it, so the reply was not cut off.
    expect(events).toEqual(["stop"]);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(events).toEqual(["stop", "exit"]);
  }
});

test("UNSPECIFIED and an origin the proto does not know are INVALID_ARGUMENT, and nothing stops", async () => {
  const { socketPath } = await start(process.execPath);
  const c = client(socketPath, `Bearer ${SECRET}`);
  expect(await code(c.shutdown({ origin: ShutdownOrigin.UNSPECIFIED }))).toBe(Code.InvalidArgument);
  expect(await code(c.shutdown({}))).toBe(Code.InvalidArgument);
  expect(await code(c.shutdown({ origin: 99 as ShutdownOrigin }))).toBe(Code.InvalidArgument);
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(events).toEqual([]);
});

test("a takeover shutdown needs its confirmation_id; the other origins do not", async () => {
  const { socketPath } = await start(process.execPath);
  const c = client(socketPath, `Bearer ${SECRET}`);
  expect(await code(c.shutdown({ origin: ShutdownOrigin.CONFIRMED_TAKEOVER }))).toBe(Code.InvalidArgument);
  expect(events).toEqual([]);
  expect((await c.shutdown({ origin: ShutdownOrigin.CONFIRMED_TAKEOVER, confirmationId: "c" })).sessionsStopped).toBe(3);
  await new Promise((resolve) => setTimeout(resolve, 250)); // let its exit timer fire inside this test
});

test("no token and a non-shell token cannot shut the daemon down", async () => {
  const { socketPath } = await start("/bin/sh");
  for (const header of [undefined, `Bearer ${SECRET}`]) {
    expect(await code(client(socketPath, header).shutdown({ origin: ShutdownOrigin.STOP_DAEMON }))).toBe(Code.PermissionDenied);
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(events).toEqual([]);
});
