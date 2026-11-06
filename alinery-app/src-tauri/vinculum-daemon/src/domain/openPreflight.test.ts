import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPreflight } from "./openPreflight.ts";

function repoWith(slug: string, extra: string) {
  const repo = mkdtempSync(join(tmpdir(), "preflight-"));
  mkdirSync(join(repo, ".alinery", "tasks", slug), { recursive: true });
  writeFileSync(join(repo, ".alinery", "tasks", slug, "task.md"), `name = "t"\nslug = "${slug}"\nbranch = "b"\nworktree = "/w"\ncreated = 1\n${extra}`);
  return repo;
}

test("a session outside a task opens only as the no-harness drawer, judged by the harness on disk", () => {
  const repo = repoWith("t", "engine_version = 2\n");
  expect(openPreflight(repo, "", undefined)).toBeUndefined();
  expect(openPreflight(repo, "", "no-harness")).toBeUndefined();
  expect(openPreflight(repo, "", "omp")).toBe("root sessions are limited to no-harness drawer");
  expect(openPreflight(repo, "", "")).toBe("root sessions are limited to no-harness drawer");
});

test("a task session needs a v2 task that is neither a draft nor archived, and a product harness", () => {
  expect(openPreflight(repoWith("t", "engine_version = 2\n"), "t", "omp")).toBeUndefined();
  expect(openPreflight(repoWith("t", "engine_version = 2\n"), "t", undefined)).toBeUndefined();
  expect(openPreflight(repoWith("t", "engine_version = 2\n"), "t", "claude")).toBe("unknown harness 'claude'");
  expect(openPreflight(repoWith("t", ""), "t", "omp")).toContain("pre-v2");
  expect(openPreflight(repoWith("t", "engine_version = 2\ndraft = true\n"), "t", "omp")).toBe("draft or archived tasks cannot launch sessions");
  expect(openPreflight(repoWith("t", "engine_version = 2\narchived = true\n"), "t", "omp")).toBe("draft or archived tasks cannot launch sessions");
  expect(openPreflight(repoWith("t", "engine_version = 2\n"), "missing", "omp")).toBe("no such task: missing");
});
