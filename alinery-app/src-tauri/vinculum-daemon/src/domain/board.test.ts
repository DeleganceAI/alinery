import { toJson } from "@bufbuild/protobuf";
import { EntitySchema, type Task } from "alinery-proto/alinery/v1/entities_pb";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Feed } from "../sync/feed.ts";
import { Store } from "../sync/store.ts";
import { normalize } from "../sync/testkit.ts";
import { BoardProjector } from "./board.ts";
import { type LiveRow, SessionPublisher } from "./sessions.ts";

const ROOT = resolve(import.meta.dir, "../../../conformance/board");

function rig(alinery: string, rows: Map<string, LiveRow> = new Map()) {
  const store = new Store();
  const board = new BoardProjector(store, alinery);
  const feed = new Feed(store, alinery, (e) => board.decorate(publisher.decorate(e)), board.dependents);
  const publisher: SessionPublisher = new SessionPublisher(store, feed, () => rows.values(), { protocol: 25, buildId: "test" });
  const task = (slug: string): Task | undefined => {
    const e = store.get(`task/${slug}/${slug}`);
    return e?.value.case === "task" ? e.value.value : undefined;
  };
  return { store, feed, publisher, task };
}

describe("board conformance (the fields board_task derives)", () => {
  for (const name of readdirSync(ROOT)) {
    test(name, async () => {
      const t = rig(join(ROOT, name, "input", ".alinery"));
      await t.feed.scan();
      const actual: Record<string, unknown> = {};
      for (const { key } of t.feed.tracked.values()) {
        const entity = t.store.get(key);
        if (!entity || entity.value.case !== "task") continue;
        const { board } = (toJson(EntitySchema, entity, { useProtoFieldName: true }) as { task: { board: Record<string, unknown> } }).task;
        const { updated: _u, total_sessions: _t, ...fields } = board;
        actual[key] = fields;
      }
      expect(normalize(actual)).toEqual(normalize(JSON.parse(readFileSync(join(ROOT, name, "expected.json"), "utf8"))));
    });
  }
});

// A scratch .alinery with one task, for the cases the fixtures can't hold (live state, time).
function scratch(taskText = 'name = "T"\nslug = "t"\nbranch = "t"\nworktree = "/w"\ncreated = 5\nplaybook = "p"\n') {
  const alinery = join(mkdtempSync(join(tmpdir(), "vinculum-board-")), ".alinery");
  mkdirSync(join(alinery, "tasks", "t", "sessions"), { recursive: true });
  writeFileSync(join(alinery, "tasks", "t", "task.md"), taskText);
  const meta = (slug: string, id: string, extra: object = {}) => {
    mkdirSync(join(alinery, "tasks", slug, "sessions"), { recursive: true });
    writeFileSync(join(alinery, "tasks", slug, "sessions", `${id}.meta.json`), JSON.stringify({ id, worktree: "/w", created: 1, playbook: "p", phase: "clarify", ...extra }));
  };
  return { alinery, meta };
}
const live = (taskSlug: string, id: string, agent: string, process = "alive", playbook = "in_progress"): LiveRow => ({
  id,
  taskSlug,
  process: { state: process },
  agent: { state: agent },
  playbook: { state: playbook },
  adapter: "omp",
  message_adapter: "unsupported",
});

describe("board derived fields follow their inputs", () => {
  test("a session meta written after the scan reaches the task row", async () => {
    const s = scratch();
    const t = rig(s.alinery);
    await t.feed.scan();
    expect(t.task("t")?.board?.latestSessionTitle).toBe("No sessions");
    s.meta("t", "a", { phase: "plan" });
    await t.feed.refresh("tasks/t/sessions/a.meta.json");
    expect(t.task("t")?.board).toMatchObject({ sessionCount: 1n, totalSessions: 1n, currentPhase: "plan", latestSessionTitle: "plan" });
  });
  test("an artifact moves `updated`; an attachment does not", async () => {
    const s = scratch();
    const t = rig(s.alinery);
    await t.feed.scan();
    const before = t.task("t")?.board?.updated;
    const dir = join(s.alinery, "tasks", "t", "artifacts");
    mkdirSync(join(dir, "attachments"), { recursive: true });
    writeFileSync(join(dir, "attachments", "a.txt"), "x");
    utimesSync(join(dir, "attachments", "a.txt"), 2_000_000_000, 2_000_000_000);
    await t.feed.refresh("tasks/t/artifacts/attachments/a.txt");
    expect(t.task("t")?.board?.updated).toBe(before);
    writeFileSync(join(dir, "01-x.md"), "x");
    utimesSync(join(dir, "01-x.md"), 2_000_000_000, 2_000_000_000);
    await t.feed.refresh("tasks/t/artifacts/01-x.md");
    expect(t.task("t")?.board?.updated).toBe(2_000_000_000n);
  });
});

