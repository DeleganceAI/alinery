import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SessionService } from "alinery-proto/alinery/v1/sessions_pb";
import { SyncService } from "alinery-proto/alinery/v1/sync_pb";
import { JobRunner } from "../jobs/runner.ts";
import { DaemonConnection, newMeta } from "../mcpServer/client.ts";
import { SECRET as daemonSecret, startDaemon } from "../mcpServer/daemonFixture.testutil.ts";
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

test("RetryTurn recovers the failed conversation once through a live daemon", async () => {
  const fx = await buildFixture();
  const original = "Read the test ticket.";
  const recovered = "I recovered the ticket.";
  const reason = "The fixture provider rejected the request";
  let healthy = false;
  const requests: string[] = [];
  const provider = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      const body = await req.json() as { messages: unknown[] };
      requests.push(JSON.stringify(body.messages));
      if (!healthy) return Response.json({ error: { message: reason } }, { status: 400 });
      const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: "retry", model: "retry", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(chunk({ role: "assistant", content: recovered }, null) + chunk({}, "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    },
  });
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    writeFileSync(join(dirname(fx.appConfig), "inference.json"), JSON.stringify({
      token: "fixture-only", expires_at: Math.floor(Date.now() / 1000) + 120,
      catalog: { base_url: `http://127.0.0.1:${provider.port}/v1`, models: [{ id: "retry", name: "Retry", context_window: 64_000, max_tokens: 512 }] },
    }));
    daemon = await startDaemon(fx);
    const endpoint = { socket: daemon.socket, token: daemonSecret };
    const protocol = daemon.context().protocol;
    const conn = new DaemonConnection(endpoint, protocol);
    const client = conn.api(SessionService);
    const created = await client.createSession({ meta: newMeta(), taskSlug: fx.slug, target: { case: "auxiliary", value: { harness: "vinculum", model: "alinery/retry", prompt: original } }, start: true });
    expect(created.started).toMatchObject({ start: "started", errors: [] });
    const session = { taskSlug: fx.slug, id: String(created.started!.session!.id) };
    const observe = async (agent: string) => {
      const scope = { kind: { case: "session" as const, value: { session } } };
      for await (const { frame } of conn.api(SyncService).subscribe({ scope }, { signal: AbortSignal.timeout(10_000) })) {
        const rows = frame.case === "snapshot" ? frame.value.entities : frame.case === "delta" ? frame.value.changes.flatMap((change) => change.op.case === "put" ? [change.op.value] : []) : [];
        for (const { value } of rows) if (value.case === "session" && value.value.status?.agent === agent) return value.value.status;
      }
      throw new Error(`Session ended before observing ${agent}`);
    };
    const readTranscript = async () => {
      for await (const frame of client.watchTranscript({ session }, { signal: AbortSignal.timeout(10_000) })) return frame.items;
      throw new Error("Missing transcript");
    };
    const failure = await observe("errored");
    expect(failure.agentReason).toContain(reason);
    const failedTranscript = await readTranscript();
    expect(failedTranscript.find((item) => item.id === failure.agentCorrelationId)?.turnError).toBe(failure.agentReason);
    expect(requests).toHaveLength(1);

    healthy = true;
    const retryRequest = () => ({ sessionId: session.id, failedEntryId: failure.agentCorrelationId, meta: newMeta() });
    await Promise.all([client.retryTurn(retryRequest()), client.retryTurn(retryRequest())]);
    await observe("idle");
    await new DaemonConnection(endpoint, protocol).api(SessionService).retryTurn(retryRequest());
    const transcript = await readTranscript();
    const texts = transcript.flatMap((item) => item.content.flatMap((part) => part.kind.case === "text" ? [part.kind.value] : []));
    expect(texts.filter((text) => text === "Continue from where the failed turn stopped.")).toHaveLength(1);
    expect(texts).toContain(recovered);
    expect(transcript.find((item) => item.id === failure.agentCorrelationId)?.turnError).toBe(failure.agentReason);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain(original);
  } finally {
    await daemon?.stop();
    provider.stop(true);
    rmSync(fx.root, { recursive: true, force: true });
  }
}, 45_000);
