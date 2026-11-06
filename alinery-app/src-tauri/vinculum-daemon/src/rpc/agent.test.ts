// AgentService (plan S4.10): the host's agent directory through the RPC. The directory is the one beside the app config the daemon was
// started with; the file logic is `domain/agentDir.test.ts`. Here: the wire, the staged upload, the dedupe and the capability.
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { AgentService } from "alinery-proto/alinery/v1/agent_pb";
import { BlobStore } from "../domain/blobs.ts";
import { JobRunner } from "../jobs/runner.ts";
import { Store } from "../sync/store.ts";
import { serveRpc } from "./server.ts";

const SECRET = "ab".repeat(32);
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

async function start() {
  const dir = mkdtempSync("/tmp/rpc-agent-");
  const repo = join(dir, "repo");
  mkdirSync(join(repo, ".alinery"), { recursive: true });
  const appConfig = join(dir, "config", "app.toml");
  mkdirSync(join(dir, "config"), { recursive: true });
  writeFileSync(appConfig, "");
  const agentDir = join(dir, "config/vinculum/config/agent");
  const store = new Store({ coalesceMs: 1 });
  const blobs = new BlobStore(repo);
  const socketPath = join(dir, "rpc.sock");
  const net = await serveRpc({
    socketPath,
    secret: Buffer.from(SECRET),
    hostExecutable: process.execPath,
    info: { protocol: 35, buildId: "b", repoRoot: repo, appConfigIdentity: "i" },
    lifecycle: { stop: () => 0, exit: () => {} },
    store,
    jobs: new JobRunner(store),
    storageScan: { mode: "error" } as never,
    transcripts: async () => undefined,
    agent: { appConfig, blobs, mcp: { refresh: async () => ({ tools: ["read", "bash"], servers: [{ name: "docs", builtin: false, state: "error", error: "could not start" }, { name: "alinery", builtin: true, state: "connected" }] }) } },
  });
  cleanup.push(() => {
    net.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const transport = createGrpcTransport({ baseUrl: "http://daemon", nodeOptions: { createConnection: () => connect(socketPath) } as never, interceptors: [(next) => (req) => (req.header.set("authorization", `Bearer ${SECRET}`), next(req))] });
  let n = 0;
  const meta = () => ({ clientId: "c1", mutationId: `m${++n}` });
  const stage = async (name: string, text: string) => {
    const bytes = new TextEncoder().encode(text);
    const begun = blobs.begin({ kind: "staged", name }, bytes.length, createHash("sha256").update(bytes).digest("hex"));
    blobs.chunk(begun.uploadId, 0, bytes);
    await blobs.commit(begun.uploadId);
    return begun.uploadId;
  };
  return { agentDir, blobs, svc: createClient(AgentService, transport), meta, stage };
}

test("model roles are written to and read from the host's agent directory", async () => {
  const t = await start();
  expect((await t.svc.readModelRoles({})).roles).toEqual({});
  const written = await t.svc.writeModelRoles({ meta: t.meta(), roles: { default: "p/m", smol: "q/n" } });
  expect(written.roles).toEqual({ default: "p/m", smol: "q/n" });
  expect(readFileSync(join(t.agentDir, "config.yml"), "utf8")).toBe("modelRoles:\n  default: p/m\n  smol: q/n\n");
  const read = await t.svc.readModelRoles({});
  expect([read.roles, read.agentDir]).toEqual([{ default: "p/m", smol: "q/n" }, t.agentDir]);
  await t.svc.writeModelRoles({ meta: t.meta(), roles: {} });
  expect((await t.svc.readModelRoles({})).roles).toEqual({});
});

test("a staged skill installs, shows in the inventory, asks before replacing, and deletes", async () => {
  const t = await start();
  const md = (body: string) => `---\nname: demo-skill\ndescription: Does the demo\n---\n${body}\n`;
  const first = await t.svc.installSkill({ meta: t.meta(), uploadId: await t.stage("demo.md", md("one")), fileName: "demo.md", replace: false });
  expect([first.name, first.exists]).toEqual(["demo-skill", false]);
  const inv = await t.svc.readCustomizations({});
  expect(inv.items.map((i) => [i.kind, i.name, i.offered])).toEqual([["Skill", "demo-skill", true]]);
  expect(inv.agentDir).toBe(t.agentDir);
  const pending = await t.svc.installSkill({ meta: t.meta(), uploadId: await t.stage("demo.md", md("two")), fileName: "demo.md", replace: false });
  expect(pending.exists).toBe(true);
  expect(readFileSync(join(t.agentDir, "skills/demo-skill/SKILL.md"), "utf8")).toContain("one");
  await t.svc.installSkill({ meta: t.meta(), uploadId: await t.stage("demo.md", md("two")), fileName: "demo.md", replace: true });
  expect(readFileSync(join(t.agentDir, "skills/demo-skill/SKILL.md"), "utf8")).toContain("two");
  await t.svc.deleteSkill({ meta: t.meta(), name: "demo-skill" });
  expect(existsSync(join(t.agentDir, "skills/demo-skill"))).toBe(false);
});

test("a skill the daemon was never given, or one that is refused, is an error and releases the upload", async () => {
  const t = await start();
  const missing = ConnectError.from(await t.svc.installSkill({ meta: t.meta(), uploadId: "nope", fileName: "x.md", replace: false }).then(() => null, (e) => e));
  expect(missing.code).toBe(Code.InvalidArgument);
  const id = await t.stage("bad.md", "no frontmatter");
  const refused = ConnectError.from(await t.svc.installSkill({ meta: t.meta(), uploadId: id, fileName: "bad.md", replace: false }).then(() => null, (e) => e));
  expect(refused.code).toBe(Code.InvalidArgument);
  expect(refused.rawMessage).toContain("frontmatter");
  expect(t.blobs.staged(id)).toBeUndefined();
  const gone = ConnectError.from(await t.svc.deleteSkill({ meta: t.meta(), name: "absent" }).then(() => null, (e) => e));
  expect(gone.rawMessage).toContain("not installed");
});

test("a retried skill install is answered once", async () => {
  const t = await start();
  const id = await t.stage("demo.md", "---\nname: once-skill\ndescription: Once\n---\nx\n");
  const m = t.meta();
  const a = await t.svc.installSkill({ meta: m, uploadId: id, fileName: "demo.md", replace: false });
  const b = await t.svc.installSkill({ meta: m, uploadId: id, fileName: "demo.md", replace: false });
  expect([a.exists, b.exists]).toEqual([false, false]);
});

test("the prompt names this host's agent directory", async () => {
  const t = await start();
  const { prompt } = await t.svc.customizationPrompt({});
  expect(prompt).toContain(`'${t.agentDir}'`);
});

test("the MCP hub's state reads back with each server's connection and a failure's fixed text", async () => {
  const t = await start();
  const status = await t.svc.readMcpStatus({});
  expect(status.tools).toEqual(["read", "bash"]);
  expect(status.servers.map((s) => [s.name, s.builtin, s.state, s.error])).toEqual([
    ["docs", false, "error", "could not start"],
    ["alinery", true, "connected", undefined],
  ]);
});
