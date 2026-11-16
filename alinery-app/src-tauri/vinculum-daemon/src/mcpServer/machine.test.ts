// The machine MCP on real sockets and real processes: the singleton, the idle exit, registration and re-registration, a daemon of
// another protocol, the stdio bridge, the optional token with its rotation overlap, and McpService being the app's alone.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { connect } from "node:net";
import { McpService, McpTokenAction } from "alinery-proto/alinery/v1/mcp_pb";
import { MachineLink, rotateToken } from "../domain/machineMcp.ts";
import { daemonProtocol, type RunningDaemon, SECRET, startDaemon } from "./daemonFixture.testutil.ts";
import { acceptedTokens, answers, ask, machinePaths, machineUnit } from "./machine.ts";

const SERVE = join(import.meta.dir, "machineServe.testutil.ts");
const MAIN = join(import.meta.dir, "..", "main.ts");

let daemon: RunningDaemon;
beforeAll(async () => {
  daemon = await startDaemon();
}, 60_000);
afterAll(async () => {
  await daemon?.stop();
  if (daemon) rmSync(daemon.fixture.root, { recursive: true, force: true });
});

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "mmcp-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, paths: machinePaths(dir) };
}

function serve(dir: string, protocol = daemonProtocol(), idleMs = 0) {
  const proc = Bun.spawn([process.execPath, SERVE, dir, String(protocol), String(idleMs)], { stdout: "ignore", stderr: "pipe" });
  cleanup.push(() => {
    proc.kill("SIGKILL");
  });
  return proc;
}

const until = async (ok: () => boolean | Promise<boolean>, what: string, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok()) return;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
};

const link = (paths: ReturnType<typeof machinePaths>, dir: string, protocol = daemonProtocol()) => {
  const made = new MachineLink({
    paths,
    repo: daemon.fixture.repo,
    rpcSocket: daemon.socket,
    protocol,
    build: "test-build",
    mint: () => daemon.token,
    spawn: () => serve(dir, daemonProtocol()),
  });
  cleanup.push(() => made.stop());
  return made;
};

test("two starters race for one lane: one binds, the other leaves at once with 0, and the socket is owner-only", async () => {
  const { dir, paths } = scratch();
  const [a, b] = [serve(dir), serve(dir)];
  const first = await Promise.race([a.exited.then(() => "a"), b.exited.then(() => "b")]);
  expect(await (first === "a" ? a : b).exited).toBe(0);
  await until(() => answers(paths.socket), "the winner to listen");
  const status = await ask(paths.socket, { op: "status" });
  expect(status).toMatchObject({ ok: true, protocol: daemonProtocol(), build: "test-build", daemons: [] });
  expect(statSync(paths.socket).mode & 0o077).toBe(0);
});

test("with no daemon registered it exits after the idle time and removes its socket; a registered daemon keeps it", async () => {
  const { dir, paths } = scratch();
  const idle = serve(dir, daemonProtocol(), 300);
  expect(await idle.exited).toBe(0);
  expect(await answers(paths.socket)).toBe(false);

  const kept = serve(dir, daemonProtocol(), 300);
  await until(() => answers(paths.socket), "it to listen");
  const l = link(paths, dir);
  l.start();
  await until(async () => ((await ask(paths.socket, { op: "status" })).daemons as unknown[]).length === 1, "the registration");
  await Bun.sleep(600);
  expect(kept.exitCode).toBeNull();
});

test("a registered daemon is reachable through the socket's tools, and registers again after Restart", async () => {
  const { dir, paths } = scratch();
  serve(dir);
  await until(() => answers(paths.socket), "it to listen");
  const l = link(paths, dir);
  l.start();
  await until(async () => (await l.status()).daemons.length === 1, "the registration");
  const reply = await ask(paths.socket, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "alinery_list_tasks", arguments: { repo: daemon.fixture.repo } } }, undefined, 10_000);
  expect(JSON.stringify(reply)).toContain("first-task");

  const before = (await l.status()).uptimeMs;
  const after = await l.restart();
  expect(after.state).toBe("ok");
  await until(async () => (await l.status()).daemons.length === 1, "the registration after the restart");
  expect((await l.status()).uptimeMs).toBeLessThan(before + 5_000);
});

