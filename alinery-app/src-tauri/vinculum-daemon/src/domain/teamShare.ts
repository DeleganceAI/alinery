// One daemon, one team. The shell delivers the sync credential; this process keeps it beside the
// repo and pushes task.md plus every markdown file under artifacts/, step folders included. Teammates'
// comments come back the other way: the heartbeat only says some wait, and a separate call fetches
// them into the artifact's comments file. It never opens a Supabase socket.
import { createHash } from "node:crypto";
import { existsSync, type Dirent, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic, writeOwnerOnly } from "../platform/fs.ts";
import { create } from "@bufbuild/protobuf";
import { EntitySchema, TeamCommentsSchema } from "alinery-proto/alinery/v1/entities_pb";
import type { Store } from "../sync/store.ts";
import { addComment, loadComments } from "./artifactComments.ts";

const BODY_LIMIT = 1_000_000;
const TASK = /^tasks\/([^/]+)\/task\.md$/;
const RESERVED = new Set(["attachments", "subtasks"]);

/** A markdown file a teammate should see. Attachments and subtasks are not artifacts, and a `..` part never leaves the folder. */
export function shareArtifactName(name: string): boolean {
  // `<artifact>.comments.md` is the agent's copy of the comments, which travel as comments, not as an artifact.
  if (!name.endsWith(".md") || name.endsWith(".comments.md")) return false;
  const parts = name.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return false;
  return !RESERVED.has(parts[0]);
}

export type ShareFile = { team_id: string; name: string; token: string; accounts_url: string };

export type ShareSnapshot = {
  tasks: Map<string, string>;
  artifacts: Map<string, string>;
};

export function sharePath(repo: string): string {
  return join(repo, ".alinery", "team-share.json");
}

// Its own file, because finalizing a review deletes the comments file: what was fetched must not come back.
function cursorPath(repo: string): string {
  return join(repo, ".alinery", "team-share-comments.json");
}

export function readCommentCursor(repo: string): string {
  try {
    const since = (JSON.parse(readFileSync(cursorPath(repo), "utf8")) as { since?: unknown }).since;
    return typeof since === "string" ? since : "";
  } catch {
    return "";
  }
}

export type TeamComment = {
  task_slug: string;
  filename: string;
  body: string;
  created_at: string;
  author_email: string | null;
  anchor_id?: string;
  anchor_kind?: string;
  anchor_label?: string;
  anchor_excerpt?: string;
  line_start?: number;
  line_end?: number;
};

/**
 * Writes each comment into its artifact's comments file and moves the cursor past the batch. A comment on an artifact
 * this repository no longer has is passed over; one already in the file (a fetch the cursor missed) is not added twice.
 */
export function saveTeamComments(repo: string, rows: TeamComment[]): number {
  let saved = 0;
  let since = readCommentCursor(repo);
  for (const row of rows) {
    if (typeof row.created_at === "string" && row.created_at > since) since = row.created_at;
    const author = row.author_email || "a teammate";
    const created_at_ms = Date.parse(row.created_at);
    if (typeof row.body !== "string" || !shareArtifactName(row.filename) || Number.isNaN(created_at_ms)) continue;
    if (!existsSync(join(repo, ".alinery", "tasks", row.task_slug, "artifacts", row.filename))) continue;
    try {
      const existing = loadComments(repo, row.task_slug, row.filename);
      if (existing.some((c) => c.author === author && c.created_at_ms === created_at_ms && c.body === row.body.trim())) continue;
      const anchor = {
        anchor_id: row.anchor_id ?? "",
        anchor_kind: row.anchor_kind ?? "",
        anchor_label: row.anchor_label ?? "",
        anchor_excerpt: row.anchor_excerpt ?? "",
        line_start: row.line_start ?? 0,
        line_end: row.line_end ?? 0,
      };
      addComment(repo, row.task_slug, row.filename, { ...anchor, body: row.body }, { author, created_at_ms });
      saved += 1;
    } catch (error) {
      console.error(`team comment ${row.task_slug}/${row.filename}: ${(error as Error).message}`);
    }
  }
  writeAtomic(cursorPath(repo), JSON.stringify({ since }));
  return saved;
}

