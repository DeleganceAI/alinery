// The queue over the real wire: a prompt sent while a turn runs answers with its submission id and `queued`, the frame
// beside the items carries the item under that id, and the remove call withdraws it (or says it is a message already).
// A real daemon on a fixture repository, and a local OpenAI-compatible provider that holds the turn open.
import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { ChatService } from "alinery-proto/alinery/v1/chat_pb";
import { RemoveQueuedMessageOutcome, SessionService } from "alinery-proto/alinery/v1/sessions_pb";
import { firstFrame, heldProvider, startedTask, waitForSession, writeInference } from "../mcpServer/busySession.testutil.ts";
import { newMeta } from "../mcpServer/client.ts";
import { startDaemon } from "../mcpServer/daemonFixture.testutil.ts";
import { buildFixture } from "../mcpServer/fixtureRepo.testutil.ts";

test("a prompt sent while a turn runs answers with its id and status, the frame carries the item under that id, and remove withdraws it everywhere", async () => {
  const fx = await buildFixture();
  const provider = heldProvider();
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    writeInference(fx.appConfig, provider.port);
    daemon = await startDaemon(fx);
    const { connection, taskSlug } = await startedTask(daemon);
    await provider.received;
    const session = await waitForSession(connection, taskSlug, "busy");
    const sessionId = session.id;
    const sessions = connection.api(SessionService);
    const before = await firstFrame(connection, taskSlug, sessionId);
    expect(before.queued).toBeDefined();
    expect(before.queued?.items).toHaveLength(0);

    // A busy prompt: admitted, waiting, and identified by the id the reply returns.
    const busy = await sessions.promptSession({ meta: newMeta(), sessionId, text: "wait for the turn" });
    expect(busy.status).toBe("queued");
    expect(busy.submissionId).not.toBe("");
    const frame = await firstFrame(connection, taskSlug, sessionId);
    expect(frame.queued?.items.map((item) => item.id)).toEqual([busy.submissionId]);
    expect(frame.queued?.items[0]).toMatchObject({ mode: "followUp", text: "wait for the turn" });
    // The queue is beside the items, never one of them.
    expect(frame.items.some((item) => item.content.some((part) => part.kind.case === "text" && part.kind.value === "wait for the turn"))).toBe(false);

    // A repeated mutation answers the original id and queues the input once.
    const meta = newMeta();
    const first = await sessions.promptSession({ meta, sessionId, text: "only once" });
    const again = await sessions.promptSession({ meta, sessionId, text: "only once" });
    expect([first.status, first.submissionId]).toEqual(["queued", first.submissionId]);
    expect(again.submissionId).toBe(first.submissionId);
    expect((await firstFrame(connection, taskSlug, sessionId)).queued?.items.map((item) => item.id)).toEqual([busy.submissionId, first.submissionId]);

    // Two windows read one feed: the item is in both, and gone from both once removed.
    const one = firstFrame(connection, taskSlug, sessionId);
    const two = firstFrame(connection, taskSlug, sessionId);
    expect((await one).queued?.items.map((item) => item.id)).toEqual([busy.submissionId, first.submissionId]);
    expect((await two).queued?.items.map((item) => item.id)).toEqual([busy.submissionId, first.submissionId]);

    const itemsBefore = (await firstFrame(connection, taskSlug, sessionId)).items.length;
    expect((await sessions.removeQueuedMessage({ meta: newMeta(), sessionId, submissionId: busy.submissionId })).outcome).toBe(RemoveQueuedMessageOutcome.REMOVED);
    const after = await firstFrame(connection, taskSlug, sessionId);
    expect(after.queued?.items.map((item) => item.id)).toEqual([first.submissionId]);
    expect(after.items).toHaveLength(itemsBefore);
    // Removed is removed: the same id is not found again, and no message appeared for it.
    expect((await sessions.removeQueuedMessage({ meta: newMeta(), sessionId, submissionId: busy.submissionId })).outcome).toBe(RemoveQueuedMessageOutcome.NOT_FOUND);
    expect(await sessions.removeQueuedMessage({ meta: newMeta(), sessionId, submissionId: "no-such-submission" })).toMatchObject({
      outcome: RemoveQueuedMessageOutcome.NOT_FOUND,
    });
  } finally {
    provider.release();
    await daemon?.stop();
    provider.stop();
    rmSync(fx.root, { recursive: true, force: true });
  }
}, 45_000);

test("a placed input is a message, not a queue item: remove answers NOT_QUEUED, an idle prompt answers placed, and an id the session never issued is NOT_FOUND", async () => {
  const fx = await buildFixture();
  const provider = heldProvider();
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    writeInference(fx.appConfig, provider.port);
    daemon = await startDaemon(fx);
    const { connection, taskSlug } = await startedTask(daemon);
    await provider.received;
    const session = await waitForSession(connection, taskSlug, "busy");
    const sessionId = session.id;
    const sessions = connection.api(SessionService);

    const busy = await sessions.promptSession({ meta: newMeta(), sessionId, text: "delivered next" });
    expect(busy.status).toBe("queued");
    provider.release();
    await waitForSession(connection, taskSlug, "idle");

    // The turn took it: it is an ordinary user message now, and remove says so without an error.
    const placed = await firstFrame(connection, taskSlug, sessionId);
    expect(placed.queued?.items ?? []).toHaveLength(0);
    expect(placed.items.filter((item) => item.role === "user" && item.content.some((part) => part.kind.case === "text" && part.kind.value === "delivered next"))).toHaveLength(1);
    expect((await sessions.removeQueuedMessage({ meta: newMeta(), sessionId, submissionId: busy.submissionId })).outcome).toBe(RemoveQueuedMessageOutcome.NOT_QUEUED);

    // Nothing runs, so the next prompt is placed at once.
    const idle = await sessions.promptSession({ meta: newMeta(), sessionId, text: "straight in" });
    expect(idle.status).toBe("placed");
    expect(idle.submissionId).not.toBe("");
    expect((await sessions.removeQueuedMessage({ meta: newMeta(), sessionId, submissionId: idle.submissionId })).outcome).toBe(RemoveQueuedMessageOutcome.NOT_QUEUED);

    // A chat thread's prompt carries the same two fields. An id is only ever resolved inside the addressed session, so a
    // number that session never issued — and a non-numeric string — is NOT_FOUND.
    const thread = await connection.api(ChatService).createChatThread({ meta: newMeta(), model: "alinery/queued", createWorktree: false });
    const threadId = thread.started!.session!["id"] as string;
    const chatPrompt = await connection.api(ChatService).promptChatThread({ meta: newMeta(), threadId, text: "thread words" });
    expect(chatPrompt.status).toBe("placed");
    expect(chatPrompt.submissionId).not.toBe("");
    expect((await sessions.removeQueuedMessage({ meta: newMeta(), sessionId, submissionId: "999999" })).outcome).toBe(RemoveQueuedMessageOutcome.NOT_FOUND);
    expect((await sessions.removeQueuedMessage({ meta: newMeta(), sessionId, submissionId: "not-a-number" })).outcome).toBe(RemoveQueuedMessageOutcome.NOT_FOUND);
  } finally {
    provider.release();
    await daemon?.stop();
    provider.stop();
    rmSync(fx.root, { recursive: true, force: true });
  }
}, 60_000);
