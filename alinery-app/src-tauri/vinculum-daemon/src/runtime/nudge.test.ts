import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { expect, test } from "bun:test";
import { WRAP_UP_NUDGE } from "../../../../shared/wrapUpNudge.ts";
import { retainedTranscript } from "../domain/history.ts";
import { formatTranscript } from "../transcript.ts";
import { committedTurnMessages } from "./failedTurn.ts";
import { steerWrapUp } from "./nudge.ts";

test.each(["answer", "abort", "reset", "provider failure"])("a nudge receipt survives SQLite reopen after %s", async (outcome) => {
  const dir = await mkdtemp(join(tmpdir(), "vinculum-nudge-"));
  const sessions = join(dir, ".alinery", "sessions");
  await mkdir(sessions, { recursive: true });
  await writeFile(join(sessions, "session.meta.json"), JSON.stringify({ id: "session" }));
  const models = builtinModels();
  const model = models.getModels()[0]!;
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let attempts = 0;
  models.streamSimple = (_model, _request, options) => {
    const stream = createAssistantMessageEventStream();
    const first = ++attempts === 1;
    const publish = () => {
      const failed = first && outcome === "provider failure";
      const message: AssistantMessage = {
        role: "assistant", provider: model.provider, model: model.id, api: model.api, timestamp: Date.now(),
        content: [{ type: "text", text: "Done" }], stopReason: failed ? "error" : "stop",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        ...(failed ? { errorMessage: "Fixture rejected the request" } : {}),
      };
      if (failed) stream.push({ type: "error", reason: "error", error: message });
      else stream.push({ type: "done", reason: "stop", message });
      stream.end();
    };
    if (first) {
      started.resolve();
      options?.signal?.addEventListener("abort", () => release.resolve(), { once: true });
      void release.promise.then(publish);
    } else publish();
    return stream;
  };
  const open = async () => Harness.open(await openNodeSqliteStorage(join(sessions, "session.pi.sqlite")), {
    models, registry: createRegistry(), env: () => new NodeExecutionEnv({ cwd: dir }), settings: () => ({ retry: { enabled: false } }),
  }, ctx);
  let harness = await open();
  try {
    let conversation = await harness.root(ctx, { agent: { model: { provider: model.provider, modelId: model.id } } });
    // Typing the exact wrap-up instruction is an ordinary user message.
    const work = await conversation.submit({ type: "input", content: WRAP_UP_NUDGE }, ctx);
    const runId = String(work.id);
    await started.promise;
    const checkOwner = async () => {};
    await steerWrapUp(conversation, runId, "click", checkOwner);
    expect((await committedTurnMessages(conversation)).some((message) => message.nudgeDeliveryId)).toBe(false);
    if (outcome === "abort") await conversation.abort(ctx);
    if (outcome === "reset") await conversation.reset(undefined, ctx);
    release.resolve();
    await conversation.waitForIdle(ctx);
    const userItems = formatTranscript(await committedTurnMessages(conversation)).filter((item) => item.role === "user");
    expect(userItems.map((item) => item.nudgeDeliveryId)).toEqual(outcome === "answer" ? [undefined, "click"] : [undefined]);
    for (const item of userItems) expect(item.content).toEqual([{ type: "text", text: WRAP_UP_NUDGE }]);
    await harness.close(ctx);
    expect(retainedTranscript(dir, "", "session")?.items.filter((item) => item.role === "user")).toEqual(userItems);
    harness = await open();
    conversation = await harness.root(ctx);
    const replay = steerWrapUp(conversation, runId, "click", checkOwner);
    if (outcome === "answer") await replay;
    else await expect(replay).rejects.toThrow("before the agent received");
    await expect(steerWrapUp(conversation, runId, "new-click", checkOwner)).rejects.toThrow("no longer running");
    expect(attempts).toBe(outcome === "answer" ? 2 : 1);
  } finally {
    release.resolve();
    await harness.close(ctx);
    await rm(dir, { recursive: true, force: true });
  }
});
