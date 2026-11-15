// The repository's requirement files: what Settings reads, what a write refuses, and the block a playbook step is given.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainError } from "../platform/lock.ts";
import { readSpecs, requirementsBlock, SPEC_MAX_CHARS, writeSpec } from "./repoSpecs.ts";

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

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "alinery-specs-"));
  dirs.push(dir);
  sh(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "x\n");
  sh(dir, "add", ".");
  sh(dir, "commit", "-q", "-m", "init");
  return dir;
}
const commit = (dir: string) => {
  sh(dir, "add", ".");
  sh(dir, "commit", "-q", "-m", "specs");
};
const refused = async (p: Promise<unknown>, code: string) => {
  const e = await p.then(() => undefined, (x) => x);
  expect(e).toBeInstanceOf(DomainError);
  expect((e as DomainError).code).toBe(code);
};

test("a repository with no specs shows three absent files and injects nothing", async () => {
  const dir = repo();
  const files = await readSpecs(dir);
  expect(files.map((f) => [f.name, f.present])).toEqual([["requirements.md", false], ["tooling.md", false], ["architecture.md", false]]);
  expect(await requirementsBlock(dir)).toBe("");
});

test("a file written in place is present and uncommitted, and a step is not given it until it is committed", async () => {
  const dir = repo();
  await writeSpec(dir, "requirements.md", "Use ruff.\n");
  const [req] = await readSpecs(dir);
  expect(req).toMatchObject({ present: true, text: "Use ruff.\n", committed: false });
  expect(await requirementsBlock(dir)).toBe("");
  commit(dir);
  expect((await readSpecs(dir))[0].committed).toBe(true);
  const block = await requirementsBlock(dir);
  expect(block).toContain("### specs/requirements.md\n\nUse ruff.");
  expect(block).toContain("bind this step");
});

test("a step sees the committed text, not an edit made after the commit", async () => {
  const dir = repo();
  await writeSpec(dir, "tooling.md", "ruff 0.4\n");
  commit(dir);
  await writeSpec(dir, "tooling.md", "ruff 9.9\n");
  expect(await requirementsBlock(dir)).toContain("ruff 0.4");
  expect(await requirementsBlock(dir)).not.toContain("ruff 9.9");
  expect((await readSpecs(dir))[1]).toMatchObject({ text: "ruff 9.9\n", committed: false });
});

test("only the three names are read: other files in specs/ are ignored", async () => {
  const dir = repo();
  mkdirSync(join(dir, "specs"));
  writeFileSync(join(dir, "specs", "notes.md"), "unrelated\n");
  commit(dir);
  expect(await requirementsBlock(dir)).toBe("");
});

test("a write refuses a name outside the three, text over the limit, and a symlinked specs or file", async () => {
  const dir = repo();
  await refused(writeSpec(dir, "../outside.md", "x"), "invalid_argument");
  await refused(writeSpec(dir, "notes.md", "x"), "invalid_argument");
  await refused(writeSpec(dir, "requirements.md", "a".repeat(SPEC_MAX_CHARS + 1)), "invalid_argument");

  const outside = mkdtempSync(join(tmpdir(), "alinery-specs-out-"));
  dirs.push(outside);
  symlinkSync(outside, join(dir, "specs"));
  await refused(writeSpec(dir, "requirements.md", "x"), "failed_precondition");
  expect(existsSync(join(outside, "requirements.md"))).toBe(false);
  expect((await readSpecs(dir)).every((f) => !f.present)).toBe(true);
  rmSync(join(dir, "specs"));

  mkdirSync(join(dir, "specs"));
  writeFileSync(join(outside, "secret"), "s");
  symlinkSync(join(outside, "secret"), join(dir, "specs", "tooling.md"));
  await refused(writeSpec(dir, "tooling.md", "x"), "failed_precondition");
  expect(readFileSync(join(outside, "secret"), "utf8")).toBe("s");
  expect((await readSpecs(dir))[1].present).toBe(false);
});

test("a file over the limit is flagged and not returned, and an injected one is cut", async () => {
  const dir = repo();
  mkdirSync(join(dir, "specs"));
  writeFileSync(join(dir, "specs", "architecture.md"), "a".repeat(SPEC_MAX_CHARS + 1));
  commit(dir);
  expect((await readSpecs(dir))[2]).toMatchObject({ present: true, text: "", tooLarge: true });
  expect(await requirementsBlock(dir)).toContain(`[truncated at ${SPEC_MAX_CHARS} characters]`);
});

test("a directory that is not a git repository reads as uncommitted and injects nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "alinery-specs-nogit-"));
  dirs.push(dir);
  await writeSpec(dir, "requirements.md", "x\n");
  expect((await readSpecs(dir))[0]).toMatchObject({ present: true, committed: false });
  expect(await requirementsBlock(dir)).toBe("");
});
