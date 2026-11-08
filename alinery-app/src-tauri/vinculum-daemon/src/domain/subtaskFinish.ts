// Finishing a sub-task (plan S5.1), ported from alinery-core `subtask.rs` (`inspect_subtask_finish`, `finalize_subtask`) so the manager
// agent's two tools are served by the daemon that owns the files. The git state, the blockers per mode and the snapshot's
// provenance keep the shape the tools have always answered.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { writeAtomic } from "../platform/fs.ts";
import { git } from "../platform/git.ts";
import { DomainError, withTaskMutation } from "../platform/lock.ts";
import { loadRelationships } from "./artifactTree.ts";
import { resolveSubtaskManager, snake, taskSummary, worktreeClean, type ManagerContext } from "./subtasks.ts";
import { artifactsDir, readTask, safeComponent, taskDir, type TaskRecord, writeTaskUnlocked } from "./taskFiles.ts";
import { pruneExecutionObjects } from "./tasks.ts";

type Json = Record<string, unknown>;
export type FinalizeMode = "artifacts_only" | "integrated_code" | "archive_without_code";
export const FINALIZE_MODES: readonly FinalizeMode[] = ["artifacts_only", "integrated_code", "archive_without_code"];
const text = (o: Json, key: string): string => (typeof o[key] === "string" ? (o[key] as string) : "");
const relationshipError = (message: string) => new DomainError("failed_precondition", `relationship corruption: ${message}`);

const isDir = (path: string) => {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
};
const snapshotDir = (repo: string, parent: string, child: string) => join(artifactsDir(repo, parent), "subtasks", child);

/** `resolve_bound_manager`: the manager and the child it is bound to, with the links on both sides agreeing. */
function resolveBoundManager(repo: string, managerSessionId: string): { manager: ManagerContext; child: TaskRecord } {
  const known = loadRelationships(repo);
  const manager = resolveSubtaskManager(repo, managerSessionId, known);
  const bound = text(manager.meta, "subtask_slug");
  if (bound === "") throw new DomainError("failed_precondition", "sub-task manager is not bound to an active child");
  if (text(manager.parent, "active_subtask") !== bound) throw relationshipError("manager binding does not match its parent active child");
  const active = text(known.get(manager.ownerSlug) ?? {}, "active_subtask");
  if (active === "") throw relationshipError("manager parent has no active child");
  if (active !== bound) throw relationshipError("manager binding does not match reciprocal child");
  const child = readTask(repo, active);
  if (!child) throw relationshipError("active child task is missing");
  return { manager, child };
}

/** `task_head`: the commit a task is at: its worktree's HEAD when that exists and is on the task's branch, else its branch. */
async function head(repo: string, task: TaskRecord, worktreeExists: boolean, role: string): Promise<string> {
  const branch = text(task, "branch");
  if (worktreeExists) {
    const symbolic = await git(text(task, "worktree"), ["symbolic-ref", "--quiet", "HEAD"]);
    if (symbolic.code !== 0) throw new DomainError("failed_precondition", `${role} worktree HEAD is detached; expected branch '${branch}'`);
    const actual = symbolic.stdout.trim();
    const expected = branch.startsWith("refs/heads/") ? branch : `refs/heads/${branch}`;
    if (actual !== expected) {
      throw new DomainError("failed_precondition", `${role} worktree is on branch '${actual.startsWith("refs/heads/") ? actual.slice("refs/heads/".length) : actual}'; expected '${branch}'`);
    }
  }
  const revision = worktreeExists ? "HEAD" : branch;
  const rev = await git(worktreeExists ? text(task, "worktree") : repo, ["rev-parse", "--verify", revision]);
  if (rev.code !== 0) throw new DomainError("failed_precondition", `cannot resolve ${role} ${revision}: ${rev.stderr.trim()}`);
  return rev.stdout.trim();
}

type GitState = { parent_worktree_exists: boolean; child_worktree_exists: boolean; parent_worktree_clean: boolean; child_worktree_clean: boolean; child_only_commits: number; child_head_contained: boolean };

