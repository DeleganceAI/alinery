import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createRegistry, Harness, LiveDoc } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { expect, test } from "bun:test";
import { retainedTranscript } from "../domain/history.ts";
import { formatTranscript } from "../transcript.ts";
import { committedTurnMessages, latestFailedTurn, retryFailedTurn } from "./failedTurn.ts";

test("only an exhausted provider turn can retry, once, in the same durable conversation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vinculum-failed-turn-"));
  const sessions = join(dir, ".alinery", "sessions");
  await mkdir(sessions, { recursive: true });
  const path = join(sessions, "session.pi.sqlite");
  await writeFile(join(sessions, "session.meta.json"), JSON.stringify({ id: "session" }));
  const models = builtinModels();
  const model = models.getModels()[0]!;
  const enteredRetry = Promise.withResolvers<void>();
  const endRetry = Promise.withResolvers<void>();
  let attempts = 0;
  let abortDuringBackoff = false;
  models.streamSimple = () => {
    const stream = createAssistantMessageEventStream();
    const attempt = ++attempts;
    const fail = attempt <= 2 || abortDuringBackoff;
    const text = "503 Service unavailable";
    const message: AssistantMessage = {
      role: "assistant", provider: model.provider, model: model.id, api: model.api, timestamp: Date.now(),
      content: [{ type: "text", text: fail ? "Partial reply" : "Recovered" }],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: fail ? "error" : "stop", ...(fail ? { errorMessage: text } : {}),
    };
    void (async () => {
      if (attempt === 2) {
        enteredRetry.resolve();
        await endRetry.promise;
      }
      if (fail) stream.push({ type: "error", reason: "error", error: message });
      else stream.push({ type: "done", reason: "stop", message });
      stream.end();
    })();
    return stream;
  };
  const open = async () => Harness.open(await openNodeSqliteStorage(path), {
    models, registry: createRegistry(), env: () => new NodeExecutionEnv({ cwd: dir }),
    settings: () => ({ retry: { enabled: true, maxRetries: 1, baseDelayMs: abortDuringBackoff ? 60_000 : 1 } }),
  }, ctx);
  let harness = await open();
  try {
    let conversation = await harness.root(ctx, { agent: { model: { provider: model.provider, modelId: model.id } } });
    const sending = await conversation.submit({ type: "input", content: "Do the work" }, ctx);
    await enteredRetry.promise;
    expect(await latestFailedTurn(conversation)).toBeUndefined();
    expect((await committedTurnMessages(conversation)).some((m) => m.turnError)).toBe(false);
    const queued = await conversation.submit({ type: "input", content: "Already queued", whenBusy: "followUp" }, ctx);
    expect((await queued.status(ctx)).status).toBe("queued");
    endRetry.resolve();
    expect(await sending.wait(ctx)).toMatchObject({ status: "unanswered", reason: "model_error" });
    await conversation.waitForIdle(ctx);
    const failure = await latestFailedTurn(conversation);
    expect(failure?.reason).toContain("503 Service unavailable");
    const expected = [{ id: failure!.id, role: "assistant", turnError: failure!.reason, content: [{ type: "text", text: "Partial reply" }] }];
    expect(formatTranscript(await committedTurnMessages(conversation)).filter((item) => item.turnError)).toMatchObject(expected);
    await harness.close(ctx);
    expect(retainedTranscript(dir, "", "session")?.items.filter((item) => item.turnError)).toMatchObject(expected);
    harness = await open();
    conversation = await harness.root(ctx);
    expect(await latestFailedTurn(conversation)).toEqual(failure);
    const failedId = failure!.id;
    const submitWork = async (check: () => Promise<boolean>, send: () => Promise<void>) => { if (await check()) await send(); };
    await expect(retryFailedTurn(conversation, "stale-entry", submitWork)).rejects.toThrow();
    await retryFailedTurn(conversation, failedId, submitWork);
    await conversation.waitForIdle(ctx);
    await retryFailedTurn(conversation, failedId, submitWork);
    const users = formatTranscript(await committedTurnMessages(conversation)).filter((item) => item.role === "user").map((item) => item.content);
    expect(users).toEqual(["Do the work", "Already queued", "Continue from where the failed turn stopped."].map((text) => [{ type: "text", text }]));
    expect(await latestFailedTurn(conversation)).toBeUndefined();

    // Cancelling during backoff leaves a stored assistant error, but the generation's outcome is aborted.
    abortDuringBackoff = true;
    const waiting = Promise.withResolvers<void>();
    const watch = (await harness.watchDoc(LiveDoc, conversation.id, ctx))!;
    watch.start(async (live) => { if (live.generation?.retry) waiting.resolve(); });
    const stop = await conversation.submit({ type: "input", content: "Cancel this one" }, ctx);
    await waiting.promise;
    await conversation.abort(ctx);
    expect(await stop.wait(ctx)).toMatchObject({ status: "unanswered", reason: "aborted" });
    expect(await latestFailedTurn(conversation)).toBeUndefined();
    expect(formatTranscript(await committedTurnMessages(conversation)).filter((item) => item.turnError)).toMatchObject(expected);
    await watch.stop();
  } finally {
    endRetry.resolve();
    await harness.close(ctx);
    await rm(dir, { recursive: true, force: true });
  }
});