function accountsOk(url: string): boolean {
  if (url.startsWith("https://")) return true;
  return url.startsWith("http://localhost") || url.startsWith("http://127.0.0.1");
}

export function isShareRel(rel: string): boolean {
  const nested = /^tasks\/[^/]+\/artifacts\/(.+)$/.exec(rel);
  if (nested === null) return TASK.test(rel);
  const name = nested[1];
  return shareArtifactName(name) || (name.endsWith(".comments.json") && shareArtifactName(`${name.slice(0, -".comments.json".length)}.md`));
}

export function revisionOf(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

/** Keys whose revision changed, and keys present before that are gone now. */
export function changedKeys(prev: Map<string, string>, next: Map<string, string>): { upsert: string[]; deleted: string[] } {
  const upsert: string[] = [];
  const deleted: string[] = [];
  for (const [key, revision] of next) {
    if (prev.get(key) !== revision) upsert.push(key);
  }
  for (const key of prev.keys()) {
    if (!next.has(key)) deleted.push(key);
  }
  return { upsert, deleted };
}

export function readShareFile(repo: string): ShareFile | null {
  try {
    const value = JSON.parse(readFileSync(sharePath(repo), "utf8")) as Partial<ShareFile>;
    if (!value.team_id || !value.token?.startsWith("sync_") || !accountsOk(value.accounts_url ?? "")) return null;
    return { team_id: value.team_id, name: value.name || "daemon", token: value.token, accounts_url: value.accounts_url.replace(/\/$/, "") };
  } catch {
    return null;
  }
}

export function writeShareFile(repo: string, file: ShareFile) {
  writeOwnerOnly(sharePath(repo), JSON.stringify({ ...file, accounts_url: file.accounts_url.replace(/\/$/, "") }));
}

function readText(path: string): string | null {
  try {
    const text = readFileSync(path, "utf8");
    return text.length > BODY_LIMIT ? null : text;
  } catch {
    return null;
  }
}

/** task slug → revision, and `slug/filename` → revision. Oversized files are left out. */
export type ShareComment = {
  task_slug: string;
  filename: string;
  created_at_ms: number;
  body: string;
  anchor_id: string;
  anchor_kind: string;
  anchor_label: string;
  anchor_excerpt: string;
  line_start: number;
  line_end: number;
};

/** The owner's own comments on the shared artifacts: a teammate's carries an author and came from the service. */
function ownComments(repo: string, slug: string, filename: string): ShareComment[] {
  try {
    return loadComments(repo, slug, filename)
      .filter((c) => c.author === undefined)
      .map((c) => ({
        task_slug: slug,
        filename,
        created_at_ms: c.created_at_ms,
        body: c.body,
        anchor_id: c.anchor_id,
        anchor_kind: c.anchor_kind,
        anchor_label: c.anchor_label,
        anchor_excerpt: c.anchor_excerpt,
        line_start: c.line_start,
        line_end: c.line_end,
      }));
  } catch {
    return []; // an unreadable comments file is the owner's to see; it must not stop the share
  }
}

/** `slug/filename/created_at_ms`: a comment's identity on the service, which has no id of the daemon's. */
export const commentKey = (c: Pick<ShareComment, "task_slug" | "filename" | "created_at_ms">) => `${c.task_slug}/${c.filename}/${c.created_at_ms}`;

export function snapshotShare(repo: string): {
  tasks: Map<string, { body: string; revision: string }>;
  artifacts: Map<string, { task_slug: string; filename: string; body: string; revision: string }>;
  comments: Map<string, { comment: ShareComment; revision: string }>;
  skipped: number;
} {
  const tasks = new Map<string, { body: string; revision: string }>();
  const artifacts = new Map<string, { task_slug: string; filename: string; body: string; revision: string }>();
  const comments = new Map<string, { comment: ShareComment; revision: string }>();
  let skipped = 0;
  const root = join(repo, ".alinery", "tasks");
  let slugs: string[] = [];
  try {
    slugs = readdirSync(root);
  } catch {
    return { tasks, artifacts, comments, skipped };
  }
  for (const slug of slugs) {
    const taskBody = readText(join(root, slug, "task.md"));
    if (taskBody == null) {
      try {
        readFileSync(join(root, slug, "task.md"));
        skipped += 1;
      } catch {
        /* no task.md */
      }
    } else {
      tasks.set(slug, { body: taskBody, revision: revisionOf(taskBody) });
    }
    const artifactsDir = join(root, slug, "artifacts");
    const walk = (dir: string, prefix: string) => {
      let entries: Dirent[] = [];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const name = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (!prefix && RESERVED.has(entry.name)) continue;
        if (entry.isDirectory()) walk(join(dir, entry.name), name);
        else if (entry.isFile() && shareArtifactName(name)) {
          const body = readText(join(dir, entry.name));
          if (body == null) skipped += 1;
          else {
            artifacts.set(`${slug}/${name}`, { task_slug: slug, filename: name, body, revision: revisionOf(body) });
            for (const comment of ownComments(repo, slug, name)) comments.set(commentKey(comment), { comment, revision: revisionOf(JSON.stringify(comment)) });
          }
        }
      }
    };
    walk(artifactsDir, "");
  }
  return { tasks, artifacts, comments, skipped };
}

