// The library pieces the conformance cases do not reach (plan S4.6): the compiled-in set is the set of directories on disk, and the
// no-repository roots reach the bundled and global scopes only.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parsePlaybookDocument } from "playbook-engine/src/playbook-md.ts";
import { BUNDLED_PLAYBOOKS } from "./bundledPlaybooks.ts";
import { appConfigDirOf, loadCatalog, resolvePlaybook } from "./playbookLibrary.ts";

const DIR = resolve(import.meta.dir, "../../../playbooks");

test("the compiled-in playbooks are exactly the bundled directories, each as it is on disk and each valid", () => {
  const onDisk = readdirSync(DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(DIR, e.name, "playbook.md")))
    .map((e) => e.name)
    .sort();
  expect(BUNDLED_PLAYBOOKS.map(([key]) => key).sort()).toEqual(onDisk);
  for (const [key, text] of BUNDLED_PLAYBOOKS) {
    expect(text).toBe(readFileSync(join(DIR, key, "playbook.md"), "utf8"));
    expect(parsePlaybookDocument(text).document?.key).toBe(key);
  }
});

test("with no repository the catalog and a repo-scoped read stop at the machine's scopes", () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-lib-"));
  try {
    const roots = { globalConfigDir: dir, repoDir: "" };
    const scopes = new Set(loadCatalog(roots).candidates.map((c) => c.source.reference.scope));
    expect([...scopes]).toEqual(["bundled"]);
    expect(() => resolvePlaybook(roots, { scope: "repo", key: "x" })).toThrow(/active repository/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a development instance's app.toml belongs to the stable config directory", () => {
  expect(appConfigDirOf("/cfg/instances/dev/app.toml")).toBe("/cfg");
  expect(appConfigDirOf("/cfg/app.toml")).toBe("/cfg");
});
