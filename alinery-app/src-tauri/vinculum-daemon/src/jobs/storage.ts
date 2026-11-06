// The storage scan (S2.6), ported from alinery-core `storage.rs` `storage_info_in`. One walk of
// `<repo>/.alinery` splits every byte into archived (what a purge frees) and active, and nothing
// outside `.alinery` is measured: a symlink is neither file nor directory here, so the walk never
// follows one out. It only reads; the purge (jobs/purge.ts) deletes exactly what its classification calls archived.
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";

export type StorageParams = { repo: string; appConfig: string; namespace: string };

// Rust's lane stem: ascii alphanumerics, `-` and `_`, at most 48 of them.
function stem(base: string, namespace: string): string {
  const clean = namespace.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 48);
  return clean ? `${base}-${clean}` : base;
}

export function names(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export function fileLen(path: string): number {
  try {
    const st = lstatSync(path);
    return st.isFile() ? st.size : 0;
  } catch {
    return 0;
  }
}

function pathSize(path: string): number {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return 0;
  }
  if (st.isFile()) return st.size;
  if (!st.isDirectory()) return 0;
  return names(path).reduce((sum, name) => sum + pathSize(join(path, name)), 0);
}

const isString = (v: unknown) => typeof v === "string";
const isCount = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0) || typeof v === "bigint";

/** `Some(task).archived` of `read_task`: undefined when task.md is missing or Rust's `Task` would not
 * parse it. Only the fields Rust requires, and the type of `archived`, are checked. */
export function taskArchived(taskDir: string): boolean | undefined {
  try {
    const t = parse(readFileSync(join(taskDir, "task.md"), "utf8"));
    if (!(["name", "slug", "branch", "worktree"].every((k) => isString(t[k])) && isCount(t.created))) return undefined;
    if (t.archived !== undefined && typeof t.archived !== "boolean") return undefined;
    return t.archived === true;
  } catch {
    return undefined;
  }
}

/** `read_session_meta_full(..).archived`: false for a meta Rust would not parse, so it stays active. */
export function sessionArchived(path: string): boolean {
  try {
    const m = JSON.parse(readFileSync(path, "utf8"));
    if (!(isString(m.id) && isString(m.worktree) && isCount(m.created))) return false;
    return m.archived === true;
  } catch {
    return false;
  }
}

export function sessionIds(dir: string): string[] {
  return names(dir).flatMap((n) => (n.endsWith(".meta.json") ? [n.slice(0, -".meta.json".length)] : []));
}

// Every file of one session; the `<id>.` prefix keeps session `a1` from claiming session `a`'s files.
export function sessionFiles(dir: string, id: string): string[] {
  const prefix = `${id}.`;
  return names(dir)
    .filter((n) => n === `${id}.meta.json` || n === `${id}.name.json` || n === `${id}.scrollback` || (n.startsWith(prefix) && n.includes(".tmp.")))
    .map((n) => join(dir, n));
}

export function scanStorage({ repo, appConfig, namespace }: StorageParams): Record<string, string | number> {
  const alinery = join(repo, ".alinery");
  const tasks = join(alinery, "tasks");
  const worktrees = join(alinery, "worktrees");
  let archivedTasks = 0;
  let archivedSessions = 0;
  let archivedBytes = 0;
  let activeBytes = 0;

  // config.toml, harnesses.toml, playbooks/, sessions/, sockets, locks, anything unknown.
  for (const name of names(alinery)) {
    const path = join(alinery, name);
    if (path !== tasks && path !== worktrees) activeBytes += pathSize(path);
  }
  const archivedSlugs = new Set<string>();
  for (const slug of names(tasks)) {
    const dir = join(tasks, slug);
    const size = pathSize(dir);
    const archived = taskArchived(dir);
    if (archived === undefined) {
      activeBytes += size; // never classifiable, never a target
    } else if (archived) {
      archivedBytes += size;
      archivedTasks++;
      archivedSessions += sessionIds(join(dir, "sessions")).length;
      archivedSlugs.add(slug);
    } else {
      activeBytes += size;
      // An archived session under a live task moves its own files to the archived bucket.
      const sessions = join(dir, "sessions");
      for (const id of sessionIds(sessions)) {
        if (!sessionArchived(join(sessions, `${id}.meta.json`))) continue;
        const moved = sessionFiles(sessions, id).reduce((sum, f) => sum + fileLen(f), 0);
        activeBytes -= moved;
        archivedBytes += moved;
        archivedSessions++;
      }
    }
  }
  for (const slug of names(worktrees)) {
    const size = pathSize(join(worktrees, slug));
    if (archivedSlugs.has(slug)) archivedBytes += size;
    else activeBytes += size; // a live task's worktree, or a true orphan
  }
  return {
    app_config_path: appConfig,
    repo_path: repo,
    alinery_dir: alinery,
    repo_config_path: join(alinery, "config.toml"),
    harnesses_path: join(alinery, "harnesses.toml"),
    tasks_dir: tasks,
    worktrees_dir: worktrees,
    alineryd_socket_path: join(alinery, `${stem("alineryd", namespace)}.sock`),
    alineryd_lock_path: join(alinery, `.${stem("alineryd", namespace)}.lock`),
    mcp_socket_path: join(alinery, `${stem("mcp", namespace)}.sock`),
    mcp_status_path: join(alinery, `${stem("mcp", namespace)}.status.json`),
    archived_task_count: archivedTasks,
    archived_session_count: archivedSessions,
    archived_bytes: archivedBytes,
    active_bytes: activeBytes,
  };
}
