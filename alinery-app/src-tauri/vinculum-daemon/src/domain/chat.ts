// Taskless chat threads (plan S4.4): the rooted Vinculum sessions under `.alinery/sessions/`. Ports alinery-core chat.rs.
// A thread is a session (`session/_/<id>`) plus a `chat/_/<id>` entity for what only the rail shows: the branch it
// works on and whether a later thread continues it. The file and git half is here; the process half (create, start,
// kill, resume) is the `ChatSessions` the daemon passes in, so the logic is testable without a runner.
import { create } from "@bufbuild/protobuf";
import { ChatThreadSchema, EntitySchema } from "alinery-proto/alinery/v1/entities_pb";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { git } from "../platform/git.ts";
import { DomainError } from "../platform/lock.ts";
import type { Store } from "../sync/store.ts";
import { type Json, isVinculumSession, metaPathOf, namePathOf, setSessionName, stampMeta, stampSessionArchived } from "./sessionOps.ts";
import { alineryDir, safeComponent, worktreesDir } from "./taskFiles.ts";
import { newestVinculumJsonl } from "./history.ts";

export const DEFAULT_HARNESS = "vinculum";
const rootDir = (repo: string) => join(alineryDir(repo), "sessions");
export const chatWorktreesDir = (repo: string) => join(alineryDir(repo), "chat-worktrees");
export const chatAttachmentsDir = (repo: string, id: string) => join(rootDir(repo), `${id}.attachments`);
export const chatKey = (id: string) => `chat/_/${id}`;

/** The process half a thread needs from the runner. `create` and `start` are the engine's `create_execution_session` and `start_session`. */
export type ChatSessions = {
  create(request: Json): Promise<Json>;
  start(request: { task_slug: string; session_id: string }): Promise<Json>;
  /** Spawns or resumes the session's process; rejects with the daemon's refusal. */
  open(header: Json): Promise<void>;
  isRunning(id: string): boolean;
  stop(id: string): void;
  /** The thread's canvas was just enabled: a live thread's agent gets the canvas tools now, not on its next start. */
  canvasEnabled?(id: string): Promise<void>;
};

const readMeta = (repo: string, id: string): Json | undefined => {
  try {
    return JSON.parse(readFileSync(metaPathOf(repo, "", id), "utf8")) as Json;
  } catch {
    return undefined;
  }
};

/** `load_root_vinculum`: the meta of a chat thread, or the refusal for an id that is not one. */
export function loadChat(repo: string, id: string): Json {
  if (safeComponent(id) !== id) throw new DomainError("invalid_argument", "invalid session id");
  const meta = readMeta(repo, id);
  if (!meta) throw new DomainError("not_found", "session not found");
  if (meta.id !== id || !isVinculumSession(meta.harness) || meta.generic !== true) throw new DomainError("invalid_argument", "not a chat thread");
  return meta;
}

export function rootChats(repo: string): Json[] {
  let names: string[];
  try {
    names = readdirSync(rootDir(repo));
  } catch {
    return [];
  }
  const out: Json[] = [];
  for (const name of names) {
    if (!name.endsWith(".meta.json")) continue;
    const meta = readMeta(repo, name.slice(0, -".meta.json".length));
    if (meta && isVinculumSession(meta.harness)) out.push(meta);
  }
  return out;
}

const text = (v: unknown) => (typeof v === "string" ? v : "");

/** The thread whose worktree this is: the thread itself, or the ancestor (through resume_of) that made the directory. */
export function chatWorktreeOwner(repo: string, meta: Json): string | undefined {
  const path = text(meta.worktree);
  if (!path || dirname(path) !== chatWorktreesDir(repo) || !statSync(path, { throwIfNoEntry: false })?.isDirectory()) return undefined;
  const dir = basename(path);
  const seen = new Set<string>();
  let next: string | undefined = text(meta.id);
  while (next) {
    if (next === dir) return next;
    if (seen.has(next)) return undefined;
    seen.add(next);
    try {
      next = text(loadChat(repo, next).resume_of) || undefined;
    } catch {
      next = undefined;
    }
  }
  return undefined;
}

/** `git rev-parse --abbrev-ref HEAD` in `dir`; "" when git cannot say. */
export async function abbrevRef(dir: string): Promise<string> {
  try {
    const r = await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
    return r.code === 0 ? r.stdout.trim() : "";
  } catch {
    return "";
  }
}

export async function chatBranchOf(repo: string, meta: Json): Promise<{ label: string; checkout: boolean }> {
  return chatWorktreeOwner(repo, meta) ? { label: await abbrevRef(text(meta.worktree)), checkout: false } : { label: await abbrevRef(repo), checkout: true };
}

