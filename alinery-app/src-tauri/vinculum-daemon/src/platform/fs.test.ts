import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";
import { fullSyncsIssued, mkdirOwnerOnly, writeAtomic, writeDurable, writeOwnerOnly } from "./fs.ts";

const dir = mkdtempSync(join(tmpdir(), "daemon-fs-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const mode = (path: string) => statSync(path).mode & 0o777;

test("writeAtomic replaces the file and leaves no temp file", () => {
  const path = join(dir, "a.json");
  writeFileSync(path, "old");
  writeAtomic(path, "new");
  expect(readFileSync(path, "utf8")).toBe("new");
  expect(readdirSync(dir).filter((name) => name.startsWith("a.json"))).toEqual(["a.json"]);
});

test("writeDurable writes the same bytes and leaves no temp file", async () => {
  const path = join(dir, "d.json");
  await writeDurable(path, new Uint8Array([1, 2, 3]));
  await writeDurable(path, "{}");
  expect(readFileSync(path, "utf8")).toBe("{}");
  expect(readdirSync(dir).filter((name) => name.startsWith("d.json"))).toEqual(["d.json"]);
});

test("writeDurable issues two full syncs per write: the file, then its directory", async () => {
  const path = join(dir, "sync.json");
  await writeDurable(path, "a"); // starts the worker if it is not running yet
  const before = fullSyncsIssued();
  await writeDurable(path, "b");
  await writeDurable(path, "c");
  expect(fullSyncsIssued() - before).toBe(4);
});

test("writeDurable rejects when the directory is missing", async () => {
  await expect(writeDurable(join(dir, "missing", "x.json"), "x")).rejects.toThrow();
});

test("writeOwnerOnly makes a 0600 file and mkdirOwnerOnly a 0700 directory", () => {
  const secret = join(dir, "secrets", "key.json");
  mkdirOwnerOnly(join(dir, "secrets"));
  writeOwnerOnly(secret, "k");
  expect(mode(secret)).toBe(0o600);
  expect(mode(join(dir, "secrets"))).toBe(0o700);
});
