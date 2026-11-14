import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Entity, type Job, JobKind, JobState } from "alinery-proto/alinery/v1/entities_pb";
import { Store } from "../sync/store.ts";
import { planPurge, purgeArchived } from "./purge.ts";
import { jobKey, JobRunner } from "./runner.ts";
import { scanStorage } from "./storage.ts";

const REAL = join(import.meta.dir, "real-child.ts");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const taskMd = (slug: string, archived: boolean) => `name = "${slug}"\nslug = "${slug}"\nbranch = "${slug}"\nworktree = "/w"\ncreated = 1\narchived = ${archived}\n`;
const meta = (id: string, archived: boolean) => JSON.stringify({ id, worktree: "/w", created: 1, archived });
function put(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** A repository with a live task (one live and one archived session), an archived task and its worktree, and an orphan worktree. */
function fixture() {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "alinery-purge-")));
  dirs.push(repo);
  const a = join(repo, ".alinery");
  put(join(a, "config.toml"), "x");
  put(join(a, "tasks/live/task.md"), taskMd("live", false));
  put(join(a, "tasks/live/sessions/keep.meta.json"), meta("keep", false));
  put(join(a, "tasks/live/sessions/keep.scrollback"), "live bytes");
  put(join(a, "tasks/live/sessions/gone.meta.json"), meta("gone", true));
  put(join(a, "tasks/live/sessions/gone.scrollback"), "archived bytes");
  put(join(a, "tasks/live/sessions/gone.name.json"), "{}");
  put(join(a, "tasks/old/task.md"), taskMd("old", true));
  put(join(a, "tasks/old/artifacts/01-a.md"), "artifact");
  put(join(a, "tasks/old/sessions/o1.meta.json"), meta("o1", false));
  put(join(a, "tasks/broken/task.md"), "not toml [[[");
  put(join(a, "worktrees/old/file.txt"), "worktree of an archived task");
  put(join(a, "worktrees/orphan/file.txt"), "no task at all");
  put(join(a, "worktrees/live/file.txt"), "worktree of a live task");
  return { repo, a };
}

test("the plan names exactly what the storage scan calls archived", () => {
  const { repo } = fixture();
  const plan = planPurge(repo);
  expect(plan.tasks).toEqual(["old"]);
  expect(plan.sessions.map((s) => [s.slug, s.id])).toEqual([["live", "gone"]]);
  expect(plan.worktrees.map((w) => w.slug)).toEqual(["old"]);
  expect(plan.killIds.map((k) => `${k.slug}/${k.id}`).sort()).toEqual(["live/gone", "old/o1"]);
  const before = scanStorage({ repo, appConfig: "/c", namespace: "" });
  expect(before.archived_task_count).toBe(1);
  expect(before.archived_session_count).toBe(2);
});

test("a purge frees what the scan called archived and nothing else", async () => {
  const { repo, a } = fixture();
  const reports: string[] = [];
  const out = await purgeArchived(repo, () => false, (p) => reports.push(`${p.done}/${p.total}`));
  expect(out).toMatchObject({ deleted_tasks: 1, deleted_sessions: 1, deleted_worktrees: 1, errors: [], deleted_task_slugs: ["old"] });
  expect(reports).toEqual(["1/3", "2/3", "3/3"]);
  expect(existsSync(join(a, "tasks/old"))).toBe(false);
  expect(existsSync(join(a, "worktrees/old"))).toBe(false);
  expect(readdirSync(join(a, "tasks/live/sessions")).sort()).toEqual(["keep.meta.json", "keep.scrollback"]);
  // Live work, an unreadable task, an orphan worktree and settings are never targets.
  expect(existsSync(join(a, "tasks/broken/task.md"))).toBe(true);
  expect(existsSync(join(a, "worktrees/orphan/file.txt"))).toBe(true);
  expect(existsSync(join(a, "worktrees/live/file.txt"))).toBe(true);
  expect(existsSync(join(a, "config.toml"))).toBe(true);
  expect(readdirSync(join(a, "tmp"))).toEqual([]); // the scratch directory is gone
  const after = scanStorage({ repo, appConfig: "/c", namespace: "" });
  expect([after.archived_task_count, after.archived_session_count, after.archived_bytes]).toEqual([0, 0, 0]);
});