// ---- the entity ---------------------------------------------------------------------------------------------------

/** Keeps `chat/_/<id>` equal to the thread's files. A refresh recomputes the thread and the one it continues. */
export class ChatPublisher {
  constructor(
    private readonly store: Store,
    private readonly repo: string,
    private readonly log: (line: string) => void = console.error,
  ) {}

  async refresh(id: string): Promise<void> {
    await this.one(id);
    const before = readMeta(this.repo, id)?.resume_of;
    if (typeof before === "string" && before) await this.one(before);
  }

  private async one(id: string): Promise<void> {
    let meta: Json;
    try {
      meta = loadChat(this.repo, id);
    } catch {
      this.store.commit([], [chatKey(id)]);
      return;
    }
    const superseded = rootChats(this.repo).some((m) => m.resume_of === id);
    const branch = await chatBranchOf(this.repo, meta);
    this.store.commit([create(EntitySchema, { key: chatKey(id), value: { case: "chatThread", value: create(ChatThreadSchema, { id, branchLabel: branch.label, checkout: branch.checkout, superseded }) } })]);
  }

  /** Start-up and the 30 s pass: every thread once. */
  async refreshAll(): Promise<void> {
    for (const meta of rootChats(this.repo)) await this.one(text(meta.id)).catch((e) => this.log(`chat ${text(meta.id)}: ${(e as Error).message}`));
  }
}

// ---- worktrees ----------------------------------------------------------------------------------------------------

function chatWorktreePath(repo: string, id: string): string {
  const safe = safeComponent(id);
  if (!safe) throw new DomainError("invalid_argument", "invalid session id");
  return join(chatWorktreesDir(repo), safe);
}

async function addChatWorktree(repo: string, id: string): Promise<string> {
  const path = chatWorktreePath(repo, id);
  mkdirSync(dirname(path), { recursive: true });
  const r = await git(repo, ["worktree", "add", "-b", `chat/${id}`, path]);
  if (r.code !== 0) throw new DomainError("failed_precondition", `git worktree add: ${r.stderr.trim()}`);
  return path;
}

async function removeChatWorktreePath(repo: string, id: string, path: string): Promise<void> {
  const expected = chatWorktreePath(repo, id);
  let repoReal: string;
  let pathReal: string;
  try {
    repoReal = realpathSync(repo);
    pathReal = realpathSync(path);
  } catch {
    throw new DomainError("failed_precondition", "chat worktree path is not that session");
  }
  if (pathReal === repoReal) throw new DomainError("failed_precondition", "refusing to remove the repository checkout");
  const tasks = worktreesDir(repo);
  if (path.startsWith(`${tasks}/`) || pathReal.startsWith(`${tasks}/`)) throw new DomainError("failed_precondition", "refusing to remove a task worktree");
  let rootReal: string;
  try {
    rootReal = realpathSync(dirname(expected));
  } catch {
    throw new DomainError("failed_precondition", "chat worktree path is not that session");
  }
  if (pathReal !== join(rootReal, id)) throw new DomainError("failed_precondition", "chat worktree path is not that session");
  const r = await git(repo, ["worktree", "remove", "--force", pathReal]);
  if (r.code !== 0) throw new DomainError("failed_precondition", `git worktree remove failed: ${r.stderr.trim()}`);
}

async function removeOwnedWorktree(repo: string, meta: Json): Promise<void> {
  const owner = chatWorktreeOwner(repo, meta) ?? text(meta.id);
  await removeChatWorktreePath(repo, owner, text(meta.worktree));
  stampMeta(repo, "", text(meta.id), (m) => {
    m.worktree = repo;
  });
}

function deleteChatRow(repo: string, id: string): void {
  rmSync(metaPathOf(repo, "", id), { force: true });
  rmSync(namePathOf(repo, "", id), { force: true });
}

// ---- the writes ---------------------------------------------------------------------------------------------------

const auxiliary = (model: string | undefined) => ({
  task_slug: "",
  target: { kind: "auxiliary", harness: DEFAULT_HARNESS, model: model || null, prompt: null },
  launch_override: null,
  prompt_extra: null,
  handoff_artifact: null,
  start: false,
});

const idOf = (reply: Json) => text((reply.session as Json | undefined)?.id);