let generation = 0;
let beat: ReturnType<typeof setInterval> | null = null;
let debounce: ReturnType<typeof setTimeout> | null = null;
let chain: Promise<void> = Promise.resolve();
let pushedTasks = new Map<string, string>();
let pushedArtifacts = new Map<string, string>();
let pushedComments = new Map<string, string>();
let lastError: string | null = null;

function stopTimers() {
  if (beat) clearInterval(beat);
  if (debounce) clearTimeout(debounce);
  beat = null;
  debounce = null;
}

export function armTeamShare(repo: string) {
  const gen = ++generation;
  stopTimers();
  pushedTasks = new Map();
  pushedArtifacts = new Map();
  pushedComments = new Map();
  lastError = null;
  if (!readShareFile(repo)) return;
  enqueue(() => push(repo, gen));
  beat = setInterval(() => {
    if (gen === generation) void heartbeat(repo, gen);
  }, 20_000);
  beat.unref?.();
}

export function noteShareChange(repo: string, rel: string) {
  if (!isShareRel(rel) || !readShareFile(repo)) return;
  const gen = generation;
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => {
    if (gen === generation) enqueue(() => push(repo, gen));
  }, 1000);
  debounce.unref?.();
}

export async function clearTeamShare(repo: string): Promise<Record<string, never>> {
  const file = readShareFile(repo);
  // The token is the only way to revoke the server copy. A failed unshare leaves the file so a retry can.
  if (file) await post(file, "/api/daemon/unshare", {});
  generation += 1;
  stopTimers();
  pushedTasks = new Map();
  pushedArtifacts = new Map();
  pushedComments = new Map();
  for (const path of [sharePath(repo), cursorPath(repo)]) {
    try {
      unlinkSync(path);
    } catch {
      /* already gone */
    }
  }
  return {};
}

function enqueue(job: () => Promise<void>) {
  chain = chain.then(job, job);
}

