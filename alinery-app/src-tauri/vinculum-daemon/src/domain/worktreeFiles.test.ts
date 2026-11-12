import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { worktreeFileBlob } from "./blobs.ts";
import { readTaskChecked } from "./taskFiles.ts";
import { mutateTask, provisionTask } from "./tasks.ts";
import { listWorktreeFiles, worktreeFilePath } from "./worktreeFiles.ts";

const PLAYBOOK = readFileSync(resolve(import.meta.dir, "../../../playbooks/one-shot/playbook.md"), "utf8");
const dirs: string[] = [];
let savedGitDir: string | undefined;
beforeAll(() => {
  savedGitDir = process.env.GIT_DIR;
  process.env.GIT_DIR = join(tmpdir(), "alinery-wrong-git-dir");
});
afterAll(() => {
  if (savedGitDir === undefined) delete process.env.GIT_DIR;
  else process.env.GIT_DIR = savedGitDir;
});
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function sh(dir: string, ...args: string[]) {
  const env = { ...process.env };
  delete env.GIT_DIR;
  const r = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { stdout: "pipe", stderr: "pipe", env });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

/** A repository with one task whose worktree holds a tracked file, an untracked file, an ignored file and a link out. */
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "alinery-wtfiles-"));
  dirs.push(dir);
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, ".gitignore"), "ignored.log\n");
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-q", "-m", "init");
  writeFileSync(join(dir, "secret.txt"), "outside\n");
  const reply = await provisionTask(
    { repo, lane: "", identity: "fixture" },
    {
      name: "Files Demo",
      attachments: [],
      attachmentUrls: [],
      attachmentErrors: [],
      playbook: { reference: { scope: "bundled", key: "one-shot" }, source: PLAYBOOK },
      launchDefaults: { harness: "omp", model: "" },
      start: false,
    } as never,
  );
  const slug = reply.task?.slug ?? "";
  const worktree = String(readTaskChecked(repo, slug).worktree);
  writeFileSync(join(worktree, "notes.md"), "# Notes\n");
  writeFileSync(join(worktree, "ignored.log"), "noise\n");
  symlinkSync(join(dir, "secret.txt"), join(worktree, "escape.txt"));
  symlinkSync(dir, join(worktree, "outdir"));
  return { dir, repo, slug, worktree };
}

const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return "ok";
};

test("lists tracked and untracked worktree files, without ignored ones, sorted", async () => {
  const { repo, slug } = await fixture();
  const { paths, truncated } = await listWorktreeFiles(repo, slug);
  expect(paths).toContain("src/a.ts");
  expect(paths).toContain("notes.md");
  expect(paths).toContain(".gitignore");
  expect(paths).not.toContain("ignored.log");
  expect(paths).toEqual([...paths].sort());
  expect(truncated).toBe(false);
  const capped = await listWorktreeFiles(repo, slug, 1);
  expect(capped).toEqual({ paths: [paths[0]], truncated: true });
});

test("reads a worktree file and refuses every way out of the worktree", async () => {
  const { repo, slug, worktree } = await fixture();
  const blob = worktreeFileBlob(repo, slug, "src/a.ts");
  expect(new TextDecoder().decode(blob.read(0, blob.total))).toBe("export const a = 1;\n");
  expect(worktreeFilePath(repo, slug, "notes.md")).toBe(join(realpathSync(worktree), "notes.md"));

  for (const bad of ["", "/etc/passwd", "../secret.txt", "src/../../secret.txt", "./notes.md", "src//a.ts", ".git/config", "src/.git/x"]) {
    expect([bad, code(() => worktreeFilePath(repo, slug, bad))]).toEqual([bad, "invalid_argument"]);
  }
  expect(code(() => worktreeFilePath(repo, slug, "escape.txt"))).toBe("permission_denied");
  expect(code(() => worktreeFilePath(repo, slug, "outdir/secret.txt"))).toBe("permission_denied");
  expect(code(() => worktreeFilePath(repo, slug, "missing.md"))).toBe("not_found");
});

test("refuses a task whose recorded worktree points outside .alinery/worktrees", async () => {
  const { dir, repo, slug } = await fixture();
  await mutateTask(repo, slug, "test: point the worktree elsewhere", (task) => {
    task.worktree = dir;
  });
  expect(code(() => worktreeFilePath(repo, slug, "secret.txt"))).toBe("permission_denied");
  expect(await listWorktreeFiles(repo, slug).then(() => "ok", (e) => e.code)).toBe("permission_denied");
});
