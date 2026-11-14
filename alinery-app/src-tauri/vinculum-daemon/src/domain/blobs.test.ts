import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { artifactBlob } from "./blobs.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repoWith(name: string, text: string) {
  const dir = mkdtempSync("/tmp/blobs-");
  dirs.push(dir);
  const artifacts = join(dir, ".alinery", "tasks", "t1", "artifacts");
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(join(artifacts, name), text);
  return { dir, file: join(artifacts, name) };
}

test("a read frame returns the bytes of the regular file that was checked", () => {
  const { dir } = repoWith("a.md", "hello");
  expect(artifactBlob(dir, "t1", "a.md").read(0, 5).toString()).toBe("hello");
});

test("a link swapped in after the check is refused on the next frame, not followed", () => {
  const { dir, file } = repoWith("a.md", "hello");
  const secret = join(dir, "secret");
  writeFileSync(secret, "hello");
  const blob = artifactBlob(dir, "t1", "a.md");
  rmSync(file);
  symlinkSync(secret, file);
  expect(() => blob.read(0, 5)).toThrow(/no longer a regular file/);
});

test("a different regular file swapped in after the check is refused", () => {
  const { dir, file } = repoWith("a.md", "hello");
  const blob = artifactBlob(dir, "t1", "a.md");
  // Written beside the original and renamed over it, so the two never share an inode number.
  writeFileSync(`${file}.new`, "other");
  renameSync(`${file}.new`, file);
  expect(() => blob.read(0, 5)).toThrow(/no longer the file that was checked/);
});
