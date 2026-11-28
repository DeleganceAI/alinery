// A daemon on a fixture repository whose first turn a local OpenAI-compatible provider holds open, so a session can be
// asked what it holds while it runs — the vehicle `nudge.test.ts` uses, shared by the queue's wire tests and the agent's
// history tool test.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SyncService } from "alinery-proto/alinery/v1/sync_pb";
import { TaskService } from "alinery-proto/alinery/v1/tasks_pb";
import { SessionService } from "alinery-proto/alinery/v1/sessions_pb";
import { DaemonConnection, newMeta } from "./client.ts";
import { SECRET, startDaemon } from "./daemonFixture.testutil.ts";
import { PLAYBOOK } from "./fixtureRepo.testutil.ts";

type ModelMessage = { role: string; content: string | Array<{ type: string; text?: string }> | null };

function modelReply(delta: object, finish: string): Response {
  const chunk = (body: object, finish_reason: string | null) =>
    `data: ${JSON.stringify({ id: "response", model: "queued", choices: [{ index: 0, delta: body, finish_reason }] })}\n\n`;
  return new Response(`${chunk({ role: "assistant", ...delta }, null)}${chunk({}, finish)}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}

/** The fixture task's first turn, held open until the test releases it. */
export function heldProvider() {
  const requests: ModelMessage[][] = [];
  const received = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const { messages } = (await request.json()) as { messages: ModelMessage[] };
      const index = requests.push(messages) - 1;
      if (index === 0) {
        received.resolve();
        await release.promise;
      }
      return modelReply({ content: `reply ${index}` }, "stop");
    },
  });
  return { requests, received: received.promise, release: release.resolve, stop: () => server.stop(true), port: server.port };
}

export function writeInference(appConfig: string, port: number) {
  writeFileSync(
    join(dirname(appConfig), "inference.json"),
    JSON.stringify({
      token: "fixture-only",
      expires_at: Math.floor(Date.now() / 1000) + 120,
      catalog: { base_url: `http://127.0.0.1:${port}/v1`, models: [{ id: "queued", name: "Queued", context_window: 64_000, max_tokens: 512 }] },
    }),
  );
}

/** The session row as the sync feed reports it, once its agent state is `agent`. */
export async function waitForSession(connection: DaemonConnection, taskSlug: string, agent: string) {
  return waitForRow(connection, taskSlug, (status) => status?.agent === agent, agent);
}

/** The session row once its process state is `process` — `exited` is how a killed session reads as ended. */
export async function waitForProcess(connection: DaemonConnection, taskSlug: string, process: string) {
  return waitForRow(connection, taskSlug, (status) => status?.process === process, process);
}

async function waitForRow(connection: DaemonConnection, taskSlug: string, matches: (status: { agent?: string; process?: string } | undefined) => boolean, wanted: string) {
  const scope = { kind: { case: "task" as const, value: { slug: taskSlug } } };
  const abort = AbortSignal.timeout(10_000);
  for await (const { frame } of connection.api(SyncService).subscribe({ scope }, { signal: abort })) {
    const rows = frame.case === "snapshot" ? frame.value.entities : frame.case === "delta" ? frame.value.changes.flatMap((c) => (c.op.case === "put" ? [c.op.value] : [])) : [];
    for (const row of rows) if (row.value.case === "session" && matches(row.value.value.status)) return row.value.value;
  }
  throw new Error(`Session closed before becoming ${wanted}`);
}

/** The first frame of a fresh watch: the queue as the session holds it now, beside the whole item list. */
export async function firstFrame(connection: DaemonConnection, taskSlug: string, id: string) {
  for await (const frame of connection.api(SessionService).watchTranscript({ session: { taskSlug, id } }, { signal: AbortSignal.timeout(10_000) })) return frame;
  throw new Error("no frame");
}

/** A task created and started on the fixture repo, its first turn waiting for the provider's answer. */
export async function startedTask(daemon: Awaited<ReturnType<typeof startDaemon>>) {
  const connection = new DaemonConnection({ socket: daemon.socket, token: SECRET }, daemon.context().protocol);
  const created = await connection.api(TaskService).createTask({
    meta: newMeta(),
    name: "Queued test",
    description: "Check the worktree.",
    playbookRef: { scope: "bundled", key: "one-shot" },
    playbookSource: PLAYBOOK,
    launchDefaults: { harness: "vinculum", model: "alinery/queued" },
    start: true,
  });
  if (created.created?.start !== "started") throw new Error(`task did not start: ${JSON.stringify(created.created?.errors)}`);
  return { connection, taskSlug: created.created.task!.slug };
}