test("a daemon of another protocol is listed incompatible and its tools are refused, never called", async () => {
  const { dir, paths } = scratch();
  serve(dir, daemonProtocol() + 1);
  await until(() => answers(paths.socket), "it to listen");
  const l = link(paths, dir);
  l.start();
  await until(async () => (await l.status()).daemons.length === 1, "the registration");
  const status = await l.status();
  expect(status.state).toBe("behind");
  expect(status.daemons[0].compatible).toBe(false);
  const reply = await ask(paths.socket, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "alinery_list_tasks", arguments: { repo: daemon.fixture.repo } } }, undefined, 10_000);
  expect(JSON.stringify(reply)).toContain("repo-protocol-mismatch");
});

test("the stdio bridge pipes a client to the machine MCP, and refuses one of another protocol naming Restart MCP", async () => {
  const { dir, paths } = scratch();
  writeFileSync(join(dir, "app.toml"), "");
  serve(dir);
  await until(() => answers(paths.socket), "it to listen");
  const l = link(paths, dir);
  l.start();
  await until(async () => (await l.status()).daemons.length === 1, "the registration");
  const bridge = Bun.spawn([process.execPath, MAIN, "--mcp", "--bridge", "--app-config", join(dir, "app.toml")], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  bridge.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "alinery_list_repos", arguments: {} } })}\n`);
  bridge.stdin.flush();
  const reader = bridge.stdout.getReader();
  const { value } = await reader.read();
  expect(new TextDecoder().decode(value)).toContain(daemon.fixture.repo);
  bridge.stdin.end();
  await bridge.exited;

  const other = scratch();
  writeFileSync(join(other.dir, "app.toml"), "");
  serve(other.dir, daemonProtocol() + 1);
  await until(() => answers(other.paths.socket), "the other to listen");
  const refused = Bun.spawn([process.execPath, MAIN, "--mcp", "--bridge", "--app-config", join(other.dir, "app.toml")], { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
  expect(await refused.exited).toBe(1);
  expect(await new Response(refused.stderr).text()).toContain("Restart MCP");
});

test("with a key file every caller presents the token: none or a wrong one is refused, the previous one works during the overlap", async () => {
  const { dir, paths } = scratch();
  serve(dir);
  await until(() => answers(paths.socket), "it to listen");
  expect(acceptedTokens(paths.key)).toBeNull();
  const first = rotateToken(paths.key);
  expect(await ask(paths.socket, { op: "status" })).toMatchObject({ ok: false });
  expect(await ask(paths.socket, { op: "status" }, "nope")).toMatchObject({ ok: false, error: "wrong token for this MCP" });
  expect(await ask(paths.socket, { op: "status" }, first)).toMatchObject({ ok: true });
  const second = rotateToken(paths.key);
  expect(await ask(paths.socket, { op: "status" }, first)).toMatchObject({ ok: true });
  expect(await ask(paths.socket, { op: "status" }, second)).toMatchObject({ ok: true });
  expect(acceptedTokens(paths.key, Date.now() + 11 * 60_000)).toEqual([second]);
  writeFileSync(paths.key, "not json");
  expect(acceptedTokens(paths.key)).toEqual([]);
});

test("McpService is the app's alone: it is not an agent RPC, and an AGENT token is refused", async () => {
  const { AGENT_RPCS } = await import("../rpc/auth.ts");
  expect([...AGENT_RPCS.keys()].some((rpc) => rpc.startsWith("alinery.v1.McpService/"))).toBe(false);
  const client = (token: string) =>
    createClient(
      McpService,
      createGrpcTransport({
        baseUrl: "http://daemon",
        nodeOptions: { createConnection: () => connect(daemon.socket) } as never,
        interceptors: [
          (next) => (req) => {
            req.header.set("authorization", `Bearer ${token}`);
            return next(req);
          },
        ],
      }),
    );
  await expect(client(daemon.token).token({ action: McpTokenAction.READ })).rejects.toThrow(/ADMIN/);
  expect((await client(SECRET).token({ action: McpTokenAction.READ })).token).toBe("");
});

test("each app-config directory and lane gets its own systemd unit name, valid as a unit name", () => {
  const units = [machinePaths("/home/a/cfg1"), machinePaths("/home/a/cfg2"), machinePaths("/home/a/cfg1", "dev")].map(machineUnit);
  expect(new Set(units).size).toBe(3);
  for (const unit of units) expect(unit).toMatch(/^alinery-mcp-[0-9a-f]{12}$/);
});
