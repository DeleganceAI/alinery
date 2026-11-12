import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect, type Server } from "node:net";
import { join } from "node:path";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { AdminService, Capability, ShutdownOrigin } from "alinery-proto/alinery/v1/admin_pb";
import { ErrorDetailSchema } from "alinery-proto/alinery/v1/common_pb";
import { type Job, JobKind, JobState } from "alinery-proto/alinery/v1/entities_pb";
import { takeSecretFile, TokenRegistry } from "./auth.ts";
import { JobRunner } from "../jobs/runner.ts";
import { Store } from "../sync/store.ts";
import { serveRpc } from "./server.ts";

const storageScan = { repo: "/repo", appConfig: "/app", namespace: "" };
const SECRET = "ab".repeat(32);
const info = { protocol: 25, buildId: "build-1", repoRoot: "/repo", appConfigIdentity: "identity-1", version: "9.8.7" };
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
  live: () => ["s1", "s2"],
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
  const tokens = new TokenRegistry();
  const net: Server = await serveRpc({ socketPath, secret: Buffer.from(SECRET), tokens, hostExecutable, info, lifecycle, store, jobs: new JobRunner(store), storageScan, transcripts: async () => undefined });
  cleanup.push(() => {
    net.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { socketPath, dir, store, tokens };
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

test("no token is UNAUTHENTICATED, and a minted token is AGENT only: Hello works, Shutdown is PERMISSION_DENIED", async () => {
  const { socketPath, tokens } = await start(process.execPath);
  expect(await code(client(socketPath).hello({}))).toBe(Code.Unauthenticated);
  const c = client(socketPath, `Bearer ${tokens.mint("test")}`);
  expect((await c.hello({})).capabilities).toEqual([Capability.AGENT]);
  const denied = await c.shutdown({ origin: ShutdownOrigin.STOP_DAEMON }).catch((e) => ConnectError.from(e));
  expect((denied as ConnectError).code).toBe(Code.PermissionDenied);
  // The detail travels in grpc-status-details-bin and reads back.
  expect((denied as ConnectError).findDetails(ErrorDetailSchema)[0]?.code).toBe("permission_denied");
  expect(events).toEqual([]);
});

test("MintToken (O20 c) gives the shell an AGENT token, refuses any other capability and needs ADMIN", async () => {
  const { socketPath, tokens } = await start(process.execPath);
  const shell = client(socketPath, `Bearer ${SECRET}`);
  const { token } = await shell.mintToken({ capability: Capability.AGENT, label: "managed-mcp" });
  expect(tokens.has(token)).toBe(true);
  expect((await client(socketPath, `Bearer ${token}`).hello({})).capabilities).toEqual([Capability.AGENT]);
  // A second mint under the label keeps the first for one more refresh (a call mid-flight), and a third retires it.
  const again = (await shell.mintToken({ capability: Capability.AGENT, label: "managed-mcp" })).token;
  expect((await client(socketPath, `Bearer ${token}`).hello({})).capabilities).toEqual([Capability.AGENT]);
  await shell.mintToken({ capability: Capability.AGENT, label: "managed-mcp" });
  expect(await code(client(socketPath, `Bearer ${token}`).hello({}))).toBe(Code.Unauthenticated);
  expect((await client(socketPath, `Bearer ${again}`).hello({})).capabilities).toEqual([Capability.AGENT]);
  expect(await code(shell.mintToken({ capability: Capability.ADMIN, label: "x" }))).toBe(Code.InvalidArgument);
  // An AGENT token cannot mint another, nor can a peer that is not the shell.
  expect(await code(client(socketPath, `Bearer ${again}`).mintToken({ capability: Capability.AGENT, label: "y" }))).toBe(Code.PermissionDenied);
});

test("the right token from the expected executable holds VIEW, ACT, APPROVE and ADMIN", async () => {
  // This test process is the peer, so its own executable is the "shell".
  const { socketPath, store } = await start(process.execPath);
  const c = client(socketPath, `Bearer ${SECRET}`);
  const hello = await c.hello({ clientId: "t", clientKind: "desktop", protocol: 25 });
  expect(hello.capabilities).toEqual([Capability.VIEW, Capability.ACT, Capability.APPROVE, Capability.ADMIN]);
  expect(hello).toMatchObject({ protocol: 25, buildId: "build-1", repoRoot: "/repo", appConfigIdentity: "identity-1", version: "9.8.7" });
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

test("a daemon started without a secret rejects every token, and no token", async () => {
  const dir = mkdtempSync("/tmp/rpc-t-");
  const socketPath = join(dir, "rpc.sock");
  const net = await serveRpc({ socketPath, secret: Buffer.alloc(0), hostExecutable: process.execPath, info, lifecycle, store: new Store() });
  cleanup.push(() => {
    net.close();
    rmSync(dir, { recursive: true, force: true });
  });
  expect(await code(client(socketPath, "Bearer ").hello({}))).toBe(Code.Unauthenticated);
  expect(await code(client(socketPath, `Bearer ${SECRET}`).hello({}))).toBe(Code.Unauthenticated);
  expect(await code(client(socketPath).hello({}))).toBe(Code.Unauthenticated);
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

test("Shutdown mid-job: the job ends CANCELLED and its child process is gone before the exit runs", async () => {
  const dir = mkdtempSync("/tmp/rpc-j-");
  const socketPath = join(dir, "rpc.sock");
  const store = new Store();
  const jobs = new JobRunner(store, { command: () => [process.execPath, join(import.meta.dir, "../jobs/fake-child.ts")] });
  // The same two steps main.ts runs: stopAll with the teardown, drain before the exit.
  const exited = new Promise<void>((resolve) => {
    const stop = () => {
      jobs.stopAll();
      return 0;
    };
    void serveRpc({ socketPath, secret: Buffer.from(SECRET), hostExecutable: process.execPath, info, lifecycle: { stop, exit: () => void jobs.drain(1000).then(resolve) }, store, jobs, storageScan, transcripts: async () => undefined }).then((net) => {
      cleanup.push(() => {
        net.close();
        rmSync(dir, { recursive: true, force: true });
      });
    });
  });
  while (!existsSync(socketPath)) await new Promise((resolve) => setTimeout(resolve, 10));
  const id = jobs.start(JobKind.BACKUP, { mode: "hang" });
  let pid = 0;
  for (let i = 0; i < 300 && !pid; i++) {
    pid = Number(/pid (\d+)/.exec((store.get(`job/_/${id}`)?.value.value as Job | undefined)?.progress?.label ?? "")?.[1] ?? 0);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(pid).toBeGreaterThan(0);
  await client(socketPath, `Bearer ${SECRET}`).shutdown({ origin: ShutdownOrigin.STOP_DAEMON });
  await exited;
  expect(() => process.kill(pid, 0)).toThrow();
  expect((store.get(`job/_/${id}`)?.value.value as Job).state).toBe(JobState.CANCELLED);
});

test("no token and a non-shell token cannot shut the daemon down", async () => {
  const { socketPath } = await start("/bin/sh");
  expect(await code(client(socketPath, undefined).shutdown({ origin: ShutdownOrigin.STOP_DAEMON }))).toBe(Code.Unauthenticated);
  expect(await code(client(socketPath, `Bearer ${SECRET}`).shutdown({ origin: ShutdownOrigin.STOP_DAEMON }))).toBe(Code.PermissionDenied);
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(events).toEqual([]);
});

test("LiveSessions names the running sessions and needs ADMIN", async () => {
  const shell = await start(process.execPath);
  expect((await client(shell.socketPath, `Bearer ${SECRET}`).liveSessions({})).sessions.map((s) => s.id)).toEqual(["s1", "s2"]);
  const other = await start("/bin/sh");
  expect(await code(client(other.socketPath, `Bearer ${SECRET}`).liveSessions({}))).toBe(Code.PermissionDenied);
});
