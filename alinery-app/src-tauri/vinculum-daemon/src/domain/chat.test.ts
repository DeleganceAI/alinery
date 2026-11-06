import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../sync/store.ts";
import { createExecutionSession, startSession } from "../tasks.ts";
import { DomainError } from "../platform/lock.ts";
import { archiveChatThread, ChatPublisher, type ChatSessions, chatKey, chatWorktreesDir, createChatThread, loadChat, removeChatWorktree, resumeChatThread, setChatPinned } from "./chat.ts";
import { metaPathOf, namePathOf, setSessionName } from "./sessionOps.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

/** A repository, and a runner that records what the daemon would have started or stopped. */
function rig(opts: { failStart?: boolean; failOpen?: boolean } = {}) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "chat-")));
  dirs.push(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  mkdirSync(join(repo, ".alinery", "sessions"), { recursive: true });
  const running = new Set<string>();
  const log: string[] = [];
  const metaAtKill: Record<string, Record<string, unknown>> = {};
  const sessions: ChatSessions = {
    create: (request) => createExecutionSession(repo, request, async () => {}),
    start: (request) =>
      startSession(repo, request, async (id) => {
        if (opts.failStart) throw new Error("no model is configured");
        running.add(id);
        log.push(`start ${id}`);
      }),
    open: async (header) => {
      if (opts.failOpen) throw new DomainError("failed_precondition", "cannot spawn");
      running.add(String(header.id));
      log.push(`open ${JSON.stringify(header)}`);
    },
    isRunning: (id) => running.has(id),
    kill: (id) => {
      metaAtKill[id] = JSON.parse(readFileSync(metaPathOf(repo, "", id), "utf8"));
      running.delete(id);
      log.push(`kill ${id}`);
    },
  };
  const read = (id: string) => JSON.parse(readFileSync(metaPathOf(repo, "", id), "utf8")) as Record<string, unknown>;
  return { repo, sessions, running, log, metaAtKill, read };
}

const idOf = (reply: Record<string, unknown>) => String((reply.session as { id: string }).id);

test("a new thread is a root Vinculum session, marked generic, and it starts", async () => {
  const { repo, sessions, running, read } = rig();
  const reply = await createChatThread(repo, sessions, "claude-x", false);
  const id = idOf(reply);
  expect(reply.start).toBe("started");
  expect(read(id)).toMatchObject({ id, harness: "vinculum", model: "claude-x", generic: true, worktree: repo });
  expect(running.has(id)).toBe(true);
  expect(loadChat(repo, id).id).toBe(id);
});

test("a launch that fails still leaves the thread, with the error beside it", async () => {
  const { repo, sessions, read } = rig({ failStart: true });
  const reply = await createChatThread(repo, sessions, "", false);
  expect(reply.start).toBe("failed");
  expect((reply.errors as Array<{ message: string }>)[0].message).toContain("no model is configured");
  expect(read(idOf(reply)).generic).toBe(true);
});