async function gitState(repo: string, parent: TaskRecord, child: TaskRecord): Promise<GitState> {
  const parentExists = isDir(text(parent, "worktree"));
  const childExists = isDir(text(child, "worktree"));
  const parentClean = parentExists && (await worktreeClean(text(parent, "worktree")));
  const childClean = childExists && (await worktreeClean(text(child, "worktree")));
  const parentHead = await head(repo, parent, parentExists, "parent");
  const childHead = await head(repo, child, childExists, "child");
  const count = await git(repo, ["rev-list", "--count", `${parentHead}..${childHead}`]);
  if (count.code !== 0) throw new DomainError("failed_precondition", `git rev-list failed: ${count.stderr.trim()}`);
  const onlyCommits = Number.parseInt(count.stdout.trim(), 10);
  if (!Number.isInteger(onlyCommits)) throw new DomainError("failed_precondition", `parse child commit count: ${count.stdout.trim()}`);
  const contained = (await git(repo, ["merge-base", "--is-ancestor", childHead, parentHead])).code === 0;
  return {
    parent_worktree_exists: parentExists,
    child_worktree_exists: childExists,
    parent_worktree_clean: parentClean,
    child_worktree_clean: childClean,
    child_only_commits: onlyCommits,
    child_head_contained: contained,
  };
}

/** `validate_snapshot_source`: regular files and directories only, under components a task could name. */
function validateSnapshotSource(path: string): void {
  if (!existsSync(path) && !isLink(path)) return;
  const st = lstatSync(path);
  if (st.isSymbolicLink()) throw new DomainError("failed_precondition", `snapshot source contains symlink: ${path}`);
  if (st.isFile()) return;
  if (!st.isDirectory()) throw new DomainError("failed_precondition", `snapshot source contains unsupported file: ${path}`);
  for (const name of readdirSync(path)) {
    if (safeComponent(name) !== name) throw new DomainError("failed_precondition", `unsafe snapshot component: ${name}`);
    validateSnapshotSource(join(path, name));
  }
}
const isLink = (path: string) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

function copyTree(source: string, destination: string): void {
  if (!existsSync(source)) {
    mkdirSync(destination, { recursive: true });
    return;
  }
  const st = lstatSync(source);
  if (st.isFile()) {
    copyFileSync(source, destination);
    return;
  }
  mkdirSync(destination, { recursive: true });
  for (const name of readdirSync(source)) copyTree(join(source, name), join(destination, name));
}

function provenance(path: string): { child_slug?: unknown; branch?: unknown } | undefined {
  try {
    return parse(readFileSync(join(path, "provenance.toml"), "utf8")) as { child_slug?: unknown; branch?: unknown };
  } catch {
    return undefined;
  }
}

function reusable(path: string, child: TaskRecord): boolean {
  if (!isDir(path)) return false;
  try {
    validateSnapshotSource(path);
  } catch {
    return false;
  }
  const p = provenance(path);
  return p !== undefined && p.child_slug === child.slug && p.branch === text(child, "branch");
}

