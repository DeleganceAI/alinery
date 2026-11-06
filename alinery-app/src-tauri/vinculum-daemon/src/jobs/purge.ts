// The purge job (S4.9), ported from alinery-core `storage.rs` `purge_archived_storage`: delete every archived task, every
// archived session's files under a live task, and the worktrees of archived tasks. The classification is the storage scan's
// (jobs/storage.ts), so the megabytes the confirmation shows are the ones this frees.
//
// Cancel (SIGTERM) is honoured between items, never inside one. An item is made to disappear in one step: a task directory is
// renamed into `.alinery/tmp/purge-<run>/` and only then deleted, so a task is either fully present or gone from the
// repository, whatever happens during the delete. A session's files move the same way, its meta last, so a cancel leaves a
// session whole or without its meta, never a meta without its files. Debris in `tmp/purge-*` is swept at the next run.
import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { git } from "../platform/git.ts";
import { withTaskMutation } from "../platform/lock.ts";
import { names, sessionArchived, sessionFiles, sessionIds, taskArchived } from "./storage.ts";

export type PurgePlan = {
  /** Archived task slugs: the whole directory goes. */
  tasks: string[];
  /** Archived sessions under a live task: their files go, the task stays. */
  sessions: { slug: string; id: string; files: string[] }[];
  /** `.alinery/worktrees/<slug>` of each archived task. */
  worktrees: { slug: string; path: string }[];
  /** Every session that must not be running when its files go. */
  killIds: { slug: string; id: string }[];
};

export type PurgeOutcome = {
  deleted_tasks: number;
  deleted_sessions: number;
  deleted_worktrees: number;
  errors: { target: string; error: string }[];
  deleted_task_slugs: string[];
};

/** `storage.rs` `scan`, the targets half. Only reads. */
export function planPurge(repo: string): PurgePlan {
  const alinery = join(repo, ".alinery");
  const tasks = join(alinery, "tasks");
  const plan: PurgePlan = { tasks: [], sessions: [], worktrees: [], killIds: [] };
  for (const slug of names(tasks)) {
    const dir = join(tasks, slug);
    const archived = taskArchived(dir);
    if (archived === undefined) continue; // never classifiable, never a target
    const sessions = join(dir, "sessions");
    if (archived) {
      plan.tasks.push(slug);
      for (const id of sessionIds(sessions)) plan.killIds.push({ slug, id });
    } else {
      for (const id of sessionIds(sessions)) {
        if (!sessionArchived(join(sessions, `${id}.meta.json`))) continue;
        plan.sessions.push({ slug, id, files: sessionFiles(sessions, id) });
        plan.killIds.push({ slug, id });
      }
    }
  }
  const archivedSlugs = new Set(plan.tasks);
  for (const slug of names(join(alinery, "worktrees"))) {
    if (archivedSlugs.has(slug)) plan.worktrees.push({ slug, path: join(alinery, "worktrees", slug) });
  }
  return plan;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const exists = (p: string) => {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
};

export type Report = (progress: { done: number; total: number; label: string }) => void;

/** Runs the plan. `stopped` is asked before each item; the outcome of a stopped run is what was done so far. */
export async function purgeArchived(repo: string, stopped: () => boolean, report: Report = () => {}): Promise<PurgeOutcome> {
  const alinery = join(repo, ".alinery");
  const scratchRoot = join(alinery, "tmp");
  for (const name of names(scratchRoot)) if (name.startsWith("purge-")) rmSync(join(scratchRoot, name), { recursive: true, force: true });
  const scratch = join(scratchRoot, `purge-${randomUUID()}`);
  mkdirSync(scratch, { recursive: true });
  const plan = planPurge(repo);
  const total = plan.sessions.length + plan.worktrees.length + plan.tasks.length;
  const out: PurgeOutcome = { deleted_tasks: 0, deleted_sessions: 0, deleted_worktrees: 0, errors: [], deleted_task_slugs: [] };
  let done = 0;
  const step = (label: string) => report({ done: ++done, total, label });
  try {
    // Archived sessions under a still-live task: their files go, the task stays.
    for (const s of plan.sessions) {
      if (stopped()) return out;
      const tomb = join(scratch, `session-${s.slug}-${s.id}`);
      try {
        mkdirSync(tomb);
        // The meta last: a session is the file that names it.
        for (const f of [...s.files].sort((a, b) => Number(a.endsWith(".meta.json")) - Number(b.endsWith(".meta.json")))) {
          if (exists(f)) renameSync(f, join(tomb, f.slice(f.lastIndexOf("/") + 1)));
        }
        out.deleted_sessions++;
      } catch (e) {
        out.errors.push({ target: `session:${s.id}`, error: message(e) });
      }
      step(`session ${s.id}`);
    }
    // Worktrees of archived tasks: git first (keeps its worktree admin data consistent), plain removal as the fallback.
    for (const w of plan.worktrees) {
      if (stopped()) return out;
      let why = "";
      try {
        const r = await git(repo, ["worktree", "remove", "--force", w.path]);
        if (r.code !== 0) why = r.stderr.trim();
      } catch (e) {
        why = `git worktree remove: ${message(e)}`;
      }
      if (exists(w.path)) {
        try {
          rmSync(w.path, { recursive: true, force: true });
        } catch (e) {
          why = `${w.path}: ${message(e)}`;
        }
      }
      if (exists(w.path)) out.errors.push({ target: `worktree:${w.slug}`, error: why || `${w.path} still present after removal` });
      else out.deleted_worktrees++;
      step(`worktree ${w.slug}`);
    }
    // Archived task directories. The scan and the delete are not atomic, so `archived` is asserted again, under the repository's
    // task lock, right before the directory is renamed out of `tasks/`.
    for (const slug of plan.tasks) {
      if (stopped()) return out;
      const dir = join(alinery, "tasks", slug);
      const tomb = join(scratch, `task-${slug}`);
      try {
        const moved = await withTaskMutation(repo, "purge archived task", () => {
          if (taskArchived(dir) !== true) return false;
          renameSync(dir, tomb);
          return true;
        });
        if (!moved) out.errors.push({ target: `task:${slug}`, error: "not archived" });
        else {
          out.deleted_tasks++;
          out.deleted_task_slugs.push(slug);
        }
      } catch (e) {
        out.errors.push({ target: `task:${slug}`, error: `${dir}: ${message(e)}` });
      }
      step(`task ${slug}`);
    }
    return out;
  } finally {
    // What was moved out is deleted whether or not the run was stopped; a delete that fails leaves debris the next run sweeps.
    try {
      rmSync(scratch, { recursive: true, force: true });
    } catch (e) {
      console.error(`purge: ${scratch} not deleted: ${message(e)}`);
    }
  }
}
