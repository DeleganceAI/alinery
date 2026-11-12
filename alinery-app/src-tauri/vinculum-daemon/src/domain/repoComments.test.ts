import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { addComment, archiveComments, loadComments, pendingStatus, prepareCommentsPrompt, repoCommentTargets, repoCommentsDir } from "./artifactComments.ts";
import { readTaskChecked } from "./taskFiles.ts";
import { provisionTask } from "./tasks.ts";

const PLAYBOOK = readFileSync(resolve(import.meta.dir, "../../../playbooks/one-shot/playbook.md"), "utf8");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function sh(dir: string, ...args: string[]) {
  const env = { ...process.env };
  delete env.GIT_DIR;
  const r = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { stdout: "pipe", stderr: "pipe", env });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "alinery-repocomments-"));
  dirs.push(dir);
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "docs"), { recursive: true });
  writeFileSync(join(repo, "docs", "plan.md"), "# Plan\n\nShip it.\n");
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-q", "-m", "init");
  const reply = await provisionTask(
    { repo, lane: "", identity: "fixture" },
    { name: "Repo Comments", attachments: [], attachmentUrls: [], attachmentErrors: [], playbook: { reference: { scope: "bundled", key: "one-shot" }, source: PLAYBOOK }, launchDefaults: { harness: "omp", model: "" }, start: false } as never,
  );
  const slug = reply.task?.slug ?? "";
  return { repo, slug, worktree: String(readTaskChecked(repo, slug).worktree) };
}

const input = { anchor_id: "p1", anchor_kind: "p", anchor_label: "Ship it.", anchor_excerpt: "Ship it.", line_start: 3, line_end: 3, body: "Which release?" };
const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return "ok";
};

test("a comment on a worktree file lives under the task, never in the worktree, and sends as a review", async () => {
  const { repo, slug, worktree } = await fixture();
  const target = "repo:docs/plan.md";
  addComment(repo, slug, target, input);
  expect(loadComments(repo, slug, target).map((c) => c.body)).toEqual(["Which release?"]);
  expect(existsSync(join(repoCommentsDir(repo, slug), "docs", "plan.comments.json"))).toBe(true);
  expect(existsSync(join(worktree, "docs", "plan.comments.json"))).toBe(false);
  expect(repoCommentTargets(repo, slug)).toEqual([target]);

  const prompt = prepareCommentsPrompt(repo, slug, [target]);
  expect(prompt.text).toContain("`docs/plan.md`");
  expect(prompt.text).not.toContain("repo:");

  const review = archiveComments(repo, slug, target);
  expect(review).toBe("repo:docs/plan.review-002.md");
  expect(pendingStatus(repo, slug, target)).toEqual({ artifact: target, review });
  // The agent edits the file: the pending mark clears.
  writeFileSync(join(worktree, "docs", "plan.md"), "# Plan\n\nShip it in 2.0.\n");
  expect(pendingStatus(repo, slug, target)).toBeUndefined();
});

test("a repo target refuses paths out of the worktree", async () => {
  const { repo, slug } = await fixture();
  for (const bad of ["repo:../x.md", "repo:", "repo:.git/config", "repo:/etc/passwd"]) {
    expect([bad, code(() => addComment(repo, slug, bad, input))]).toEqual([bad, "invalid_argument"]);
  }
});