test("a thread with a worktree gets chat/<id> checked out under chat-worktrees, and archiving can take it away", async () => {
  const { repo, sessions, running, log, metaAtKill, read } = rig();
  const id = idOf(await createChatThread(repo, sessions, "", true));
  const path = join(chatWorktreesDir(repo), id);
  expect(existsSync(join(path, ".git"))).toBe(true);
  expect(git(path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`chat/${id}`);
  expect(read(id).worktree).toBe(path);
  await archiveChatThread(repo, sessions, id, true);
  // The stamp is in the file before the process goes, so a subscriber sees `archived` before the exit.
  expect(metaAtKill[id].archived).toBe(true);
  expect(log.at(-1)).toBe(`kill ${id}`);
  expect(running.has(id)).toBe(false);
  expect(existsSync(path)).toBe(false);
  expect(read(id)).toMatchObject({ archived: true, worktree: repo });
});

test("removing a worktree is refused while the thread runs, and works once it is stopped", async () => {
  const { repo, sessions, running, read } = rig();
  const id = idOf(await createChatThread(repo, sessions, "", true));
  await expect(removeChatWorktree(repo, sessions, id)).rejects.toThrow("still running");
  running.delete(id);
  await removeChatWorktree(repo, sessions, id);
  expect(existsSync(join(chatWorktreesDir(repo), id))).toBe(false);
  expect(read(id).worktree).toBe(repo);
});

test("pinning and the other thread writes are refused for a session that is not a chat thread", async () => {
  const { repo, sessions } = rig();
  writeFileSync(metaPathOf(repo, "", "term"), JSON.stringify({ id: "term", harness: "no-harness", generic: true }));
  expect(() => setChatPinned(repo, "term", true)).toThrow("not a chat thread");
  await expect(archiveChatThread(repo, sessions, "term", false)).rejects.toThrow("not a chat thread");
  expect(() => setChatPinned(repo, "../x", true)).toThrow("invalid session id");
  expect(() => setChatPinned(repo, "gone", true)).toThrow("session not found");
});

test("continuing a thread makes one successor that resumes the harness conversation, and a second click returns the same one", async () => {
  const { repo, sessions, log, read } = rig();
  const first = idOf(await createChatThread(repo, sessions, "claude-x", false));
  setChatPinned(repo, first, true);
  await setSessionName(repo, "", first, "Fix login", "user");
  // The resume token the harness recorded for the first thread.
  writeFileSync(metaPathOf(repo, "", first), JSON.stringify({ ...read(first), harness_resume_token: "tok-1" }));
  const [a, b] = await Promise.all([resumeChatThread(repo, sessions, first), resumeChatThread(repo, sessions, first)]);
  expect(a.id).toBe(b.id);
  expect(a).toMatchObject({ resume_of: first, pinned: true, model: "claude-x", generic: true });
  expect(JSON.parse(readFileSync(namePathOf(repo, "", String(a.id)), "utf8"))).toEqual({ name: "Fix login", source: "user" });
  expect(read(first).archived).toBe(true);
  const opens = log.filter((l) => l.startsWith("open "));
  expect(opens).toHaveLength(1);
  expect(JSON.parse(opens[0].slice(5))).toMatchObject({ op: "resume", id: a.id, resume_token: "tok-1", task_slug: "" });
});

test("a thread with nothing to resume cannot be continued, and a spawn that fails leaves no half successor", async () => {
  const { repo, sessions, read } = rig();
  const first = idOf(await createChatThread(repo, sessions, "", false));
  await expect(resumeChatThread(repo, sessions, first)).rejects.toThrow("cannot continue");
  writeFileSync(metaPathOf(repo, "", first), JSON.stringify({ ...read(first), harness_resume_token: "tok" }));
  const failing = rig({ failOpen: true });
  const other = idOf(await createChatThread(failing.repo, failing.sessions, "", false));
  writeFileSync(metaPathOf(failing.repo, "", other), JSON.stringify({ ...failing.read(other), harness_resume_token: "tok" }));
  await expect(resumeChatThread(failing.repo, failing.sessions, other)).rejects.toThrow("cannot spawn");
  expect(failing.read(other).archived).toBeUndefined();
  const left = Bun.spawnSync(["ls", join(failing.repo, ".alinery", "sessions")]).stdout.toString().split("\n").filter((n) => n.endsWith(".meta.json"));
  expect(left).toEqual([`${other}.meta.json`]);
});

test("the rail row follows the thread: its branch, whether it is a checkout, and whether a successor continues it", async () => {
  const { repo, sessions } = rig();
  const store = new Store();
  const publisher = new ChatPublisher(store, repo);
  const plain = idOf(await createChatThread(repo, sessions, "", false));
  const tree = idOf(await createChatThread(repo, sessions, "", true));
  await publisher.refreshAll();
  const row = (id: string) => store.get(chatKey(id))?.value;
  expect(row(plain)).toMatchObject({ case: "chatThread", value: { id: plain, branchLabel: "main", checkout: true, superseded: false } });
  expect(row(tree)).toMatchObject({ case: "chatThread", value: { branchLabel: `chat/${tree}`, checkout: false } });
  writeFileSync(metaPathOf(repo, "", plain), JSON.stringify({ ...JSON.parse(readFileSync(metaPathOf(repo, "", plain), "utf8")), harness_resume_token: "t" }));
  const successor = String((await resumeChatThread(repo, sessions, plain)).id);
  await publisher.refresh(successor);
  expect(row(plain)).toMatchObject({ value: { superseded: true } });
  expect(row(successor)).toMatchObject({ value: { superseded: false } });
  rmSync(metaPathOf(repo, "", tree));
  await publisher.refresh(tree);
  expect(store.get(chatKey(tree))).toBeUndefined();
});
