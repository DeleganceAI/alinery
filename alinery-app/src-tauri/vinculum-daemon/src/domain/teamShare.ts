// One daemon, one team. The shell delivers the sync credential; this process keeps it beside the
// repo and pushes task.md plus numbered artifact markdown to the accounts service. It never opens
// a Supabase socket.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeOwnerOnly } from "../platform/fs.ts";

const BODY_LIMIT = 1_000_000;
const TASK = /^tasks\/([^/]+)\/task\.md$/;
const ARTIFACT = /^tasks\/([^/]+)\/artifacts\/(\d+-.+\.md)$/;

export type ShareFile = { team_id: string; name: string; token: string; accounts_url: string };

export type ShareSnapshot = {
  tasks: Map<string, string>;
  artifacts: Map<string, string>;
};

export function sharePath(repo: string): string {
  return join(repo, ".alinery", "team-share.json");
}

function accountsOk(url: string): boolean {
  if (url.startsWith("https://")) return true;
  return url.startsWith("http://localhost") || url.startsWith("http://127.0.0.1");
}

export function isShareRel(rel: string): boolean {
  return TASK.test(rel) || ARTIFACT.test(rel);
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
export function snapshotShare(repo: string): { tasks: Map<string, { body: string; revision: string }>; artifacts: Map<string, { task_slug: string; filename: string; body: string; revision: string }>; skipped: number } {
  const tasks = new Map<string, { body: string; revision: string }>();
  const artifacts = new Map<string, { task_slug: string; filename: string; body: string; revision: string }>();
  let skipped = 0;
  const root = join(repo, ".alinery", "tasks");
  let slugs: string[] = [];
  try {
    slugs = readdirSync(root);
  } catch {
    return { tasks, artifacts, skipped };
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
    let names: string[] = [];
    try {
      names = readdirSync(join(root, slug, "artifacts"));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/^\d+-.+\.md$/.test(name)) continue;
      const body = readText(join(root, slug, "artifacts", name));
      if (body == null) {
        skipped += 1;
        continue;
      }
      artifacts.set(`${slug}/${name}`, { task_slug: slug, filename: name, body, revision: revisionOf(body) });
    }
  }
  return { tasks, artifacts, skipped };
}

let generation = 0;
let beat: ReturnType<typeof setInterval> | null = null;
let debounce: ReturnType<typeof setTimeout> | null = null;
let chain: Promise<void> = Promise.resolve();
let pushedTasks = new Map<string, string>();
let pushedArtifacts = new Map<string, string>();
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
  try {
    unlinkSync(sharePath(repo));
  } catch {
    /* already gone */
  }
  return {};
}

function enqueue(job: () => Promise<void>) {
  chain = chain.then(job, job);
}

async function post(file: ShareFile, path: string, body: unknown) {
  const response = await fetch(`${file.accounts_url}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${file.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`accounts answered ${response.status}`);
}

async function push(repo: string, gen: number) {
  const file = readShareFile(repo);
  if (!file || gen !== generation) return;
  const snap = snapshotShare(repo);
  const taskRev = new Map([...snap.tasks].map(([slug, row]) => [slug, row.revision]));
  const artRev = new Map([...snap.artifacts].map(([key, row]) => [key, row.revision]));
  const tasks = changedKeys(pushedTasks, taskRev);
  const artifacts = changedKeys(pushedArtifacts, artRev);
  if (snap.skipped > 0) lastError = `${snap.skipped} file(s) were over the share size limit`;
  else if (lastError?.includes("size limit")) lastError = null;
  if (tasks.upsert.length === 0 && tasks.deleted.length === 0 && artifacts.upsert.length === 0 && artifacts.deleted.length === 0) return;
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
  };
  try {
    await post(file, "/api/daemon/sync", body);
    if (gen !== generation) return;
    pushedTasks = taskRev;
    pushedArtifacts = artRev;
    if (lastError?.startsWith("accounts")) lastError = null;
  } catch (error) {
    lastError = error instanceof Error ? error.message : "sync failed";
  }
}

async function heartbeat(repo: string, gen: number) {
  const file = readShareFile(repo);
  if (!file || gen !== generation) return;
  try {
    await post(file, "/api/daemon/heartbeat", lastError ? { error: lastError } : {});
  } catch {
    /* the next beat tries again; a dead accounts host must not stop the daemon */
  }
}
