// The sub-task lifecycle against a real repository (plan S4.8): the task page's state, the manager session, creating the
// child inside the reservation, and killing a child or discarding a setup. The Rust tests of `subtask.rs` are the
// cases this keeps; each checks the files a Rust reader would find.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadRelationships } from "./artifactTree.ts";
import { loadEngineState } from "./executionStore.ts";
import {
  createManagerSession,
  discardSubtask,
  parseCreateSubtaskInput,
  prepareSubtask,
  subtaskDiscardSessions,
  subtaskState,
} from "./subtasks.ts";
import { readTask, sessionsDir, taskDir } from "./taskFiles.ts";
import { provisionTask } from "./tasks.ts";

const PLAYBOOK = readFileSync(resolve(import.meta.dir, "../../../playbooks/one-shot/playbook.md"), "utf8");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

const deps = (repo: string) => ({ repo, lane: "", identity: "fixture" });
const playbook = () => ({ reference: { scope: "bundled", key: "one-shot" }, source: PLAYBOOK });

/** A repository with a ready task `a` in its own worktree. */
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "alinery-subtask-"));
  dirs.push(dir);
  const repo = join(dir, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  const reply = await provisionTask(deps(repo), {
    name: "A",
    description: "the parent",
    playbook: playbook(),
    launchDefaults: { harness: "omp", model: "" },
    maxLiveSessions: 10,
    start: false,
  });
  expect(reply.creation).toBe("ready");
  return repo;
}

const noOpen = async () => {};

/** The manager session of `a`, started by nobody (the daemon would open it). */
async function manager(repo: string, slug = "a") {
  const made = await createManagerSession(repo, { slug, recover: false, harness: "omp", start: false }, noOpen);
  return String(made.session.id);
}

async function createChild(repo: string, managerId: string, slug = "b", extra: Record<string, unknown> = {}) {
  const plan = await prepareSubtask(deps(repo), parseCreateSubtaskInput({ manager_session_id: managerId, name: `Child ${slug}`, slug, instructions: "Investigate the follow-up.", ...extra }));
  const reply = await provisionTask(deps(repo), plan.params, plan.hooks);
  return { plan, reply };
}

test("a fresh task offers a sub-task and a task without a worktree gives the reason", async () => {
  const repo = await fixture();
  const state = subtaskState(repo, "a");
  expect(state.canStart).toBe(true);
  expect(state.disabledReason).toBe("");
  expect(state.activeSubtask).toBeUndefined();
  expect(() => subtaskState(repo, "missing")).toThrow("no such task");
  await manager(repo);
  expect(subtaskState(repo, "a").disabledReason).toBe("A sub-task setup manager already exists");
});

test("the manager session is written with its prompt, refuses a second, and reports a failed start", async () => {
  const repo = await fixture();
  const opened: string[] = [];
  const made = await createManagerSession(repo, { slug: "a", recover: false, harness: "omp", model: "m", start: true }, async (id, slug, model, prompt) => {
    opened.push(`${slug}:${model}:${prompt.includes("Parent task")}:${id}`);
  });
  expect(made.start).toBe("started");
  const id = String(made.session.id);
  expect(opened).toEqual([`a:m:${String(made.session.prompt).includes("Parent task")}:${id}`]);
  const meta = JSON.parse(readFileSync(join(sessionsDir(repo, "a"), `${id}.meta.json`), "utf8"));
  expect(meta.subtask_manager).toBe(true);
  expect(meta.generic).toBe(true);
  expect(meta.subtask_slug).toBeUndefined();
  expect(meta.prompt).toContain(id);
  expect(meta.prompt).not.toMatch(/\{\{[A-Z_]+\}\}/);
  await expect(createManagerSession(repo, { slug: "a", recover: false, harness: "omp", start: false }, noOpen)).rejects.toThrow("live or unstarted manager");

  const other = await fixture();
  const failed = await createManagerSession(other, { slug: "a", recover: false, harness: "omp", start: true }, async () => {
    throw new Error("no spawn");
  });
  expect(failed.start).toBe("failed");
  expect(failed.errors[0]).toMatchObject({ stage: "launch", code: "spawn_failed", message: "no spawn" });
});