function installSnapshot(repo: string, parent: TaskRecord, child: TaskRecord): string {
  const source = artifactsDir(repo, child.slug);
  validateSnapshotSource(source);
  if (existsSync(join(source, "provenance.toml"))) throw new DomainError("failed_precondition", "child artifacts contain reserved provenance.toml");
  const destination = snapshotDir(repo, parent.slug, child.slug);
  if (existsSync(destination)) {
    if (reusable(destination, child)) return destination;
    throw new DomainError("failed_precondition", `sub-task snapshot already exists with different provenance: ${destination}`);
  }
  const staging = join(artifactsDir(repo, parent.slug), "subtasks", `.${child.slug}.staging-${process.pid}-${Date.now()}${process.hrtime.bigint()}`);
  mkdirSync(join(artifactsDir(repo, parent.slug), "subtasks"), { recursive: true });
  try {
    copyTree(source, staging);
    writeAtomic(join(staging, "provenance.toml"), stringify({ child_slug: child.slug, branch: text(child, "branch"), snapshot_time: Math.floor(Date.now() / 1000) }));
    renameSync(staging, destination);
    return destination;
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    throw e instanceof DomainError ? e : new DomainError("failed_precondition", `install snapshot ${destination}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const outcomeFor = (mode: FinalizeMode) => (mode === "integrated_code" ? "merged" : "finished");

/** `inspect_subtask_finish`: the state of the bound child and, per mode, what blocks finishing it. `observedLive` is the manager's
 * parent's sessions that are running, which the daemon reads from its own runner. */
export async function inspectSubtaskFinish(repo: string, managerSessionId: string, observedLive: string[]): Promise<Json> {
  const { manager, child } = resolveBoundManager(repo, managerSessionId);
  const code = await gitState(repo, manager.parent, child);
  const snapshot = snapshotDir(repo, manager.parent.slug, child.slug);
  const snapshotExists = existsSync(snapshot);
  const snapshotReusable = reusable(snapshot, child);
  let hasArtifacts = false;
  try {
    hasArtifacts = readdirSync(artifactsDir(repo, child.slug)).length > 0;
  } catch {
    /* no artifacts directory */
  }
  const common: string[] = [];
  if (text(child, "active_subtask") !== "") common.push(`child '${child.slug}' still has active child '${text(child, "active_subtask")}'`);
  try {
    validateSnapshotSource(artifactsDir(repo, child.slug));
  } catch (e) {
    common.push(e instanceof Error ? e.message : String(e));
  }
  if (snapshotExists && !snapshotReusable) common.push("an immutable snapshot already exists with different provenance");
  const childState = (blockers: string[]) => {
    if (!code.child_worktree_exists) blockers.push("child worktree is missing");
    else if (!code.child_worktree_clean) blockers.push("child worktree is dirty");
  };
  const artifactsOnly = [...common];
  childState(artifactsOnly);
  if (code.child_only_commits !== 0) artifactsOnly.push(`child has ${code.child_only_commits} child-only commit(s)`);
  const integrated = [...common];
  childState(integrated);
  if (!code.child_head_contained) integrated.push("child branch is not contained by the parent branch");
  if (!code.parent_worktree_exists) integrated.push("parent worktree is missing");
  else if (!code.parent_worktree_clean) integrated.push("parent worktree is dirty or has unresolved merge state");
  const blockers: Record<FinalizeMode, string[]> = { artifacts_only: artifactsOnly, integrated_code: integrated, archive_without_code: [...common] };
  return {
    child_task: snake(taskSummary(child)),
    code_state: code,
    artifact_state: { has_artifacts: hasArtifacts, snapshot_exists: snapshotExists, snapshot_reusable: snapshotReusable, snapshot_path: snapshot },
    observed_live_parent_sessions: [...new Set(observedLive.filter((id) => id !== managerSessionId))].sort(),
    allowed_modes: FINALIZE_MODES.filter((mode) => blockers[mode].length === 0),
    blockers,
  };
}

/** `finalize_subtask`: snapshot the child's artifacts under the parent, archive the child as finished and clear the parent's link,
 * with both task files put back as they were if the second write fails. */
export function finalizeSubtask(repo: string, managerSessionId: string, mode: FinalizeMode): Promise<Json> {
  return withTaskMutation(repo, "finalize sub-task", async () => {
    const inspection = (await inspectSubtaskFinish(repo, managerSessionId, [])) as { blockers: Record<string, string[]> };
    const blockers = inspection.blockers[mode] ?? ["unknown finish mode"];
    if (blockers.length > 0) throw new DomainError("failed_precondition", `cannot finalize as ${mode}: ${blockers.join("; ")}`);
    const { manager, child } = resolveBoundManager(repo, managerSessionId);
    const parentPath = join(taskDir(repo, manager.parent.slug), "task.md");
    const childPath = join(taskDir(repo, child.slug), "task.md");
    const parentBytes = readFileSync(parentPath);
    const childBytes = readFileSync(childPath);
    const snapshot = installSnapshot(repo, manager.parent, child);
    child.archived = true;
    child.subtask_outcome = outcomeFor(mode);
    try {
      await writeTaskUnlocked(repo, child);
    } catch (e) {
      writeAtomic(childPath, childBytes);
      throw e;
    }
    const parent = manager.parent;
    parent.active_subtask = "";
    try {
      await writeTaskUnlocked(repo, parent);
    } catch (e) {
      writeAtomic(childPath, childBytes);
      writeAtomic(parentPath, parentBytes);
      throw e;
    }
    // The archive is written, so a failure to drop the byte copies (O27) is logged and does not undo it.
    try {
      pruneExecutionObjects(repo, child.slug);
    } catch (e) {
      console.error(`vinculum: archived task ${child.slug}: execution objects not pruned: ${(e as Error).message}`);
    }
    return { parent_task: snake(taskSummary(parent)), archived_child: snake(taskSummary(child)), snapshot_path: snapshot };
  });
}
