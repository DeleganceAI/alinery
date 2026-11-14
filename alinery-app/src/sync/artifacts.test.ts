import { expect, it } from "vitest";
import type { ArtifactTreeNode } from "../types";
import { openFilePath } from "./artifacts";

const node = (reveal_path?: string) => ({ id: "n", kind: "owned", label: "review.md", owner_task_slug: "t", source: "owned", children: [], reveal_path }) as ArtifactTreeNode;

it("names an open file by where it is on the repo's machine", () => {
  expect(openFilePath("/r", "t", "src/a.ts", null, "/r/.alinery/worktrees/t/")).toBe("/r/.alinery/worktrees/t/src/a.ts");
  expect(openFilePath("/r", "t", "src/a.ts", null, "")).toBe("");
  expect(openFilePath("/r", "t", "review.md", node("tasks/t/artifacts/4-review/review.md"))).toBe("/r/.alinery/tasks/t/artifacts/4-review/review.md");
  // A node from an older daemon has no path, and its label is only the file name: no path rather than a wrong one.
  expect(openFilePath("/r", "t", "review.md", node())).toBe("");
  expect(openFilePath("/r", "t", "4-review/review.md", null)).toBe("/r/.alinery/tasks/t/artifacts/4-review/review.md");
  expect(openFilePath("alinery+ssh://box/home/me/r", "t", "a.md", null)).toBe("/home/me/r/.alinery/tasks/t/artifacts/a.md");
});