describe("task activity (resolve_task_activity_for_repo)", () => {
  async function run(sessions: Record<string, object>, rows: LiveRow[], extraTask = "") {
    const s = scratch(`name = "T"\nslug = "t"\nbranch = "t"\nworktree = "/w"\ncreated = 5\nplaybook = "p"\n${extraTask}`);
    for (const [id, m] of Object.entries(sessions)) s.meta("t", id, m);
    const t = rig(s.alinery, new Map(rows.map((r) => [r.id, r])));
    await t.feed.scan();
    return t.task("t")?.activity;
  }
  test("busy is running and names the session to open", async () => {
    const a = await run({ s1: { created: 1 }, s2: { created: 2 } }, [live("t", "s2", "busy")]);
    expect(a?.status).toBe("running");
    expect(a?.activeSession).toMatchObject({ id: "s2", phase: "clarify", playbook: "p" });
  });
  test("waiting beats running; the newest of equal tiers wins", async () => {
    const a = await run({ s1: { created: 1 }, s2: { created: 2 }, s3: { created: 3 } }, [live("t", "s1", "waiting_for_input"), live("t", "s2", "busy"), live("t", "s3", "waiting_for_approval")]);
    expect(a?.status).toBe("waiting_for_approval");
    // The session to open is the busy one: the active tier puts busy ahead of waiting.
    expect(a?.activeSession?.id).toBe("s2");
  });
  test("a failed non-zero exit shows until acknowledged", async () => {
    const failed = { created: 1, exit_code: 2, ended_at: 100 };
    expect((await run({ s1: failed }, []))?.status).toBe("failed");
    expect((await run({ s1: { ...failed, exit_notification_read_at: 100 } }, []))?.status).toBe("");
  });
  test("a finished playbook phase is completed until read", async () => {
    const done = { created: 1, semantic: { phase_completed_at: 50 } };
    expect((await run({ s1: done }, []))?.status).toBe("completed");
    expect((await run({ s1: { ...done, notification_read_at: 50 } }, []))?.status).toBe("");
  });
  test("a failed playbook is failed unless its source is stale", async () => {
    expect((await run({ s1: { created: 1 } }, [live("t", "s1", "idle", "alive", "failed")]))?.status).toBe("failed");
    const stale = live("t", "s1", "idle");
    stale.playbook = { state: "failed", reason: "StaleSource" };
    expect((await run({ s1: { created: 1 } }, [stale]))?.status).toBe("");
  });
  test("an unsupported adapter is neither waiting nor busy", async () => {
    const row = live("t", "s1", "busy");
    row.adapter = "unsupported";
    expect((await run({ s1: { created: 1 } }, [row]))?.status).toBe("");
  });
  test("a parent shows its active subtask's activity when it has none of its own", async () => {
    const s = scratch('name = "T"\nslug = "t"\nbranch = "t"\nworktree = "/w"\ncreated = 5\nplaybook = "p"\nactive_subtask = "kid"\n');
    mkdirSync(join(s.alinery, "tasks", "kid"), { recursive: true });
    writeFileSync(join(s.alinery, "tasks", "kid", "task.md"), 'name = "K"\nslug = "kid"\nbranch = "kid"\nworktree = "/w"\ncreated = 6\nparent_task = "t"\nplaybook = "p"\n');
    s.meta("kid", "k1");
    const rows = new Map([["k1", live("kid", "k1", "busy")]]);
    const t = rig(s.alinery, rows);
    await t.feed.scan();
    expect(t.task("t")?.activity).toMatchObject({ status: "running", activeSession: { id: "k1" } });
    // The child's session exits with an error: the parent's row follows, though the parent's file never changed.
    writeFileSync(join(s.alinery, "tasks", "kid", "sessions", "k1.meta.json"), JSON.stringify({ id: "k1", worktree: "/w", created: 1, exit_code: 1, ended_at: 9 }));
    rows.delete("k1");
    t.publisher.changed("kid", "k1");
    await Bun.sleep(60);
    expect(t.task("t")?.activity).toMatchObject({ status: "failed" });
    expect(t.task("t")?.activity?.activeSession).toBeUndefined();
  });
  test("subtask cycles end", async () => {
    const s = scratch('name = "T"\nslug = "t"\nbranch = "t"\nworktree = "/w"\ncreated = 5\nactive_subtask = "kid"\n');
    mkdirSync(join(s.alinery, "tasks", "kid"), { recursive: true });
    writeFileSync(join(s.alinery, "tasks", "kid", "task.md"), 'name = "K"\nslug = "kid"\nbranch = "kid"\nworktree = "/w"\ncreated = 6\nactive_subtask = "t"\nparent_task = "t"\n');
    const t = rig(s.alinery);
    await t.feed.scan();
    expect(t.task("t")?.activity?.status).toBe("");
  });
});

test("session name files reach the session row", async () => {
  const s = scratch();
  s.meta("t", "a");
  const t = rig(s.alinery);
  await t.feed.scan();
  const session = () => {
    const e = t.store.get("session/t/a");
    return e?.value.case === "session" ? e.value.value : undefined;
  };
  expect(session()?.name).toBeUndefined();
  const file = join(s.alinery, "tasks", "t", "sessions", "a.name.json");
  writeFileSync(file, JSON.stringify({ name: "Fix login", source: "user" }));
  await t.feed.refresh("tasks/t/sessions/a.name.json");
  expect(session()).toMatchObject({ name: "Fix login", nameSource: "user" });
  writeFileSync(file, JSON.stringify({ name: " padded ", source: "auto" }));
  await t.feed.refresh("tasks/t/sessions/a.name.json");
  expect(session()?.name).toBeUndefined();
  expect(session()?.nameError).toBe("stored session name must be trimmed");
  writeFileSync(file, "not json");
  await t.feed.refresh("tasks/t/sessions/a.name.json");
  expect(session()?.nameError).toBe("invalid session name data");
});