async function post(file: ShareFile, path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${file.accounts_url}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${file.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`accounts answered ${response.status}`);
  try {
    const reply = await response.json();
    return reply && typeof reply === "object" ? (reply as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export const TEAM_COMMENTS_KEY = "daemon/_/team-comments";

let onSaved: ((saved: number) => void) | null = null;

/** Called with the count each time a heartbeat's pull saves teammates' comments. A pull the user asked for is not announced. */
export function onTeamCommentsSaved(fn: (saved: number) => void) {
  onSaved = fn;
}

export function commitTeamComments(store: Store, total: number): void {
  store.commit([create(EntitySchema, { key: TEAM_COMMENTS_KEY, value: { case: "teamComments", value: create(TeamCommentsSchema, { total }) } })]);
}

async function pull(repo: string, gen: number, announce = true): Promise<number> {
  let saved = 0;
  for (let page = 0; page < 50; page++) {
    const file = readShareFile(repo);
    if (!file || gen !== generation) return saved;
    const reply = await post(file, "/api/daemon/comments", { comments_since: readCommentCursor(repo) });
    if (gen !== generation) return saved;
    const rows = Array.isArray(reply.comments) ? (reply.comments as TeamComment[]) : [];
    const pageSaved = saveTeamComments(repo, rows);
    saved += pageSaved;
    if (announce && pageSaved > 0) onSaved?.(pageSaved);
    if (reply.more !== true || rows.length === 0) return saved;
  }
  return saved;
}

/** A pull the user asked for. It runs in the push queue, so it never races a heartbeat's pull over the cursor. */
export function pullTeamComments(repo: string): Promise<{ shared: boolean; saved: number }> {
  if (!readShareFile(repo)) return Promise.resolve({ shared: false, saved: 0 });
  const gen = generation;
  return new Promise((resolve, reject) => {
    enqueue(async () => {
      try {
        resolve({ shared: true, saved: await pull(repo, gen, false) });
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function push(repo: string, gen: number) {
  const file = readShareFile(repo);
  if (!file || gen !== generation) return;
  const snap = snapshotShare(repo);
  const taskRev = new Map([...snap.tasks].map(([slug, row]) => [slug, row.revision]));
  const artRev = new Map([...snap.artifacts].map(([key, row]) => [key, row.revision]));
  const tasks = changedKeys(pushedTasks, taskRev);
  const artifacts = changedKeys(pushedArtifacts, artRev);
  const commentRev = new Map([...snap.comments].map(([key, row]) => [key, row.revision]));
  const comments = changedKeys(pushedComments, commentRev);
  if (snap.skipped > 0) lastError = `${snap.skipped} file(s) were over the share size limit`;
  else if (lastError?.includes("size limit")) lastError = null;
  if (tasks.upsert.length === 0 && tasks.deleted.length === 0 && artifacts.upsert.length === 0 && artifacts.deleted.length === 0 && comments.upsert.length === 0 && comments.deleted.length === 0) return;
  const body = {
    tasks: tasks.upsert.map((slug) => {
      const row = snap.tasks.get(slug)!;
      return { slug, revision: row.revision, body: row.body };
    }),
    artifacts: artifacts.upsert.map((key) => {
      const row = snap.artifacts.get(key)!;
      return { task_slug: row.task_slug, filename: row.filename, revision: row.revision, body: row.body };
    }),
    deleted_tasks: tasks.deleted,
    deleted_artifacts: artifacts.deleted.map((key) => {
      const slash = key.indexOf("/");
      return { task_slug: key.slice(0, slash), filename: key.slice(slash + 1) };
    }),
    comments: comments.upsert.map((key) => snap.comments.get(key)!.comment),
    // A deleted comment is only a key, and the key is its parts; the last part is the time.
    deleted_comments: comments.deleted.map((key) => {
      const at = key.lastIndexOf("/");
      const name = key.slice(0, at);
      const slash = name.indexOf("/");
      return { task_slug: name.slice(0, slash), filename: name.slice(slash + 1), created_at_ms: Number(key.slice(at + 1)) };
    }),
  };
  try {
    await post(file, "/api/daemon/sync", body);
    if (gen !== generation) return;
    pushedTasks = taskRev;
    pushedArtifacts = artRev;
    pushedComments = commentRev;
    if (lastError?.startsWith("accounts")) lastError = null;
  } catch (error) {
    lastError = error instanceof Error ? error.message : "sync failed";
  }
}

/** One heartbeat now, as the timer would send it. */
export const beatNow = (repo: string) => heartbeat(repo, generation);

async function heartbeat(repo: string, gen: number) {
  const file = readShareFile(repo);
  if (!file || gen !== generation) return;
  try {
    const reply = await post(file, "/api/daemon/heartbeat", { ...(lastError ? { error: lastError } : {}), comments_since: readCommentCursor(repo) });
    if (reply.comment_updates === true && gen === generation) {
      enqueue(async () => {
        try {
          await pull(repo, gen);
        } catch (error) {
          console.error(`team comments: ${(error as Error).message}`);
        }
      });
    }
  } catch {
    /* the next beat tries again; a dead accounts host must not stop the daemon */
  }
}
