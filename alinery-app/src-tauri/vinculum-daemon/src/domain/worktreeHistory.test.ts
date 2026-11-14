import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readTaskChecked } from "./taskFiles.ts";
import { provisionTask } from "./tasks.ts";
import { worktreeDiff, worktreeLog } from "./worktreeHistory.ts";

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
  const dir = mkdtempSync(join(tmpdir(), "alinery-wthist-"));
  dirs.push(dir);
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-q", "-m", "init");
  const reply = await provisionTask(
    { repo, lane: "", identity: "fixture" },
    {
      name: "History Demo",
      attachments: [],
      attachmentUrls: [],
      attachmentErrors: [],
      playbook: { reference: { scope: "bundled", key: "one-shot" }, source: PLAYBOOK },
      launchDefaults: { harness: "vinculum", model: "" },
      start: false,
    } as never,
  );
  const slug = reply.task?.slug ?? "";
  return { repo, slug, worktree: String(readTaskChecked(repo, slug).worktree) };
}

test("lists only the branch's own commits, and counts staged and unstaged files", async () => {
  const { repo, slug, worktree } = await fixture();
  expect((await worktreeLog(repo, slug)).commits).toEqual([]);

  writeFileSync(join(worktree, "src", "a.ts"), "export const a = 2;\n");
  sh(worktree, "commit", "-q", "-am", "bump a");
  writeFileSync(join(worktree, "staged.ts"), "s\n");
  sh(worktree, "add", "staged.ts");
  writeFileSync(join(worktree, "src", "a.ts"), "export const a = 3;\n");
  writeFileSync(join(worktree, "new.ts"), "n\n");

  const log = await worktreeLog(repo, slug);
  expect(log.base).toBe("main");
  expect(log.commits.map((c) => [c.subject, c.author])).toEqual([["bump a", "t"]]);
  expect(log.commits[0].oid).toMatch(/^[0-9a-f]{40}$/);
  expect(log.staged).toBe(1);
  expect(log.uncommitted).toBe(2);

  const commit = await worktreeDiff(repo, slug, { case: "commit", value: log.commits[0].oid });
  expect(commit.patch).toContain("bump a");
  expect(commit.patch).toContain("+export const a = 2;");
  const staged = await worktreeDiff(repo, slug, { case: "staged", value: true });
  expect(staged.patch).toContain("+++ b/staged.ts");
  expect(staged.patch).not.toContain("a.ts");
  const uncommitted = await worktreeDiff(repo, slug, { case: "uncommitted", value: true });
  expect(uncommitted.patch).toContain("+export const a = 3;");
  expect(uncommitted.patch).toContain("+++ b/new.ts");
  expect(uncommitted.patch).not.toContain("staged.ts");

  const cut = await worktreeDiff(repo, slug, { case: "uncommitted", value: true }, 10);
  expect(cut).toEqual({ patch: uncommitted.patch.slice(0, 10), truncated: true });
});

test("refuses a target that is not a commit id", async () => {
  const { repo, slug } = await fixture();
  const err = await worktreeDiff(repo, slug, { case: "commit", value: "--output=/tmp/x" }).catch((e) => e.code);
  expect(err).toBe("invalid_argument");
  expect(await worktreeDiff(repo, slug, { case: undefined }).catch((e) => e.code)).toBe("invalid_argument");
});