/** `create_chat_thread_in`: mint a thread, give it a worktree when asked, start it. A launch that fails is still a thread. */
export async function createChatThread(repo: string, sessions: ChatSessions, model: string, createWorktree: boolean): Promise<Json> {
  const minted = await sessions.create(auxiliary(model));
  const id = idOf(minted);
  if (createWorktree) {
    try {
      const path = await addChatWorktree(repo, id);
      stampMeta(repo, "", id, (m) => {
        m.worktree = path;
      });
    } catch (error) {
      const path = chatWorktreePath(repo, id);
      let removeError: unknown;
      if (existsSync(path)) await removeChatWorktreePath(repo, id, path).catch((e) => (removeError = e));
      deleteChatRow(repo, id);
      throw removeError ? new DomainError("failed_precondition", `${(error as Error).message}; ${(removeError as Error).message}`) : error;
    }
  }
  try {
    return await sessions.start({ task_slug: "", session_id: id });
  } catch (error) {
    return { session: readMeta(repo, id) ?? minted.session, execution: null, start: "failed", errors: [{ stage: "launch", code: "spawn_failed", message: String((error as Error).message ?? error) }] };
  }
}

export function setChatPinned(repo: string, id: string, pinned: boolean): void {
  loadChat(repo, id);
  stampMeta(repo, "", id, (m) => {
    m.pinned = pinned;
  });
}

/**
 * Stamps the thread archived, then stops it if it runs. `stamped` runs between the two (the caller refreshes the store there),
 * so a subscriber sees the archived put before the exit put.
 */
export async function archiveChatThread(repo: string, sessions: ChatSessions, id: string, removeWorktree: boolean, stamped: () => Promise<void> = async () => {}): Promise<void> {
  const meta = loadChat(repo, id);
  stampSessionArchived(repo, "", id);
  await stamped();
  if (sessions.isRunning(id)) sessions.stop(id);
  if (removeWorktree) await removeOwnedWorktree(repo, meta);
}

export async function removeChatWorktree(repo: string, sessions: ChatSessions, id: string): Promise<void> {
  const meta = loadChat(repo, id);
  if (sessions.isRunning(id)) throw new DomainError("failed_precondition", "This thread is still running. Archive it with Archive and remove worktree, or stop it first.");
  await removeOwnedWorktree(repo, meta);
}

/** The cwd a continuation runs in: the predecessor's own worktree, or the checkout (which the predecessor is moved to). */
function resumeCwd(repo: string, predecessor: Json): string {
  if (chatWorktreeOwner(repo, predecessor)) return text(predecessor.worktree);
  if (predecessor.worktree !== repo) {
    stampMeta(repo, "", text(predecessor.id), (m) => {
      m.worktree = repo;
    });
  }
  return repo;
}

let resuming: Promise<unknown> = Promise.resolve();

/** `resume_chat_thread_in`: a new thread that resumes the predecessor's harness conversation. One at a time, so two clicks make one successor. */
export function resumeChatThread(repo: string, sessions: ChatSessions, predecessorId: string): Promise<Json> {
  const run = resuming.catch(() => {}).then(() => resumeOnce(repo, sessions, predecessorId));
  resuming = run;
  return run;
}

async function resumeOnce(repo: string, sessions: ChatSessions, predecessorId: string): Promise<Json> {
  const predecessor = loadChat(repo, predecessorId);
  const successor = rootChats(repo).find((m) => m.resume_of === predecessorId);
  if (successor) return successor;
  let token = text(predecessor.harness_resume_token);
  if (!token) {
    token = newestVinculumJsonl(join(rootDir(repo), `${predecessorId}.vinculum`)) ?? "";
    if (!token) throw new DomainError("failed_precondition", "cannot continue");
  }
  const cwd = resumeCwd(repo, predecessor);
  const minted = await sessions.create(auxiliary(text(predecessor.model)));
  const successorId = idOf(minted);
  try {
    stampMeta(repo, "", successorId, (m) => {
      m.resume_of = predecessorId;
      m.pinned = predecessor.pinned === true;
      m.worktree = cwd;
    });
    const name = (() => {
      try {
        const v = JSON.parse(readFileSync(namePathOf(repo, "", predecessorId), "utf8")) as { name: string; source: "auto" | "user" };
        return typeof v.name === "string" ? v : undefined;
      } catch {
        return undefined;
      }
    })();
    if (name) await setSessionName(repo, "", successorId, name.name, name.source);
  } catch (error) {
    deleteChatRow(repo, successorId);
    throw error;
  }
  try {
    await sessions.open({ op: "resume", id: successorId, cwd, task_slug: "", resume_token: token });
  } catch (error) {
    if (sessions.isRunning(successorId)) sessions.stop(successorId);
    deleteChatRow(repo, successorId);
    throw error;
  }
  stampSessionArchived(repo, "", predecessorId);
  return loadChat(repo, successorId);
}
