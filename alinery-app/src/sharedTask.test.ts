import { describe, expect, it } from "vitest";
import { sharedArtifactComments, sharedTasks } from "./sharedTask";

const TASK_MD = `name = "Permission related issues"
slug = "permission-related-issues"
branch = "permission-related-issues"
created = 1794869957
archived = false
playbook = ""
auto_advance = [ "run-eval" ]

[playbook_ref]
scope = "repo"
key = "superdevelop"
`;

describe("sharedTasks", () => {
  it("reads the task's name, playbook and dates from task.md and groups its artifacts", () => {
    const [task] = sharedTasks({
      tasks: [{ task_slug: "permission-related-issues", body: TASK_MD, updated_at: "2026-11-20T10:00:00Z" }],
      artifacts: [
        { task_slug: "permission-related-issues", filename: "02-plan.md", updated_at: "2026-11-20T12:00:00Z" },
        { task_slug: "permission-related-issues", filename: "00-ticket.md", updated_at: "2026-11-20T09:00:00Z" },
        { task_slug: "other", filename: "00-ticket.md" },
      ],
      comments: [{ id: "c1", task_slug: "permission-related-issues", filename: "00-ticket.md", body: "ok" }],
    });
    expect(task).toMatchObject({
      slug: "permission-related-issues",
      name: "Permission related issues",
      branch: "permission-related-issues",
      playbook: "superdevelop",
      archived: false,
      created: 1794869957,
      updated: Date.parse("2026-11-20T12:00:00Z") / 1000,
      commentCount: 1,
    });
    expect(task.artifacts.map((artifact) => artifact.filename)).toEqual(["00-ticket.md", "02-plan.md"]);
  });

  it("falls back to the slug and Free-form when task.md says nothing", () => {
    const [task] = sharedTasks({ tasks: [{ task_slug: "bare", body: "" }, { body: "no slug" }], artifacts: [], comments: [] });
    expect(task).toMatchObject({ slug: "bare", name: "bare", playbook: "Free-form", created: 0 });
  });
});

describe("sharedArtifactComments", () => {
  it("keeps one artifact's comments with their anchor and author", () => {
    const comments = sharedArtifactComments(
      [
        { id: "c1", task_slug: "t", filename: "01-plan.md", body: "tighten", anchor_id: "p:3-3:x", line_start: 3, line_end: 3, author_email: "ada@example.com" },
        { id: "c2", task_slug: "t", filename: "02-other.md", body: "skip" },
      ],
      "t",
      "01-plan.md",
    );
    expect(comments).toEqual([expect.objectContaining({ id: "c1", anchor_id: "p:3-3:x", line_start: 3, author: "ada@example.com", artifact: "01-plan.md" })]);
  });
});
