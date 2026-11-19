import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SessionService } from "alinery-proto/alinery/v1/sessions_pb";
import { JobRunner } from "../jobs/runner.ts";
import { DaemonConnection } from "../mcpServer/client.ts";
import { startDaemon } from "../mcpServer/daemonFixture.testutil.ts";
import { buildFixture } from "../mcpServer/fixtureRepo.testutil.ts";
import type { TranscriptFeed } from "../runtime/transcript.ts";
import { Store } from "../sync/store.ts";
import type { TranscriptReply } from "../transcript.ts";
import { serveRpc } from "./server.ts";

const SECRET = "ef".repeat(32);
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

const items: TranscriptReply[] = [
  { id: "u1", role: "user", content: [{ type: "text", text: "read a.ts" }] },
  {
    id: "a1",
    role: "assistant",
    runningToolIds: ["c1"],
    content: [
      { type: "thinking", thinking: "Look." },
      { type: "redactedThinking" },
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts", n: [1, null] } },
    ],
  },
  { id: "r1", role: "toolResult", toolName: "read", toolCallId: "c1", isError: true, content: [{ type: "text", text: "boom" }] },
];

async function start(feed: TranscriptFeed | undefined) {
  const dir = mkdtempSync("/tmp/rpc-t-");
  const socketPath = join(dir, "rpc.sock");
  const store = new Store();
  const net = await serveRpc({
    socketPath,
    secret: Buffer.from(SECRET),
    hostExecutable: process.execPath,
    info: { protocol: 25, buildId: "b", repoRoot: "/repo", appConfigIdentity: "i" },
    lifecycle: { stop: () => 0, exit: () => {} },
    store,
    jobs: new JobRunner(store),
    storageScan: { repo: "/repo", appConfig: "/app", namespace: "" },
    transcripts: async (taskSlug, id) => (taskSlug === "t" && id === "s1" ? feed : undefined),
  });
  cleanup.push(() => {
    net.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return (header: string | undefined = `Bearer ${SECRET}`) =>
    createClient(
      SessionService,
      createGrpcTransport({
        baseUrl: "http://daemon",
        nodeOptions: { createConnection: () => connect(socketPath) } as never,
        interceptors: [(next) => (req) => (header ? (req.header.set("authorization", header), next(req)) : next(req))],
      }),
    );
}

test("WatchTranscript over the socket: parts, tool call arguments and controls survive; a later item arrives alone", async () => {
  let notify = () => {};
  let list = items.slice(0, 2);
  const feed: TranscriptFeed = {
    read: async () => ({ items: structuredClone(list), controls: { model: "p/m", thinking: "low", thinking_levels: ["off", "low"] } }),
    subscribe: (n) => ((notify = n), () => {}),
  };
  const client = (await start(feed))();
  const ac = new AbortController();
  const frames = client.watchTranscript({ session: { taskSlug: "t", id: "s1" }, fromItem: 0n }, { signal: ac.signal })[Symbol.asyncIterator]();
  const first = (await frames.next()).value!;
  expect(first.items.map((i) => i.id)).toEqual(["u1", "a1"]);
  expect(first).toMatchObject({ nextItem: 2n, replace: false, controls: { model: "p/m", thinking: "low", thinkingLevels: ["off", "low"] } });
  const parts = first.items[1]!.content.map((p) => p.kind.case);
  expect(parts).toEqual(["thinking", "redactedThinking", "toolCall"]);
  const call = first.items[1]!.content[2]!.kind;
  expect(call.case === "toolCall" && call.value.name).toBe("read");
  expect(call.case === "toolCall" && call.value.arguments?.kind.case).toBe("structValue");
  expect(first.items[1]!.runningToolIds).toEqual(["c1"]);
  list = items;
  notify();
  const second = (await frames.next()).value!;
  expect(second.items.map((i) => [i.id, i.toolCallId, i.isError])).toEqual([["r1", "c1", true]]);
  expect(second).toMatchObject({ nextItem: 3n, replace: false });
  ac.abort();
});

test("WatchTranscript needs VIEW and a transcript", async () => {
  const feed: TranscriptFeed = { read: async () => ({ items: [], controls: { model: "", thinking: "off", thinking_levels: [] } }), subscribe: () => () => {} };
  const client = await start(feed);
  const call = (c: ReturnType<typeof client>, id: string) => c.watchTranscript({ session: { taskSlug: "t", id } })[Symbol.asyncIterator]().next();
  const anonymous = await call(client(""), "s1").catch((e) => e);
  expect(ConnectError.from(anonymous).code).toBe(Code.Unauthenticated);
  const missing = await call(client(), "nope").catch((e) => e);
  expect(ConnectError.from(missing).code).toBe(Code.NotFound);
});

test("WatchTranscript on a fresh daemon returns a retained Pi conversation in one frame", async () => {
  const fx = await buildFixture();
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    const id = "first-draft";
    const base = join(fx.repo, ".alinery", "tasks", fx.slug, "sessions", id);
    const harness = await Harness.open(await openNodeSqliteStorage(base + ".pi.sqlite"), { registry: createRegistry(), models: createModels() } as never, BACKGROUND_CONTEXT);
    try {
      const root = await harness.root(BACKGROUND_CONTEXT);
      await root.commit((tx) => tx.appendEntry(root.id, { kind: "message", model: [{ role: "user", content: "This draft survived.", timestamp: 10 }] }), BACKGROUND_CONTEXT);
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
    writeFileSync(base + ".meta.json", JSON.stringify({ id, ended_at: 30 }));
    daemon = await startDaemon(fx);
    const client = new DaemonConnection({ socket: daemon.socket, token: daemon.token }, daemon.context().protocol).api(SessionService);
    const frames = [];
    for await (const frame of client.watchTranscript({ session: { taskSlug: fx.slug, id } }, { signal: AbortSignal.timeout(5000) })) frames.push(frame);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.items).toMatchObject([{ role: "user", content: [{ kind: { case: "text", value: "This draft survived." } }] }]);
    const invalid = await client.watchTranscript({ session: { taskSlug: fx.slug, id: "../missing" } })[Symbol.asyncIterator]().next().catch((err) => err);
    expect(ConnectError.from(invalid).code).toBe(Code.InvalidArgument);
  } finally {
    await daemon?.stop();
    rmSync(fx.root, { recursive: true, force: true });
  }
}, 45_000);
