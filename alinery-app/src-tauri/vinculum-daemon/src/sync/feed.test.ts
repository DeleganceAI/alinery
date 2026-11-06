import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAtomic } from "../platform/fs.ts";
import { Feed } from "./feed.ts";
import { sessionMeta } from "./parsers/sessionMeta.ts";
import { Reconciler } from "./reconcile.ts";
import { Store } from "./store.ts";
import { FakeTimers, taskScope } from "./testkit.ts";
import { Watcher } from "./watcher.ts";

const meta = (id: string, extra: object = {}) => JSON.stringify({ id, worktree: "/w", created: 1, ...extra });
let dir: string;
let alinery: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "feed-"));
  alinery = join(dir, ".alinery");
  mkdirSync(join(alinery, "tasks", "t", "sessions"), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const metaFile = (slug: string, id: string) => join(alinery, "tasks", slug, "sessions", `${id}.meta.json`);

async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(5);
  }
}

describe("watcher into the store", () => {
  test("write, rename over, delete give put, put, delete; the same bytes again give nothing", async () => {
    const store = new Store({ coalesceMs: 0 });
    const feed = new Feed(store, alinery);
    await feed.scan();
    const watcher = new Watcher(alinery, (rel) => void feed.refresh(rel), { debounceMs: 10 });
    watcher.start();
    const ops: string[] = [];
    const ac = new AbortController();
    void (async () => {
      for await (const f of store.open(taskScope("t"), undefined, ac.signal)) {
        if (f.frame.case === "delta") for (const c of f.frame.value.changes) ops.push(c.op.case as string);
      }
    })();
    try {
      const path = metaFile("t", "s1");
      writeFileSync(path, meta("s1"));
      await until(() => ops.length === 1);
      writeAtomic(path, meta("s1", { phase: "build" })); // tmp file, then rename over
      await until(() => ops.length === 2);
      const seq = store.seq;
      writeAtomic(path, meta("s1", { phase: "build" })); // same bytes
      await Bun.sleep(150);
      expect(store.seq).toBe(seq);
      rmSync(path);
      await until(() => ops.length === 3);
      expect(ops).toEqual(["put", "put", "delete"]);
      expect(store.get("session/t/s1")).toBeUndefined();
    } finally {
      ac.abort();
      watcher.stop();
    }
  });

  test("a scrollback append, even 1 MB of it, calls no parser; a meta write does", async () => {
    const store = new Store();
    const feed = new Feed(store, alinery);
    const seen: string[] = [];
    const watcher = new Watcher(alinery, (rel) => (seen.push(rel), void feed.refresh(rel)), { debounceMs: 10 });
    watcher.start();
    const parse = spyOn(sessionMeta, "parse");
    try {
      const scroll = join(alinery, "tasks", "t", "sessions", "s1.scrollback");
      writeFileSync(scroll, "");
      appendFileSync(scroll, Buffer.alloc(1024 * 1024, 65));
      await Bun.sleep(200);
      expect(parse).not.toHaveBeenCalled();
      expect(seen.filter((r) => r.endsWith(".scrollback"))).toEqual([]); // dropped by name, before the debounce
      writeFileSync(metaFile("t", "s1"), meta("s1"));
      await until(() => parse.mock.calls.length > 0);
    } finally {
      watcher.stop();
      parse.mockRestore();
    }
  });
});

describe("reconcile", () => {
  test("with no watcher, a change, a new file and a deletion appear after one pass of the injected clock", async () => {
    writeFileSync(metaFile("t", "keep"), meta("keep"));
    writeFileSync(metaFile("t", "gone"), meta("gone"));
    const store = new Store();
    const feed = new Feed(store, alinery);
    await feed.scan();
    expect(store.size).toBe(2);
    const timers = new FakeTimers();
    const rec = new Reconciler(feed, { timers });
    rec.start();
    writeFileSync(metaFile("t", "keep"), meta("keep", { phase: "plan" })); // size changes
    writeFileSync(metaFile("t", "new"), meta("new"));
    rmSync(metaFile("t", "gone"));
    timers.tick(29_999);
    await rec.pass;
    expect(store.size).toBe(2); // not yet
    timers.tick(1);
    await rec.pass;
    const phase = (key: string) => (store.get(key)?.value.case === "session" ? store.get(key)?.value.value.phase : undefined);
    expect(phase("session/t/keep")).toBe("plan");
    expect(store.get("session/t/new")).toBeDefined();
    expect(store.get("session/t/gone")).toBeUndefined();
    rec.stop();
    expect(timers.count).toBe(0);
  });

  test("a rename-over that keeps size and is seen only by mtime is re-read", async () => {
    const path = metaFile("t", "s");
    writeFileSync(path, meta("s", { phase: "aaaa" }));
    const store = new Store();
    const feed = new Feed(store, alinery);
    await feed.scan();
    const other = `${path}.other`;
    writeFileSync(other, meta("s", { phase: "bbbb" }));
    const later = new Date(Date.now() + 5000);
    (await import("node:fs")).utimesSync(other, later, later);
    renameSync(other, path);
    expect(await feed.reconcile()).toBe(1);
    expect(store.get("session/t/s")?.value.case === "session" && store.get("session/t/s")?.value.value.phase).toBe("bbbb");
  });

  test("over 1,000 tasks the pass never holds the event loop for 20 ms", async () => {
    for (let i = 0; i < 1000; i++) {
      const sessions = join(alinery, "tasks", `task-${i}`, "sessions");
      mkdirSync(sessions, { recursive: true });
      mkdirSync(join(alinery, "tasks", `task-${i}`, "artifacts"));
      for (let j = 0; j < 3; j++) writeFileSync(join(sessions, `s${j}.meta.json`), meta(`s${j}`));
    }
    const store = new Store();
    const feed = new Feed(store, alinery);
    await feed.scan();
    expect(store.size).toBe(3000);
    let maxGap = 0;
    let last = performance.now();
    const tick = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
    }, 1);
    await feed.reconcile();
    clearInterval(tick);
    console.log(`reconcile over 1,000 tasks: longest loop gap ${maxGap.toFixed(1)} ms`);
    expect(maxGap).toBeLessThan(20);
  });
});
