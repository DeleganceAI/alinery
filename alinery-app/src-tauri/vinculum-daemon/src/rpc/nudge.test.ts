import { expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Code } from "@connectrpc/connect";
import { ExecutionService } from "alinery-proto/alinery/v1/executions_pb";
import { SessionService } from "alinery-proto/alinery/v1/sessions_pb";
import { SyncService } from "alinery-proto/alinery/v1/sync_pb";
import { TaskService } from "alinery-proto/alinery/v1/tasks_pb";
import { DaemonConnection, newMeta } from "../mcpServer/client.ts";
import { SECRET, startDaemon } from "../mcpServer/daemonFixture.testutil.ts";
import { buildFixture, PLAYBOOK } from "../mcpServer/fixtureRepo.testutil.ts";

type ModelMessage = { role: string; content: string | Array<{ type: string; text?: string }> | null };

function userInputs(messages: ModelMessage[]): string[] {
  return messages.filter((m) => m.role === "user").map((m) =>
    Array.isArray(m.content) ? m.content.map((part) => part.text ?? "").join("") : m.content ?? "",
  );
}

function modelReply(delta: object, finish: string): Response {
  const chunk = (delta: object, finish_reason: string | null) =>
    `data: ${JSON.stringify({ id: "response", model: "nudge", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  return new Response(chunk({ role: "assistant", ...delta }, null) + chunk({}, finish) + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}

async function waitForSession(connection: DaemonConnection, taskSlug: string, agent: string) {
  const scope = { kind: { case: "task" as const, value: { slug: taskSlug } } };
  const abort = AbortSignal.timeout(10_000);
  for await (const { frame } of connection.api(SyncService).subscribe({ scope }, { signal: abort })) {
    const rows = frame.case === "snapshot" ? frame.value.entities : frame.case === "delta" ? frame.value.changes.flatMap((c) => c.op.case === "put" ? [c.op.value] : []) : [];
    for (const row of rows) if (row.value.case === "session" && row.value.value.status?.agent === agent) return row.value.value;
  }
  throw new Error(`Session closed before becoming ${agent}`);
}

async function waitForRequest(arrived: Promise<void>, number: number) {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([arrived, new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new Error(`The model did not receive request ${number}`)), 8_000);
    })]);
  } finally {
    clearTimeout(deadline);
  }
}

test.each(["tool", "final"] as const)("a wrap-up nudge reaches the model before earlier follow-ups at a %s boundary", async (boundary) => {
  const fx = await buildFixture();
  const queued = "After the current task, explain the changes to me.";
  const queuedLater = "Then summarize the test results.";
  // Hold each response until the test has inspected what the model actually received.
  const rounds = Array.from({ length: 4 }, () => ({ received: Promise.withResolvers<void>(), finish: Promise.withResolvers<void>() }));
  const requests: ModelMessage[][] = [];
  const provider = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const { messages } = await request.json() as { messages: ModelMessage[] };
      const index = requests.push(messages) - 1;
      const round = rounds[index];
      if (round) {
        round.received.resolve();
        await round.finish.promise;
      }
      if (index === 0 && boundary === "tool") return modelReply({
        tool_calls: [{ index: 0, id: "check-worktree", type: "function", function: { name: "read", arguments: JSON.stringify({ path: ".git" }) } }],
      }, "tool_calls");
      return modelReply({ content: "Finished this part." }, "stop");
    },
  });
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    writeFileSync(join(dirname(fx.appConfig), "inference.json"), JSON.stringify({
      token: "fixture-only", expires_at: Math.floor(Date.now() / 1000) + 120,
      catalog: { base_url: `http://127.0.0.1:${provider.port}/v1`, models: [{ id: "nudge", name: "Nudge", context_window: 64_000, max_tokens: 512 }] },
    }));
    daemon = await startDaemon(fx);
    const endpoint = { socket: daemon.socket, token: SECRET };
    const protocol = daemon.context().protocol;
    const connection = new DaemonConnection(endpoint, protocol);
    const created = await connection.api(TaskService).createTask({
      meta: newMeta(), name: "Nudge test", description: "Check the worktree.",
      playbookRef: { scope: "bundled", key: "one-shot" }, playbookSource: PLAYBOOK,
      launchDefaults: { harness: "vinculum", model: "alinery/nudge" }, start: true,
    });
    expect(created.created).toMatchObject({ start: "started", errors: [] });
    const taskSlug = created.created!.task!.slug;
    await waitForRequest(rounds[0]!.received.promise, 1);
    const current = await waitForSession(connection, taskSlug, "busy");
    expect(current.status?.agentCorrelationId).toBeTruthy();
    const sessionId = current.id;
    const executionId = current.executionId;
    const runId = current.status!.agentCorrelationId;
    await connection.api(SessionService).promptSession({ sessionId, text: queued, meta: newMeta() });
    const nudge = { taskSlug, executionId, sessionId, runId, meta: newMeta() };
    const execution = connection.api(ExecutionService);
    const replies = await Promise.all([execution.nudgeExecution(nudge), execution.nudgeExecution(nudge)]);
    expect(replies.map((r) => r.deliveryId)).toEqual([nudge.meta.mutationId, nudge.meta.mutationId]);
    // Another client cannot send a second nudge for the active run.
    const other = new DaemonConnection(endpoint, protocol).api(ExecutionService);
    await expect(other.nudgeExecution({ ...nudge, meta: newMeta() })).rejects.toMatchObject({
      code: Code.FailedPrecondition, rawMessage: expect.stringMatching(/already.*nudge/i),
    });
    await connection.api(SessionService).promptSession({ sessionId, text: queuedLater, meta: newMeta() });
    rounds[0]!.finish.resolve();
    // The nudge is the next model input of the original active run.
    await waitForRequest(rounds[1]!.received.promise, 2);
    expect((await waitForSession(connection, taskSlug, "busy")).status?.agentCorrelationId).toBe(runId);
    const original = userInputs(requests[0]!);
    const steered = userInputs(requests[1]!).slice(original.length);
    expect(steered).toHaveLength(1);
    expect(steered[0]).toMatch(/wrap up|finish/i);
    let receivedIds: string[] = [];
    for await (const frame of connection.api(SessionService).watchTranscript({ session: { taskSlug, id: sessionId } }, { signal: AbortSignal.timeout(5_000) })) {
      const nudges = frame.items.filter((item) => item.nudgeDeliveryId);
      if (!nudges.length) continue;
      expect(nudges[0]).toMatchObject({ role: "user", content: [{ kind: { case: "text", value: steered[0] } }] });
      receivedIds = nudges.map((item) => item.nudgeDeliveryId);
      break;
    }
    expect(receivedIds).toEqual([nudge.meta.mutationId]);
    rounds[1]!.finish.resolve();
    await waitForRequest(rounds[2]!.received.promise, 3);
    expect(userInputs(requests[2]!)).toEqual([...original, ...steered, queued]);
    rounds[2]!.finish.resolve();
    await waitForRequest(rounds[3]!.received.promise, 4);
    expect(userInputs(requests[3]!)).toEqual([...original, ...steered, queued, queuedLater]);
    rounds[3]!.finish.resolve();
    await waitForSession(connection, taskSlug, "idle");
    const state = JSON.parse(readFileSync(join(fx.repo, ".alinery", "tasks", taskSlug, "execution.json"), "utf8"));
    expect(state.executions[executionId]).toMatchObject({ lifecycle: "running", permission: { kind: "locked" } });
    // A lost acknowledgement can safely be reconciled even once that run has finished.
    await other.nudgeExecution(nudge);
    await expect(execution.nudgeExecution({ ...nudge, meta: newMeta() })).rejects.toMatchObject({ code: Code.FailedPrecondition });
    expect(requests).toHaveLength(4);
  } finally {
    for (const round of rounds) round.finish.resolve();
    await daemon?.stop();
    provider.stop(true);
    rmSync(fx.root, { recursive: true, force: true });
  }
}, 45_000);
