// The MCP server end to end: the JSON-RPC surface, the unix-socket mode the app's managed child serves, the stdio mode a harness
// launches, a daemon of another protocol, and the shell's hub starting this binary as its built-in server.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createRegistry } from "@earendil-works/pi-durable";
import { McpHub, selfMcpCommand } from "../mcp.ts";
import { daemonProtocol, type RunningDaemon, startDaemon } from "./daemonFixture.testutil.ts";
import { DaemonConnection } from "./client.ts";
import { Endpoints } from "./endpoints.ts";
import { contextFrom, handleRequest, mcpPaths } from "./server.ts";
import { TOOLS } from "./tools.ts";

const MAIN = join(import.meta.dir, "..", "main.ts");
let daemon: RunningDaemon;
beforeAll(async () => {
  daemon = await startDaemon();
}, 60_000);
afterAll(async () => {
  await daemon?.stop();
  if (daemon) rmSync(daemon.fixture.root, { recursive: true, force: true });
});

const env = () => ({ ...process.env, ALINERY_RPC_SOCKET: daemon.socket, ALINERY_RPC_TOKEN: daemon.token });
const until = async (ok: () => boolean, what: string) => {
  for (let i = 0; i < 150; i++) {
    if (ok()) return;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
};

test("tools/list answers the 26 tools, initialize names the server, and a notification gets no answer", async () => {
  const ctx = daemon.context();
  const listed = (await handleRequest(ctx, { jsonrpc: "2.0", id: 1, method: "tools/list" })) as { result: { tools: { name: string }[] } };
  expect(listed.result.tools.length).toBe(26);
  expect(listed.result.tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
  const init = (await handleRequest(ctx, { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-03-26" } })) as { result: { serverInfo: { name: string }; protocolVersion: string } };
  expect(init.result).toMatchObject({ serverInfo: { name: "alinery-mcp" }, protocolVersion: "2025-03-26" });
  expect(await handleRequest(ctx, { jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  expect(await handleRequest(ctx, { jsonrpc: "2.0", id: 3, method: "nope" })).toMatchObject({ error: { code: -32601 } });
});

test("a daemon of another protocol is named and left alone: the call fails, the daemon keeps its pid and still answers", async () => {
  const before = daemon.process.pid;
  const reply = await handleRequest(daemon.context({ protocol: daemonProtocol() + 1 }), { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "alinery_list_tasks", arguments: { repo: daemon.fixture.repo } } });
  const text = (reply as { result: { content: { text: string }[]; isError?: boolean } }).result;
  expect(text.content[0].text).toBe(`error: repo-protocol-mismatch: daemon speaks protocol ${daemonProtocol()}, client speaks ${daemonProtocol() + 1}`);
  expect(daemon.process.pid).toBe(before);
  expect(daemon.process.killed).toBe(false);
  const ok = await handleRequest(daemon.context(), { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "alinery_list_tasks", arguments: { repo: daemon.fixture.repo } } });
  expect(JSON.parse((ok as { result: { content: { text: string }[] } }).result.content[0].text)).toContain("first-task");
});

test("a repo no endpoint covers is refused with the reason, and a handoff is the shell's managed MCP only (O22 a)", async () => {
  const ctx = daemon.context({ endpoints: new Endpoints(undefined, undefined) });
  const call = async (name: string, args: object) => ((await handleRequest(ctx, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })) as { result: { content: { text: string }[] } }).result.content[0].text;
  expect(await call("alinery_list_tasks", { repo: daemon.fixture.repo })).toMatch(/^error: /);
  const own = daemon.context();
  const handoff = (await handleRequest(own, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "alinery_send_review_handoff", arguments: { repo: daemon.fixture.repo, source_slug: "first-task", source_artifact: "01-notes.md", target_repo: daemon.fixture.repo, target_slug: "first-task" } } })) as { result: { content: { text: string }[] } };
  expect(handoff.result.content[0].text).toContain("needs the Alinery app's MCP");
});

test("--mcp --serve listens on mcp.sock, keeps the status file, answers a line, and leaves when asked with the exit op", async () => {
  const { repo } = daemon.fixture;
  const { socket, status } = mcpPaths(repo, undefined);
  const proc = Bun.spawn([process.execPath, MAIN, "--mcp", "--serve", "--repo", repo], { env: env(), stdout: "ignore", stderr: "ignore" });
  try {
    await until(() => existsSync(status), "the status file");
    expect(JSON.parse(readFileSync(status, "utf8"))).toEqual({ pid: proc.pid, clients: 0 });
    const conn = connect(socket);
    const lines = createInterface({ input: conn })[Symbol.asyncIterator]();
    conn.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
    const answer = JSON.parse((await lines.next()).value as string) as { result: { tools: unknown[] } };
    expect(answer.result.tools.length).toBe(26);
    expect(JSON.parse(readFileSync(status, "utf8")).clients).toBe(1);
    conn.write(`${JSON.stringify({ op: "exit" })}\n`);
    expect(JSON.parse((await lines.next()).value as string)).toEqual({ ok: true });
    expect(await proc.exited).toBe(0);
    expect(existsSync(socket)).toBe(false);
    expect(existsSync(status)).toBe(false);
  } finally {
    proc.kill();
  }
});

test("--managed ends the listener when the app's end of its stdin closes, and removes its socket", async () => {
  const { repo } = daemon.fixture;
  const { socket } = mcpPaths(repo, "managed-test");
  const proc = Bun.spawn([process.execPath, MAIN, "--mcp", "--serve", "--managed", "--socket-namespace", "managed-test", "--repo", repo], { env: env(), stdin: "pipe", stdout: "ignore", stderr: "ignore" });
  try {
    await until(() => existsSync(socket), "the socket");
    proc.stdin.end();
    expect(await proc.exited).toBe(0);
    expect(existsSync(socket)).toBe(false);
  } finally {
    proc.kill();
  }
});

test("--mcp over stdio is what a harness launches: lines in, lines out, and a call reaches the daemon", async () => {
  const { repo } = daemon.fixture;
  const proc = Bun.spawn([process.execPath, MAIN, "--mcp", "--repo", repo, "--app-config", daemon.fixture.appConfig], { env: env(), stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  try {
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "alinery_list_tasks", arguments: { repo } } })}\n`);
    proc.stdin.flush();
    const reader = proc.stdout.getReader();
    const { value } = await reader.read();
    const reply = JSON.parse(new TextDecoder().decode(value).split("\n")[0]) as { id: number; result: { content: { text: string }[] } };
    expect(reply.id).toBe(1);
    expect(JSON.parse(reply.result.content[0].text)).toContain("first-task");
    proc.stdin.end();
    expect(await proc.exited).toBe(0);
  } finally {
    proc.kill();
  }
});

test("the shell's hub starts this binary as the built-in server and registers the 26 tools", async () => {
  // `selfMcpCommand` is the compiled binary or `bun main.ts` plus --mcp; here a wrapper stands in for the script path a test cannot name.
  const self = selfMcpCommand();
  expect(self.command).toBe(process.execPath);
  expect(self.args.at(-1)).toBe("--mcp");
  const wrapper = join(daemon.fixture.root, "alinery-mcp");
  writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(MAIN)} --mcp "$@"\n`);
  chmodSync(wrapper, 0o755);
  const registry = createRegistry();
  const hub = new McpHub(registry, { repo: daemon.fixture.repo, appConfig: daemon.fixture.appConfig, agentDir: join(daemon.fixture.root, "agent"), rpc: { socket: daemon.socket, token: daemon.token }, resolveBuiltin: () => wrapper });
  const reply = await hub.refresh();
  hub.close();
  expect(reply.servers.find((s) => s.name === "alinery")).toMatchObject({ builtin: true, state: "connected" });
  const names = registry.snapshot().tools().map((entry) => entry.tool.name);
  for (const tool of TOOLS) expect(names).toContain(`mcp__alinery__${tool.name}`);
}, 60_000);

test("only the managed MCP offers a handoff: the same endpoints file read by a host's stdio MCP does not (O22 a)", () => {
  const file = ["--endpoints-file", "/tmp/endpoints.json"];
  expect(contextFrom([...file, "--managed"], 1, {}).endpoints.offersHandoff).toBe(true);
  expect(contextFrom(file, 1, {}).endpoints.offersHandoff).toBe(false);
  expect(contextFrom(file, 1, {}).endpoints.spansRepos).toBe(true);
  expect(contextFrom(["--repo", "/r"], 1, { ALINERY_RPC_SOCKET: "/s", ALINERY_RPC_TOKEN: "t" }).endpoints.offersHandoff).toBe(false);
});

test("a connection whose token the shell re-minted twice keeps working once it reads the new one (the 30 s refresh, R-S5.1-4)", async () => {
  const first = await daemon.mint("refresh");
  const conn = new DaemonConnection({ socket: daemon.socket, token: first }, daemonProtocol());
  const scope = { kind: { case: "repo", value: {} } } as const;
  expect((await conn.read(scope)).length).toBeGreaterThan(0);
  // One mint later the old token still works: a call that read the file just before the refresh is not cut off.
  const second = await daemon.mint("refresh");
  expect((await conn.read(scope)).length).toBeGreaterThan(0);
  let current = await daemon.mint("refresh");
  // Two mints later it is gone, and a connection that held it for good would fail; this one asks for the current token per request.
  await expect(conn.read(scope)).rejects.toThrow(/wrong token/);
  conn.tokenSource = () => current;
  expect((await conn.read(scope)).length).toBeGreaterThan(0);
  current = await daemon.mint("refresh");
  expect(second).not.toBe(current);
  expect((await conn.read(scope)).length).toBeGreaterThan(0);
});
