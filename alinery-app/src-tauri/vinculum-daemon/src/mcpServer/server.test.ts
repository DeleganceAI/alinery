// The MCP server end to end: the JSON-RPC surface, a daemon of another protocol, and the daemon's hub starting this binary's bridge
// as its harnesses' built-in server.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRegistry } from "@earendil-works/pi-durable";
import { McpHub, selfMcpCommand } from "../mcp.ts";
import { daemonProtocol, type RunningDaemon, startDaemon } from "./daemonFixture.testutil.ts";
import { DaemonConnection } from "./client.ts";
import { Endpoints } from "./endpoints.ts";
import { appConfigDirOf } from "../domain/playbookLibrary.ts";
import { ask, machinePaths } from "./machine.ts";
import { handleRequest } from "./server.ts";
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

test("tools/list answers the 26 tools, initialize names the server, and a notification gets no answer", async () => {
  const ctx = daemon.context();
  const listed = (await handleRequest(ctx, { jsonrpc: "2.0", id: 1, method: "tools/list" })) as { result: { tools: { name: string }[] } };
  expect(listed.result.tools.length).toBe(26);
  expect(listed.result.tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
  const init = (await handleRequest(ctx, { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-03-26" } })) as { result: { serverInfo: { name: string }; protocolVersion: string } };
  expect(init.result).toMatchObject({ serverInfo: { name: "alinery-mcp" }, protocolVersion: "2025-03-26" });
  expect(await handleRequest(ctx, { jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  expect(await handleRequest(ctx, { jsonrpc: "2.0", id: 3, method: "nope" })).toMatchObject({ error: { code: -32601 } });
  // Spanning repositories, the bridge and the machine MCP list no resources and do not advertise them.
  const spanning = { ...ctx, processRepo: undefined };
  expect(await handleRequest(spanning, { jsonrpc: "2.0", id: 4, method: "resources/list" })).toMatchObject({ result: { resources: [] } });
  expect(((await handleRequest(spanning, { jsonrpc: "2.0", id: 5, method: "initialize", params: {} })) as { result: { capabilities: object } }).result.capabilities).toEqual({ tools: {} });
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

test("a repo no endpoint covers is refused with the reason, and a handoff is the machine MCP's only", async () => {
  const ctx = daemon.context({ endpoints: new Endpoints() });
  const call = async (name: string, args: object) => ((await handleRequest(ctx, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })) as { result: { content: { text: string }[] } }).result.content[0].text;
  expect(await call("alinery_list_tasks", { repo: daemon.fixture.repo })).toMatch(/^error: /);
  const own = daemon.context();
  const handoff = (await handleRequest(own, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "alinery_send_review_handoff", arguments: { repo: daemon.fixture.repo, source_slug: "first-task", source_artifact: "01-notes.md", target_repo: daemon.fixture.repo, target_slug: "first-task" } } })) as { result: { content: { text: string }[] } };
  expect(handoff.result.content[0].text).toContain("needs the machine MCP");
});

test("the hub starts the bridge as the built-in server, which starts the machine MCP, and registers the 26 tools", async () => {
  // `selfMcpCommand` is the compiled binary or `bun main.ts` plus --mcp; here a wrapper stands in for the script path a test cannot name.
  const self = selfMcpCommand();
  expect(self.command).toBe(process.execPath);
  expect(self.args.at(-1)).toBe("--mcp");
  const wrapper = join(daemon.fixture.root, "alinery-mcp");
  writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(MAIN)} --mcp "$@"\n`);
  chmodSync(wrapper, 0o755);
  const registry = createRegistry();
  const hub = new McpHub(registry, { repo: daemon.fixture.repo, appConfig: daemon.fixture.appConfig, agentDir: join(daemon.fixture.root, "agent"), resolveBuiltin: () => wrapper });
  const reply = await hub.refresh();
  hub.close();
  // The bridge started this fixture's machine MCP; ask it to leave rather than wait out its idle time.
  await ask(machinePaths(appConfigDirOf(daemon.fixture.appConfig)).socket, { op: "exit" }).catch(() => {});
  expect(reply.servers.find((s) => s.name === "alinery")).toMatchObject({ builtin: true, state: "connected" });
  const names = registry.snapshot().tools().map((entry) => entry.tool.name);
  for (const tool of TOOLS) expect(names).toContain(`mcp__alinery__${tool.name}`);
}, 60_000);

test("a connection whose token the shell re-minted twice keeps working once it reads the new one (the 30 s refresh)", async () => {
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
