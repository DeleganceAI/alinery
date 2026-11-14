// Git work on a task's repository and worktree (plan S4.7), ported from alinery-core `git_actions.rs` and the execution-ref
// half of `git.rs`: commit, push and the forge compare URL, removing the worktree, the PR link, the task-source branches, and
// the refs that keep an execution's files alive (O27). Every git call goes through `platform/git.ts`; every write to task.md
// goes through the task-mutation lock. Errors keep the words the Rust gave them, because the views show them as they are.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DomainError } from "../platform/lock.ts";
import { git, gitText } from "../platform/git.ts";
import { readTaskChecked, safeComponent } from "./taskFiles.ts";
import { mutateTask } from "./tasks.ts";

const failed = (message: string) => new DomainError("failed_precondition", message);

// ---- the GitHub and forge URLs -------------------------------------------------------------------------------

/** `issue_number`: a positive decimal and nothing else. */
function issueNumber(s: string): number | undefined {
  const t = s.trim();
  if (!/^[0-9]+$/.test(t)) return undefined;
  const n = Number(t);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

export type GitHubPullRef = { owner: string; repo: string; number: number };

/** `github_pull_request_ref`: `https://github.com/<owner>/<repo>/pull/<n>` (a query, fragment or trailing slash is ignored); the creation form `compare/...` is not one. */
export function githubPullRequestRef(url: string): GitHubPullRef | undefined {
  const t = url.trim();
  if (!t.startsWith("https://github.com/")) return undefined;
  const path = (t.slice("https://github.com/".length).split(/[?#]/)[0] ?? "").replace(/\/+$/, "");
  const parts = path.split("/");
  const component = (p: string) => p !== "" && p !== "." && p !== ".." && /^[A-Za-z0-9._-]+$/.test(p);
  if (parts.length !== 4 || parts[2] !== "pull" || !component(parts[0]) || !component(parts[1])) return undefined;
  const number = issueNumber(parts[3]);
  return number === undefined ? undefined : { owner: parts[0], repo: parts[1], number };
}

const trimEnd = (s: string, suffix: string) => {
  let out = s;
  while (out.endsWith(suffix)) out = out.slice(0, -suffix.length);
  return out;
};

/**
 * `compare_url`: the forge page that opens a PR from `branch` into `base`. An ssh URL's `:port` is the ssh port, never the web port,
 * so it is dropped; an https URL's port is the web port and stays. Userinfo is stripped from every scheme so a credential embedded in
 * the remote never reaches the stored, clickable or copied link.
 */
export function compareUrl(remote: string, base: string, branch: string): string | undefined {
  const r = remote.trim();
  let ssh = false;
  let hostpath: string;
  if (r.startsWith("git@")) {
    ssh = true;
    hostpath = r.slice(4).replace(":", "/");
  } else if (r.startsWith("ssh://")) {
    ssh = true;
    hostpath = r.slice(6);
  } else if (r.startsWith("https://")) hostpath = r.slice(8);
  else if (r.startsWith("http://")) hostpath = r.slice(7);
  else return undefined;
  hostpath = trimEnd(trimEnd(hostpath, "/"), ".git");
  const slash = hostpath.indexOf("/");
  if (slash < 0) return undefined;
  let host = hostpath.slice(0, slash);
  const ownerRepo = hostpath.slice(slash + 1);
  host = host.slice(host.lastIndexOf("@") + 1);
  if (ssh) {
    const colon = host.lastIndexOf(":");
    if (colon >= 0) {
      const port = host.slice(colon + 1);
      if (port !== "" && /^[0-9]+$/.test(port)) host = host.slice(0, colon);
    }
  }
  if (host === "" || !ownerRepo.includes("/")) return undefined;
  return `https://${host}/${ownerRepo}/compare/${base}...${branch}${host.includes("github") ? "?expand=1" : ""}`;
}

/** `default_base_branch`: origin's HEAD branch, else `main`. */
export async function defaultBaseBranch(repo: string): Promise<string> {
  const r = await git(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (r.code === 0) {
    const name = r.stdout.trim();
    if (name.startsWith("origin/") && name.length > "origin/".length) return name.slice("origin/".length);
  }
  return "main";
}

/** `git remote get-url origin`; undefined when there is no origin. */
export async function originUrl(repo: string): Promise<string | undefined> {
  const r = await git(repo, ["remote", "get-url", "origin"]);
  return r.code === 0 ? r.stdout.trim() : undefined;
}

// ---- task.md writes ------------------------------------------------------------------------------------------

/** `record_pushed_url_in`: a real PR link, once discovery or the person supplied one, is not replaced by the creation form. */
async function recordPushedUrl(repo: string, slug: string, pushedBranch: string, url: string): Promise<void> {
  await mutateTask(repo, slug, "store pull request URL", (task) => {
    if (task.branch !== pushedBranch) throw failed("task branch changed during push");
    if (githubPullRequestRef(String(task.pr_url ?? "")) === undefined) task.pr_url = url;
  });
}

/** `set_pr_url_in`. */
export async function setPrUrl(repo: string, slug: string, url: string): Promise<void> {
  const trimmed = url.trim();
  await mutateTask(repo, slug, "set pull request URL", (task) => {
    task.pr_url = trimmed;
  });
}

/** `record_discovered_pull_request_in`: `previousUrl` and `branch` are what the lookup started from; if either moved meanwhile nothing is written. */
export async function recordDiscoveredPullRequest(repo: string, slug: string, branch: string, previousUrl: string, url: string): Promise<void> {
  if (githubPullRequestRef(url) === undefined) throw new DomainError("invalid_argument", "invalid GitHub pull request URL");
  const unchanged = (task: { branch?: unknown; pr_url?: unknown }) => {
    if (task.branch !== branch || task.pr_url !== previousUrl) throw failed("task branch or PR link changed during lookup");
  };
  // Polling an already stored PR must not rewrite task.md every minute.
  if (previousUrl === url) return unchanged(readTaskChecked(repo, slug));
  await mutateTask(repo, slug, "discover pull request URL", (task) => {
    unchanged(task);
    task.pr_url = url;
  });
}

// ---- commit, push, remove ------------------------------------------------------------------------------------

/** `commit_worktree_in`: stage everything and commit in the task's worktree. Local commit only. */
export async function commitWorktree(repo: string, slug: string, message: string): Promise<void> {
  const task = readTaskChecked(repo, slug);
  const worktree = String(task.worktree ?? "");
  if (worktree === "") throw failed("worktree removed — nothing to commit");
  const text = message.trim();
  if (text === "") throw new DomainError("invalid_argument", "commit message is empty");
  const add = await git(worktree, ["add", "-A"]);
  if (add.code !== 0) throw failed(`git add failed: ${add.stderr.trim()}`);
  const commit = await git(worktree, ["commit", "-m", text]);
  if (commit.code !== 0) throw failed(`git commit failed: ${commit.stderr.trim() || commit.stdout.trim()}`);
}

/** `remove_worktree`: `git worktree remove --force`, then clear it from task.md. The branch, sessions, artifacts and PR link survive. */
export async function removeWorktree(repo: string, slug: string): Promise<void> {
  const task = readTaskChecked(repo, slug);
  if (task.has_worktree !== true) throw failed("this task has no dedicated worktree to remove");
  const worktree = String(task.worktree ?? "");
  if (worktree === "") throw failed("worktree already removed");
  // --force: a coding session may have left the tree dirty, and the UI already gated this behind a confirmation. The branch is kept.
  const out = await git(repo, ["worktree", "remove", "--force", worktree]);
  if (out.code !== 0) throw failed(`git worktree remove failed: ${out.stderr.trim()}`);
  await mutateTask(repo, slug, "record worktree removal", (current) => {
    if (current.worktree !== worktree) throw failed("task worktree changed during removal");
    current.worktree = "";
  });
}

/** `push_and_compare_url`: push the task branch from its worktree, then build and store the forge compare URL. */
export async function pushAndCompareUrl(repo: string, slug: string): Promise<string> {
  const task = readTaskChecked(repo, slug);
  const worktree = String(task.worktree ?? "");
  if (worktree === "") throw failed("worktree removed — nothing to push");
  const branch = String(task.branch ?? "");
  const push = await git(worktree, ["push", "-u", "origin", branch]);
  if (push.code !== 0) throw failed(`git push failed: ${push.stderr.trim()}`);
  const remote = await originUrl(repo);
  if (remote === undefined) throw failed("no 'origin' remote configured");
  const url = compareUrl(remote, await defaultBaseBranch(repo), branch);
  if (url === undefined) throw failed(`could not parse remote URL: ${remote}`);
  await recordPushedUrl(repo, slug, branch, url);
  return url;
}

/** What a PR lookup needs from the repository, so the GitHub call can be made from the machine that holds the token. */
export type PullRequestInputs = { prUrl: string; branch: string; originUrl: string | undefined };

export async function pullRequestInputs(repo: string, slug: string): Promise<PullRequestInputs> {
  const task = readTaskChecked(repo, slug);
  return { prUrl: String(task.pr_url ?? ""), branch: String(task.branch ?? ""), originUrl: await originUrl(repo) };
}

// ---- the task-source branches --------------------------------------------------------------------------------

export type TaskSourceBranch = { fullRef: string; name: string };
export type TaskSourceHead = { kind: "branch"; fullRef: string; name: string } | { kind: "detached"; oid: string } | { kind: "unborn"; fullRef: string; name: string };
export type TaskSourceBranches = { branches: TaskSourceBranch[]; head: TaskSourceHead; selected: { baseRef: string; available: boolean } | undefined };

/** Discovery cannot treat a warning (a skipped broken ref, say) as an empty success: any stderr, any unexpected exit, any non-UTF-8 byte is an error. */
async function sourceGit(repo: string, args: string[], allowed: number[], input?: string): Promise<{ code: number; out: string }> {
  const r = await git(repo, args, undefined, { strict: true, input });
  if (r.stderr !== "" || !allowed.includes(r.code)) throw failed(`git ${args[0]}: exit ${r.code}: ${r.stderr}`);
  return { code: r.code, out: r.stdout };
}

const sourceLine = (output: string) => {
  const line = output.endsWith("\n") ? output.slice(0, -1) : undefined;
  if (line === undefined || line === "" || /[\n\r\0]/.test(line)) throw failed("malformed Git source identity output");
  return line;
};

const sourceOid = (value: string) => (value.length === 40 || value.length === 64) && /^[0-9a-fA-F]+$/.test(value);

async function sourceLocalRef(repo: string, fullRef: string): Promise<boolean> {
  if (!fullRef.startsWith("refs/heads/") || fullRef.includes("\0")) return false;
  const { code, out } = await sourceGit(repo, ["check-ref-format", fullRef], [0, 1]);
  if (out !== "") throw failed("malformed Git ref validation output");
  return code === 0;
}

async function sourceCommitExists(repo: string, oid: string): Promise<boolean> {
  // A SHA-1-sized value can resolve as an abbreviation in a SHA-256 repository.
  const format = sourceLine((await sourceGit(repo, ["rev-parse", "--show-object-format"], [0])).out);
  const length = format === "sha1" ? 40 : format === "sha256" ? 64 : undefined;
  if (length === undefined) throw failed("unsupported Git object format");
  if (oid.length !== length) return false;
  const { out } = await sourceGit(repo, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], [0], `${oid}\n`);
  const line = sourceLine(out);
  const space = line.indexOf(" ");
  if (space < 0) throw failed("malformed Git object output");
  if (line.slice(0, space).toLowerCase() !== oid.toLowerCase()) throw failed("Git object output did not match the requested identity");
  switch (line.slice(space + 1)) {
    case "commit":
      return true;
    case "missing":
    case "blob":
    case "tree":
    case "tag":
      return false;
    default:
      throw failed("malformed Git object type output");
  }
}

/** `task_source_branches`: the local branches, what HEAD is, and whether a saved base ref is still a branch or commit. Reads only; nothing is checked out. */
export async function taskSourceBranches(repo: string, selectedBaseRef?: string): Promise<TaskSourceBranches> {
  const listed = (await sourceGit(repo, ["for-each-ref", "--sort=refname", "--format=%(refname)%00%(objecttype)%00%(objectname)", "refs/heads/"], [0])).out;
  const branches: TaskSourceBranch[] = [];
  if (listed !== "") {
    if (!listed.endsWith("\n")) throw failed("malformed Git branch output");
    for (const row of listed.slice(0, -1).split("\n")) {
      const fields = row.split("\0");
      if (fields.length !== 3) throw failed("malformed Git branch output");
      const [fullRef, kind, oid] = fields;
      if (kind !== "commit" || !sourceOid(oid) || !(await sourceLocalRef(repo, fullRef))) throw failed("Git local branch did not identify a valid commit");
      const previous = branches.at(-1);
      if (previous && previous.fullRef >= fullRef) throw failed("Git local branches were not in unique ref-name order");
      branches.push({ fullRef, name: fullRef.slice("refs/heads/".length) });
    }
  }

  const symbolic = await sourceGit(repo, ["symbolic-ref", "--quiet", "HEAD"], [0, 1]);
  let head: TaskSourceHead;
  if (symbolic.code === 0) {
    const fullRef = sourceLine(symbolic.out);
    if (!(await sourceLocalRef(repo, fullRef))) throw failed("Git HEAD did not identify a local branch");
    // Exact existence tells an unborn branch from a present broken ref.
    const exists = await sourceGit(repo, ["show-ref", "--verify", "--quiet", fullRef], [0, 1]);
    if (exists.out !== "") throw failed("malformed Git HEAD ref output");
    const inList = branches.some((b) => b.fullRef === fullRef);
    const name = fullRef.slice("refs/heads/".length);
    if (exists.code === 0 && inList) head = { kind: "branch", fullRef, name };
    else if (exists.code === 1 && !inList) head = { kind: "unborn", fullRef, name };
    else throw failed("Git HEAD changed during source discovery; refresh and try again");
  } else {
    if (symbolic.out !== "") throw failed("malformed Git detached HEAD output");
    const oid = sourceLine((await sourceGit(repo, ["rev-parse", "--verify", "HEAD"], [0])).out);
    if (!sourceOid(oid) || !(await sourceCommitExists(repo, oid))) throw failed("Git detached HEAD did not identify a commit");
    head = { kind: "detached", oid };
  }

  let selected: TaskSourceBranches["selected"];
  if (selectedBaseRef !== undefined) {
    const available = sourceOid(selectedBaseRef) ? await sourceCommitExists(repo, selectedBaseRef) : branches.some((b) => b.fullRef === selectedBaseRef);
    selected = { baseRef: selectedBaseRef, available };
  }
  return { branches, head, selected };
}

// ---- the refs that keep an execution's files (O27) -----------------------------------------------------------

const nameFits = (name: string) => name !== "" && /^[A-Za-z0-9_-]+$/.test(name);

/**
 * `record_worktree_tree`: a tree and a ref that keep the working tree's current files (uncommitted ones included) alive for one
 * execution's history. `undefined` outside a git working tree. It uses a temporary index, so the user's index, HEAD and branch are
 * untouched; the ref is `refs/alinery/executions/<slug>/<execId>`, which survives `git gc`. Execution ids are per task (`e1`, `e2`)
 * while refs are shared by every task and worktree of the repository, so the task slug is part of the name.
 */
export async function recordWorktreeTree(dir: string, slug: string, execId: string): Promise<{ ref: string; tree: string } | undefined> {
  for (const [what, name] of [["task slug", slug], ["execution id", execId]] as const) if (!nameFits(name)) throw new Error(`${what} ${JSON.stringify(name)} cannot name a ref`);
  const top = await git(dir, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0 || top.stdout.trim() === "") return undefined;
  const gitDir = await gitText(dir, ["rev-parse", "--absolute-git-dir"]);
  const index = join(gitDir, `alinery-exec-index-${slug}-${execId}`);
  const onIndex = { env: { GIT_INDEX_FILE: index } };
  try {
    const head = await git(dir, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
    const parent = head.code === 0 ? head.stdout.trim() : undefined;
    if (parent) await gitText(dir, ["read-tree", "HEAD"], onIndex);
    await gitText(dir, ["add", "-A"], onIndex);
    const tree = await gitText(dir, ["write-tree"], onIndex);
    const author = { GIT_AUTHOR_NAME: "alinery", GIT_AUTHOR_EMAIL: "alinery@localhost", GIT_COMMITTER_NAME: "alinery", GIT_COMMITTER_EMAIL: "alinery@localhost" };
    const commit = await gitText(dir, ["commit-tree", tree, "-m", `alinery execution ${slug}/${execId}`, ...(parent ? ["-p", parent] : [])], { env: author });
    const ref = `refs/alinery/executions/${slug}/${execId}`;
    await gitText(dir, ["update-ref", ref, commit]);
    return { ref, tree };
  } finally {
    rmSync(index, { force: true });
  }
}

/** Archiving a task lets go of the files its executions kept: its `refs/alinery/executions/<slug>/*` refs go, and `git gc` can reclaim the objects. */
export async function deleteExecutionRefs(repo: string, slug: string): Promise<number> {
  if (safeComponent(slug) !== slug) throw new DomainError("invalid_argument", "invalid task slug");
  const listed = await gitText(repo, ["for-each-ref", "--format=%(refname)", `refs/alinery/executions/${slug}/`]);
  const refs = listed.split("\n").filter((r) => r !== "");
  if (refs.length === 0) return 0;
  await gitText(repo, ["update-ref", "--stdin"], { input: `${refs.map((r) => `delete ${r}`).join("\n")}\n` });
  return refs.length;
}
