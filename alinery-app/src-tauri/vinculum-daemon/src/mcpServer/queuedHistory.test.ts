// The agent's read of a live conversation: the waiting inputs ride beside the messages as `queued`, are not counted in
// `total`, and are absent — not empty — when the frame carried no queue (a retained session, or an older daemon).
import { expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SessionService } from "alinery-proto/alinery/v1/sessions_pb";
import { firstFrame, heldProvider, startedTask, waitForSession, writeInference } from "./busySession.testutil.ts";
import { newMeta } from "./client.ts";
import { startDaemon } from "./daemonFixture.testutil.ts";
import { Endpoints } from "./endpoints.ts";
import { buildFixture } from "./fixtureRepo.testutil.ts";
import { callTool, queuedJson } from "./handlers.ts";

test("a waiting input rides beside the messages in the agent's history read, is never counted, and is absent on a retained read", async () => {
  const fx = await buildFixture();
  const provider = heldProvider();
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    writeInference(fx.appConfig, provider.port);
    daemon = await startDaemon(fx);
    const running = daemon;
    const { connection, taskSlug } = await startedTask(running);
    await provider.received;
    const sessionId = (await waitForSession(connection, taskSlug, "busy")).id;
    const sessions = connection.api(SessionService);

    // One input with words, one with words and a picture: the panel and the tool read the same two. (A prompt needs
    // words — the daemon refuses an empty one — so an image-only item cannot arrive this way; `queuedJson` below covers
    // the empty text the frame can still carry.)
    const words = await sessions.promptSession({ meta: newMeta(), sessionId, text: "hold this thought" });
    const picture = await sessions.promptSession({
      meta: newMeta(),
      sessionId,
      text: "and this picture",
      images: [{ mimeType: "image/png", name: "sketch.png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) }],
    });
    expect([words.status, picture.status]).toEqual(["queued", "queued"]);
    const frame = await firstFrame(connection, taskSlug, sessionId);

    const ctx = running.context({ endpoints: new Endpoints(undefined, () => ({ [fx.repo]: { socket: running.socket, token: running.token } })) });
    const read = JSON.parse((await callTool(ctx, "alinery_read_session_history", { repo: fx.repo, task_slug: taskSlug, session_id: sessionId })).content[0].text) as {
      items: unknown[];
      queued?: { id: string; mode: string; text: string; images: string[]; status: string }[];
      total: number;
      offset: number;
      next_offset: number;
      eof: boolean;
    };
    expect(read.queued).toEqual([
      { id: words.submissionId, mode: "followUp", text: "hold this thought", images: [], status: "accepted_not_delivered" },
      { id: picture.submissionId, mode: "followUp", text: "and this picture", images: ["sketch.png"], status: "accepted_not_delivered" },
    ]);
    // They are not messages: the page counts only the transcript's own items, and holds no queued input among them.
    expect(read.total).toBe(frame.items.length);
    expect(read.items).toHaveLength(read.total);
    expect(JSON.stringify(read.items)).not.toContain("hold this thought");
    expect(JSON.stringify(read.items)).not.toContain("sketch.png");

    // Every page repeats the same list, so paging can neither drop it nor duplicate it.
    const first = JSON.parse((await callTool(ctx, "alinery_read_session_history", { repo: fx.repo, task_slug: taskSlug, session_id: sessionId, offset: 0, limit: 1 })).content[0].text) as { queued?: unknown; total: number; next_offset: number };
    expect(first.queued).toEqual(read.queued);
    expect([first.total, first.next_offset]).toEqual([read.total, 1]);

    // A retained session's frame carries no queue at all, so the answer has no `queued` key rather than an empty list:
    // the conversation of a session the daemon is not running, read from its own database (as `sessions.test.ts` makes one).
    const retainedId = "retained-draft";
    const base = join(fx.repo, ".alinery", "tasks", taskSlug, "sessions", retainedId);
    const harness = await Harness.open(await openNodeSqliteStorage(`${base}.pi.sqlite`), { registry: createRegistry(), models: createModels() } as never, BACKGROUND_CONTEXT);
    try {
      const root = await harness.root(BACKGROUND_CONTEXT);
      await root.commit((tx) => tx.appendEntry(root.id, { kind: "message", model: [{ role: "user", content: "This draft survived.", timestamp: 10 }] }), BACKGROUND_CONTEXT);
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
    // Its row says Vinculum — the harness the tool routes on — and that it ended; the live session's own meta is the shape.
    const live = JSON.parse(readFileSync(join(fx.repo, ".alinery", "tasks", taskSlug, "sessions", `${sessionId}.meta.json`), "utf8")) as Record<string, unknown>;
    writeFileSync(`${base}.meta.json`, JSON.stringify({ ...live, id: retainedId, ended_at: Math.floor(Date.now() / 1000) }));
    const readRetained = async () => {
      const reply = await callTool(ctx, "alinery_read_session_history", { repo: fx.repo, task_slug: taskSlug, session_id: retainedId });
      expect(reply.isError).toBeUndefined();
      return JSON.parse(reply.content[0].text) as Record<string, unknown>;
    };
    let ended = await readRetained();
    for (let tries = 0; tries < 100 && ended.mode !== "transcript"; tries += 1) {
      await Bun.sleep(100);
      ended = await readRetained();
    }
    expect(ended.mode).toBe("transcript");
    expect(Object.hasOwn(ended, "queued")).toBe(false);
    expect(JSON.stringify(ended.items)).toContain("This draft survived.");
  } finally {
    provider.release();
    await daemon?.stop();
    provider.stop();
    rmSync(fx.root, { recursive: true, force: true });
  }
}, 60_000);

test("one waiting input for a model: its id, mode, text and image names, and the fact that it is not a message", () => {
  expect(queuedJson({ id: "12", mode: "steer", text: "short", images: [{ mimeType: "image/png", name: "a.png" }] })).toEqual({
    id: "12",
    mode: "steer",
    text: "short",
    images: ["a.png"],
    status: "accepted_not_delivered",
  });
  // An image-only input is not a blank line: the names are what identifies it.
  expect(queuedJson({ id: "13", mode: "followUp", text: "", images: [{ mimeType: "image/png", name: "b.png" }] })).toMatchObject({ text: "", images: ["b.png"] });
  // Long text is clipped like every other part the tool answers.
  expect(String(queuedJson({ id: "14", mode: "followUp", text: "x".repeat(5000), images: [] }).text)).toContain("[1000 more characters]");
});
