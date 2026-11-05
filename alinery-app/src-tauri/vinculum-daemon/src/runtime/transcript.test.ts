import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels } from "@earendil-works/pi-ai/models";
import type { TranscriptReply } from "../transcript.ts";
import { eventsChanges, watchTranscript, type TranscriptFrame, type TranscriptFeed } from "./transcript.ts";

const text = (id: string, role: "user" | "assistant", body: string, streaming = false): TranscriptReply => ({
  id,
  role,
  ...(streaming ? { streaming: true } : {}),
  content: [{ type: "text", text: body }],
});
const CONTROLS = { model: "p/m", thinking: "off", thinking_levels: [] };

/** A source whose list the test edits, and whose change signal the test fires. */
function fake(initial: TranscriptReply[]) {
  const state = { items: initial, controls: CONTROLS, reads: 0, subscribers: 0 };
  let notify: (() => void) | undefined;
  const source: TranscriptFeed = {
    read: async () => ({ items: structuredClone(state.items), controls: state.controls }),
    subscribe: (n) => {
      notify = n;
      state.subscribers += 1;
      return () => {
        state.subscribers -= 1;
      };
    },
  };
  return { source, state, change: (items: TranscriptReply[]) => ((state.items = items), notify?.()) };
}

/** Pull `count` frames, then abort. */
async function frames(gen: AsyncGenerator<TranscriptFrame>, count: number, between: () => void = () => {}): Promise<TranscriptFrame[]> {
  const out: TranscriptFrame[] = [];
  for (let i = 0; i < count; i += 1) {
    if (i > 0) between();
    const next = await gen.next();
    if (next.done) break;
    out.push(next.value);
  }
  return out;
}

test("from item 0 the first frame is everything", async () => {
  const { source } = fake([text("u1", "user", "hi"), text("a1", "assistant", "hello")]);
  const ac = new AbortController();
  const [first] = await frames(watchTranscript(source, 0, ac.signal, 0), 1);
  ac.abort();
  expect(first?.items.map((i) => i.id)).toEqual(["u1", "a1"]);
  expect(first).toMatchObject({ nextItem: 2, replace: false, controls: CONTROLS });
});

test("an append sends only the new item", async () => {
  const f = fake([text("u1", "user", "hi")]);
  const ac = new AbortController();
  const got = await frames(watchTranscript(f.source, 0, ac.signal, 0), 2, () => f.change([...f.state.items, text("a1", "assistant", "yo")]));
  ac.abort();
  expect(got[1]?.items.map((i) => i.id)).toEqual(["a1"]);
  expect(got[1]).toMatchObject({ nextItem: 2, replace: false });
  expect(got[1]?.controls).toBeUndefined();
});

test("editing the last item sends it with replace", async () => {
  const f = fake([text("u1", "user", "hi"), text("live", "assistant", "He", true)]);
  const ac = new AbortController();
  const got = await frames(watchTranscript(f.source, 0, ac.signal, 0), 2, () => f.change([f.state.items[0]!, text("live", "assistant", "Hello", true)]));
  ac.abort();
  expect(got[1]?.replace).toBe(true);
  expect(got[1]?.nextItem).toBe(2);
  expect(got[1]?.items).toHaveLength(1);
  expect(got[1]?.items[0]?.content).toEqual([{ type: "text", text: "Hello" }]);
});

test("a change before the last item sends everything from it, and a shorter list sends none with replace", async () => {
  const f = fake([text("a", "user", "1"), text("b", "assistant", "2"), text("c", "assistant", "3")]);
  const ac = new AbortController();
  const gen = watchTranscript(f.source, 0, ac.signal, 0);
  const got = await frames(gen, 2, () => f.change([f.state.items[0]!, text("b", "assistant", "2!"), f.state.items[2]!]));
  expect(got[1]).toMatchObject({ replace: true, nextItem: 3 });
  expect(got[1]?.items.map((i) => i.id)).toEqual(["b", "c"]);
  f.change(f.state.items.slice(0, 2));
  const shrunk = await gen.next();
  ac.abort();
  expect(shrunk.value).toMatchObject({ replace: true, nextItem: 2, items: [] });
});

test("resuming at next_item sends nothing old, then only what follows", async () => {
  const f = fake([text("u1", "user", "hi"), text("a1", "assistant", "yo")]);
  const ac = new AbortController();
  const got = await frames(watchTranscript(f.source, 2, ac.signal, 0), 2, () => f.change([...f.state.items, text("u2", "user", "more")]));
  ac.abort();
  expect(got[0]).toMatchObject({ items: [], nextItem: 2, replace: false });
  expect(got[1]?.items.map((i) => i.id)).toEqual(["u2"]);
  expect(got[1]).toMatchObject({ nextItem: 3, replace: false });
});

test("a client ahead of the list starts over from item 0", async () => {
  const { source } = fake([text("u1", "user", "hi")]);
  const ac = new AbortController();
  const [first] = await frames(watchTranscript(source, 9, ac.signal, 0), 1);
  ac.abort();
  expect(first).toMatchObject({ nextItem: 1, replace: true });
  expect(first?.items).toHaveLength(1);
});

test("a controls change alone is a frame; abort ends the stream and unsubscribes", async () => {
  const f = fake([text("u1", "user", "hi")]);
  const ac = new AbortController();
  const gen = watchTranscript(f.source, 1, ac.signal, 0);
  await gen.next();
  expect(f.state.subscribers).toBe(1);
  f.state.controls = { ...CONTROLS, thinking: "high" };
  f.change(f.state.items);
  const second = await gen.next();
  expect(second.value).toMatchObject({ items: [], nextItem: 1, replace: false, controls: { thinking: "high" } });
  const pending = gen.next();
  ac.abort();
  expect((await pending).done).toBe(true);
  expect(f.state.subscribers).toBe(0);
});

test("a change with nothing new sends no frame", async () => {
  const f = fake([text("u1", "user", "hi")]);
  const ac = new AbortController();
  const gen = watchTranscript(f.source, 0, ac.signal, 0);
  await gen.next();
  f.change(f.state.items);
  const pending = gen.next();
  const raced = await Promise.race([pending.then(() => "frame"), Bun.sleep(80).then(() => "quiet")]);
  expect(raced).toBe("quiet");
  ac.abort();
  expect((await pending).done).toBe(true);
});

test("eventsChanges fires on a real harness commit and stops cleanly", async () => {
  const storage = await openNodeSqliteStorage(join(mkdtempSync(join(tmpdir(), "transcript-")), "a.sqlite"));
  const harness = await Harness.open(storage, { models: createModels(), registry: createRegistry(), env: () => { throw new Error("unused"); } } as never, BACKGROUND_CONTEXT);
  const root = await harness.root(BACKGROUND_CONTEXT);
  let fired = 0;
  const stop = eventsChanges(harness, root.id, BACKGROUND_CONTEXT)(() => {
    fired += 1;
  });
  await Bun.sleep(100);
  const settled = fired;
  await root.configure({ thinkingLevel: "low" }, BACKGROUND_CONTEXT);
  await Bun.sleep(100);
  expect(fired).toBeGreaterThan(settled);
  stop();
  const after = fired;
  await root.configure({ thinkingLevel: "high" }, BACKGROUND_CONTEXT);
  await Bun.sleep(100);
  expect(fired).toBe(after);
});