test("a task restored after the scan is not deleted", async () => {
  const { repo, a } = fixture();
  let asked = 0;
  // The run is told to go on, but the task is un-archived between the scan and its turn.
  const out = await purgeArchived(repo, () => {
    if (++asked === 3) put(join(a, "tasks/old/task.md"), taskMd("old", false)); // before the task's turn
    return false;
  });
  expect(out.deleted_tasks).toBe(0);
  expect(out.errors).toEqual([{ target: "task:old", error: "not archived" }]);
  expect(readFileSync(join(a, "tasks/old/artifacts/01-a.md"), "utf8")).toBe("artifact");
});

test("a run that is stopped leaves every archived task whole or gone", async () => {
  const { repo, a } = fixture();
  for (let i = 0; i < 20; i++) {
    put(join(a, `tasks/bulk${i}/task.md`), taskMd(`bulk${i}`, true));
    put(join(a, `tasks/bulk${i}/artifacts/a.md`), "a");
    put(join(a, `tasks/bulk${i}/artifacts/b.md`), "b");
  }
  let asked = 0;
  const out = await purgeArchived(repo, () => ++asked > 9);
  expect(out.deleted_tasks).toBeGreaterThan(0);
  expect(out.deleted_tasks).toBeLessThan(21);
  for (const slug of [...planPurge(repo).tasks, ...out.deleted_task_slugs]) {
    const dir = join(a, "tasks", slug);
    const files = existsSync(dir) ? readdirSync(dir).sort() : undefined;
    if (files === undefined) expect(out.deleted_task_slugs).toContain(slug);
    else if (slug.startsWith("bulk")) {
      expect(files).toEqual(["artifacts", "task.md"]);
      expect(readdirSync(join(dir, "artifacts")).sort()).toEqual(["a.md", "b.md"]);
    }
  }
  expect(readdirSync(join(a, "tasks")).filter((n) => n.startsWith(".") || n.includes("purge"))).toEqual([]);
});

test("as a job its progress reaches a subscriber and a cancel between items leaves nothing half deleted", async () => {
  const { repo, a } = fixture();
  for (let i = 0; i < 2000; i++) {
    put(join(a, `tasks/bulk${i}/task.md`), taskMd(`bulk${i}`, true));
    put(join(a, `tasks/bulk${i}/artifacts/a.md`), "a");
    put(join(a, `tasks/bulk${i}/artifacts/b.md`), "b");
  }
  const store = new Store();
  const seen: Job[] = [];
  const commit = store.commit.bind(store);
  store.commit = (puts: Entity[], deletes: string[] = []) => {
    for (const e of puts) if (e.value.case === "job") seen.push(structuredClone(e.value.value));
    return commit(puts, deletes);
  };
  const runner = new JobRunner(store, { command: () => [process.execPath, REAL, "purge"], progressMs: 1 });
  const id = runner.start(JobKind.PURGE, { repo });
  // The first progress commit is a subscriber's view of a purge that is under way.
  for (let i = 0; i < 1000 && !seen.some((j) => j.progress && j.progress.done >= 10n && j.state === JobState.RUNNING); i++) await Bun.sleep(5);
  expect(seen.some((j) => j.state === JobState.RUNNING && j.progress && j.progress.total === 2003n)).toBe(true);
  runner.cancel(id);
  const done = await runner.finished(id);
  expect(done.state).toBe(JobState.CANCELLED);
  const left = readdirSync(join(a, "tasks"));
  for (const name of left.filter((n) => n.startsWith("bulk"))) {
    expect(readdirSync(join(a, "tasks", name)).sort()).toEqual(["artifacts", "task.md"]);
    expect(readdirSync(join(a, "tasks", name, "artifacts")).sort()).toEqual(["a.md", "b.md"]);
  }
  expect(left.filter((n) => n.startsWith("bulk")).length).toBeLessThan(2000); // it did start deleting
  expect(store.get(jobKey(id))).toBeDefined();
});

test("run to the end as a job, its result names what it deleted", async () => {
  const { repo, a } = fixture();
  const store = new Store();
  const runner = new JobRunner(store, { command: () => [process.execPath, REAL, "purge"] });
  const done = await runner.finished(runner.start(JobKind.PURGE, { repo }));
  expect(done.state).toBe(JobState.DONE);
  expect(done.result).toMatchObject({ case: "purge", value: { deletedTasks: 1, deletedSessions: 1, deletedWorktrees: 1, deletedTaskSlugs: ["old"] } });
  expect(existsSync(join(a, "tasks/old"))).toBe(false);
});