test("creating a child links parent, child and manager, and inherits the parent's definition", async () => {
  const repo = await fixture();
  const id = await manager(repo);
  const { plan, reply } = await createChild(repo, id);
  expect(reply.creation).toBe("ready");
  const child = readTask(repo, "b");
  expect(child?.parent_task).toBe("a");
  expect(child?.active_subtask).toBeUndefined();
  expect(readTask(repo, "a")?.active_subtask).toBe("b");
  const meta = JSON.parse(readFileSync(join(sessionsDir(repo, "a"), `${id}.meta.json`), "utf8"));
  expect(meta.subtask_slug).toBe("b");
  expect(readFileSync(join(taskDir(repo, "b"), "playbook.md"), "utf8")).toBe(PLAYBOOK);
  expect(readFileSync(join(taskDir(repo, "b"), "artifacts", "00-ticket.md"), "utf8")).toContain("Investigate the follow-up.");
  const parentHead = git(readTask(repo, "a")?.worktree as string, "rev-parse", "HEAD").trim();
  expect(git(child?.worktree as string, "rev-parse", "HEAD").trim()).toBe(parentHead);
  const result = plan.result(reply, {}) as { parent_task: { slug: string }; child_task: { slug: string }; manager_session: { subtask_slug: string } };
  expect([result.parent_task.slug, result.child_task.slug, result.manager_session.subtask_slug]).toEqual(["a", "b", "b"]);
  expect(loadRelationships(repo).size).toBe(2);

  const state = subtaskState(repo, "a");
  expect(state.activeSubtask?.slug).toBe("b");
  expect(state.canStart).toBe(false);
  expect(state.disabledReason).toBe("Finish the active sub-task before starting another");
  expect(subtaskState(repo, "b").parentTask?.slug).toBe("a");
  expect(subtaskState(repo, "b").parentManagerSession?.id).toBe(id);
});

test("creation refuses a dirty parent, a bound manager, a taken slug and unknown input keys", async () => {
  const repo = await fixture();
  const id = await manager(repo);
  const worktree = readTask(repo, "a")?.worktree as string;
  writeFileSync(join(worktree, "uncommitted.txt"), "parent-only");
  await expect(createChild(repo, id)).rejects.toThrow("clean");
  expect(readFileSync(join(worktree, "uncommitted.txt"), "utf8")).toBe("parent-only");
  expect(existsSync(taskDir(repo, "b"))).toBe(false);
  rmSync(join(worktree, "uncommitted.txt"));

  mkdirSync(taskDir(repo, "b"), { recursive: true });
  await expect(createChild(repo, id)).rejects.toThrow("collides with an existing task");
  rmSync(taskDir(repo, "b"), { recursive: true });
  await expect(createChild(repo, id, "Not A Slug")).rejects.toThrow("lowercase ASCII");

  await createChild(repo, id);
  await expect(createChild(repo, id, "c")).rejects.toThrow("already has an active child");
  expect(existsSync(taskDir(repo, "c"))).toBe(false);
  expect(readTask(repo, "a")?.active_subtask).toBe("b");

  expect(() => parseCreateSubtaskInput({ manager_session_id: "m", name: "n", slug: "s", extra: 1 })).toThrow("unknown field `extra`");
  expect(() => parseCreateSubtaskInput({ name: "n", slug: "s" })).toThrow("missing field `manager_session_id`");
});

test("recovery binds a manager to the active child and nothing else", async () => {
  const repo = await fixture();
  const id = await manager(repo);
  await createChild(repo, id);
  const path = join(sessionsDir(repo, "a"), `${id}.meta.json`);
  const meta = JSON.parse(readFileSync(path, "utf8"));
  meta.ended_at = 5;
  meta.created = 1; // older than the recovery, whose second may be the same
  writeFileSync(path, JSON.stringify(meta));
  expect(subtaskState(repo, "a").canRecover).toBe(true);
  await expect(createManagerSession(repo, { slug: "a", recover: true, subtaskSlug: "other", harness: "omp", start: false }, noOpen)).rejects.toThrow("missing child task");
  const recovered = await createManagerSession(repo, { slug: "a", recover: true, subtaskSlug: "b", harness: "omp", start: false }, noOpen);
  expect(recovered.session.subtask_slug).toBe("b");
  expect(String(recovered.session.prompt)).toContain("b");
  expect(subtaskState(repo, "a").managerSession?.id).toBe(recovered.session.id);
});

test("discarding an unbound manager removes its session files and nothing else", async () => {
  const repo = await fixture();
  const id = await manager(repo);
  const dir = sessionsDir(repo, "a");
  writeFileSync(join(dir, `${id}.scrollback`), "expired login");
  writeFileSync(join(dir, `${id}.name.json`), "{}");
  writeFileSync(join(dir, `${id}.pi.sqlite`), "db");
  const planned = subtaskDiscardSessions(repo, "a", id);
  expect(planned).toEqual([{ slug: "a", id }]);
  const stopped: string[] = [];
  const result = await discardSubtask(repo, "a", id, (slug, sid) => void stopped.push(`${slug}/${sid}`));
  expect(stopped).toEqual([`a/${id}`]);
  expect(result.killed).toEqual([]);
  for (const name of ["meta.json", "scrollback", "name.json", "pi.sqlite"]) expect(existsSync(join(dir, `${id}.${name}`))).toBe(false);
  expect(readTask(repo, "a")).toBeDefined();
  expect(existsSync(join(taskDir(repo, "a"), "execution.json"))).toBe(true);
});

test("a stop that refuses leaves the discard where it was", async () => {
  const repo = await fixture();
  const id = await manager(repo);
  await expect(
    discardSubtask(repo, "a", id, () => {
      throw new Error("still running");
    }),
  ).rejects.toThrow("still running");
  expect(existsSync(join(sessionsDir(repo, "a"), `${id}.meta.json`))).toBe(true);
});

