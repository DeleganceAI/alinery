// The git work of a task (plan S4.7): source branches, remove a worktree, push, and the pull-request lookup. The git itself is
// the daemon's GitService, so a repository on another machine answers the same calls. What stays on this machine is the GitHub
// API call (it needs this machine's token, 2.3.4) and the backup queue, both reached through `ipc`.
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import type { TaskSourceHead as HeadProto } from "alinery-proto/alinery/v1/git_pb";
import { GitService } from "alinery-proto/alinery/v1/git_pb";
import { daemonTransport } from "../daemon/transport";
import * as ipc from "../ipc";
import type { PullRequest, PullRequestSnapshot, TaskActivityRef, TaskSourceBranches, TaskSourceHead } from "../types";
import { newMutationMeta } from "./mutation";

const git = (repo: string) => createClient(GitService, daemonTransport(repo));

async function call<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    const err = ConnectError.from(e);
    throw new Error(err.code === Code.Unavailable && err.rawMessage === "" ? "the repository's daemon is not reachable" : err.rawMessage);
  }
}

const headOf = (head: HeadProto | undefined): TaskSourceHead => {
  const h = head?.head;
  if (h?.case === "branch") return { kind: "branch", full_ref: h.value.fullRef, name: h.value.name };
  if (h?.case === "unborn") return { kind: "unborn", full_ref: h.value.fullRef, name: h.value.name };
  if (h?.case === "detachedOid") return { kind: "detached", oid: h.value };
  throw new Error("the daemon returned no HEAD");
};

/** The local branches, what HEAD is, and whether a saved base ref is still usable (`selectedBaseRef`: null or unset asks for none). */
export async function taskSourceBranchesForRepo(repo: string, selectedBaseRef?: string | null): Promise<TaskSourceBranches> {
  const r = await call(() => git(repo).taskSourceBranches({ selectedBaseRef: selectedBaseRef ?? undefined }));
  return {
    branches: r.branches.map((b) => ({ full_ref: b.fullRef, name: b.name })),
    head: headOf(r.head),
    selected: r.selected ? { base_ref: r.selected.baseRef, available: r.selected.available } : null,
  };
}

/** A commit or push is a change the automatic backup waits for. It is queued here because the queue is this process's (S4.9 moves it); a failure to queue never fails the git work. */
const queueBackup = (repo: string) => ipc.publishGitBackup(repo).catch(() => undefined);

export async function removeWorktreeForRepo(repo: string, slug: string): Promise<void> {
  await call(() => git(repo).removeWorktree({ meta: newMutationMeta(), slug }));
}

/** Pushes the task branch from its worktree with the host's git credentials and returns the forge's compare URL. */
export async function pushAndCompareUrlForRepo(repo: string, slug: string): Promise<string> {
  const reply = await call(() => git(repo).pushAndCompareUrl({ meta: newMutationMeta(), slug }));
  await queueBackup(repo);
  return reply.compareUrl;
}

// ---- pull requests ----------------------------------------------------------------------------------------

/** One lookup: the daemon says what the task has, this machine asks GitHub, and a link found is recorded back on the task. */
async function lookupOne(ref: TaskActivityRef): Promise<PullRequest | null> {
  const client = git(ref.repoPath);
  const inputs = await call(() => client.taskPullRequestInputs({ slug: ref.taskSlug }));
  const pr = await ipc.lookupTaskPullRequest(inputs.prUrl, inputs.branch, inputs.originUrl ?? null);
  if (pr) {
    await call(() => client.recordDiscoveredPullRequest({ meta: newMutationMeta(), slug: ref.taskSlug, branch: inputs.branch, previousUrl: inputs.prUrl, url: pr.url }));
  }
  return pr;
}

const LOOKUPS_AT_ONCE = 4;
export const pullRequestKey = (ref: TaskActivityRef) => `${ref.repoPath}:${ref.taskSlug}`;

/**
 * The pull request of each task, by `repoPath:taskSlug`. A duplicate reference is looked up once, at most four lookups run at a
 * time so a big board does not open a burst of connections, and one task's failure is its own snapshot's error.
 */
export async function listTaskPullRequests(tasks: TaskActivityRef[]): Promise<Record<string, PullRequestSnapshot>> {
  const unique = [...new Map(tasks.map((t) => [pullRequestKey(t), t])).values()];
  const out: Record<string, PullRequestSnapshot> = {};
  let next = 0;
  const worker = async () => {
    for (let ref = unique[next++]; ref; ref = unique[next++]) {
      try {
        out[pullRequestKey(ref)] = { pr: await lookupOne(ref), error: null };
      } catch (e) {
        out[pullRequestKey(ref)] = { pr: null, error: e instanceof Error ? e.message : String(e) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(LOOKUPS_AT_ONCE, unique.length) }, worker));
  return out;
}