test("killing a bound child archives it and its active descendants, and the parent's execution stays valid", async () => {
  const repo = await fixture();
  const id = await manager(repo);
  await createChild(repo, id);
  const nested = await manager(repo, "b");
  await createChild(repo, nested, "c");
  const childSession = join(sessionsDir(repo, "c"), "child-session.meta.json");
  mkdirSync(sessionsDir(repo, "c"), { recursive: true });
  writeFileSync(childSession, JSON.stringify({ id: "child-session", worktree: readTask(repo, "c")?.worktree, created: 4, harness: "omp", generic: true }));
  const engineBefore = loadEngineState(repo, "a").kind;
  const executionBefore = readFileSync(join(taskDir(repo, "a"), "execution.json"), "utf8");
  const dirty = join(readTask(repo, "b")?.worktree as string, "dirty");
  writeFileSync(dirty, "dirty");

  const planned = subtaskDiscardSessions(repo, "a", id).map((s) => `${s.slug}/${s.id}`);
  expect(planned).toContain(`a/${id}`);
  expect(planned).toContain(`b/${nested}`);
  expect(planned).toContain("c/child-session");
  const result = await discardSubtask(repo, "a", id, () => {});
  expect(result.killed).toEqual(["b", "c"]);

  expect(readTask(repo, "a")?.active_subtask).toBeUndefined();
  for (const slug of ["b", "c"]) {
    const killed = readTask(repo, slug);
    expect(killed?.archived).toBe(true);
    expect(killed?.subtask_outcome).toBe("killed");
    expect(killed?.active_subtask).toBeUndefined();
    expect(existsSync(killed?.worktree as string)).toBe(true);
    expect(git(repo, "show-ref", "--verify", `refs/heads/${slug}`)).toContain(`refs/heads/${slug}`);
  }
  expect(existsSync(dirty)).toBe(true);
  expect(existsSync(join(sessionsDir(repo, "a"), `${id}.meta.json`))).toBe(true);
  expect(existsSync(childSession)).toBe(true);
  expect(readFileSync(join(taskDir(repo, "a"), "execution.json"), "utf8")).toBe(executionBefore);
  expect(loadEngineState(repo, "a").kind).toBe(engineBefore);
  expect(loadRelationships(repo).size).toBe(3);
  // The killed child is gone from the parent, so it offers a sub-task again.
  expect(subtaskState(repo, "a").activeSubtask).toBeUndefined();
  expect(subtaskState(repo, "a").canStart).toBe(true);
});

test("a discard of a manager that belongs to another task, or an empty id with no child, is refused", async () => {
  const repo = await fixture();
  const id = await manager(repo);
  await expect(discardSubtask(repo, "other", id, () => {})).rejects.toThrow();
  await expect(discardSubtask(repo, "a", "", () => {})).rejects.toThrow("no active sub-task");
  await expect(discardSubtask(repo, "a", "../x", () => {})).rejects.toThrow("invalid sub-task manager session id");
});

const executionOf = (repo: string, slug: string) => JSON.parse(readFileSync(join(taskDir(repo, slug), "execution.json"), "utf8")) as Record<string, unknown>;

test("a child that inherits the definition inherits the step models, and one with its own playbook does not", async () => {
  const repo = await fixture();
  const parent = executionOf(repo, "a");
  writeFileSync(join(taskDir(repo, "a"), "execution.json"), JSON.stringify({ ...parent, step_models: { implementation: "parent-override" } }));
  const id = await manager(repo);
  await createChild(repo, id);
  expect(executionOf(repo, "b").step_models).toEqual({ implementation: "parent-override" });

  const other = await fixture();
  writeFileSync(join(taskDir(other, "a"), "execution.json"), JSON.stringify({ ...executionOf(other, "a"), step_models: { implementation: "parent-override" } }));
  const own = await createChild(other, await manager(other), "own", { playbook: { reference: { scope: "repo", key: "one-shot" }, source: PLAYBOOK } });
  expect(own.reply.creation).toBe("ready");
  expect(executionOf(other, "own").step_models ?? {}).toEqual({});
});

test("a worktree that fails to check out leaves a partial child that the parent still names", async () => {
  const repo = await fixture();
  const id = await manager(repo);
  const hook = join(repo, ".git", "hooks", "post-checkout");
  mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
  writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  chmodSync(hook, 0o755);
  const { reply } = await createChild(repo, id);
  expect(reply.creation).toBe("partial");
  expect(reply.errors.some((e) => e.stage === "git_worktree")).toBe(true);
  expect(readTask(repo, "b")?.parent_task).toBe("a");
  expect(readTask(repo, "a")?.active_subtask).toBe("b");
  expect(JSON.parse(readFileSync(join(sessionsDir(repo, "a"), `${id}.meta.json`), "utf8")).subtask_slug).toBe("b");
  expect(executionOf(repo, "b").creation).toBe("partial");
  expect(loadRelationships(repo).size).toBe(2);
  await expect(createChild(repo, id, "c")).rejects.toThrow("already has an active child");
});
