import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadComments } from "./artifactComments.ts";
import { changedKeys, isShareRel, readCommentCursor, revisionOf, saveTeamComments, snapshotShare, type TeamComment } from "./teamShare.ts";

describe("team share", () => {
  test("task.md and every artifact markdown are share paths, including a step folder", () => {
    expect(isShareRel("tasks/alpha/task.md")).toBe(true);
    expect(isShareRel("tasks/alpha/artifacts/01-notes.md")).toBe(true);
    expect(isShareRel("tasks/alpha/artifacts/1-story-1/story.md")).toBe(true);
    expect(isShareRel("tasks/alpha/artifacts/attachments/pic.png")).toBe(false);
    expect(isShareRel("tasks/alpha/artifacts/attachments/note.md")).toBe(false);
    expect(isShareRel("tasks/alpha/artifacts/notes.txt")).toBe(false);
    expect(isShareRel("tasks/alpha/artifacts/../task.md")).toBe(false);
  });

  test("a rename is a delete of the old key plus an insert of the new one", () => {
    const prev = new Map([
      ["alpha", "a"],
      ["alpha/01-old.md", "b"],
    ]);
    const next = new Map([
      ["alpha", "a"],
      ["alpha/01-new.md", "b"],
    ]);
    expect(changedKeys(prev, next)).toEqual({ upsert: ["alpha/01-new.md"], deleted: ["alpha/01-old.md"] });
  });

  test("an unchanged revision is not pushed again", () => {
    const same = new Map([["alpha", revisionOf("hello")]]);
    expect(changedKeys(same, same)).toEqual({ upsert: [], deleted: [] });
  });

  test("a step folder's markdown is shared and an attachment is not", () => {
    const repo = mkdtempSync(join(tmpdir(), "team-share-"));
    const artifacts = join(repo, ".alinery", "tasks", "alpha", "artifacts");
    mkdirSync(join(artifacts, "1-story-1"), { recursive: true });
    mkdirSync(join(artifacts, "attachments"), { recursive: true });
    writeFileSync(join(repo, ".alinery", "tasks", "alpha", "task.md"), "# Alpha\n");
    writeFileSync(join(artifacts, "00-ticket.md"), "ticket\n");
    writeFileSync(join(artifacts, "1-story-1", "story.md"), "story\n");
    writeFileSync(join(artifacts, "attachments", "note.md"), "hidden\n");
    const snap = snapshotShare(repo);
    expect([...snap.artifacts.keys()].sort()).toEqual(["alpha/00-ticket.md", "alpha/1-story-1/story.md"]);
    expect(snap.artifacts.get("alpha/1-story-1/story.md")?.body).toBe("story\n");
    expect(snap.tasks.has("alpha")).toBe(true);
  });

  test("a teammate's comment lands in the comments file with its author, once, and moves the cursor", () => {
    const repo = mkdtempSync(join(tmpdir(), "team-comments-"));
    const artifacts = join(repo, ".alinery", "tasks", "alpha", "artifacts");
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, "01-plan.md"), "# Plan\n\nShip it.\n");
    const row: TeamComment = {
      task_slug: "alpha",
      filename: "01-plan.md",
      body: "tighten this",
      created_at: "2026-11-21T19:00:00.000+00:00",
      author_email: "bo@example.com",
      anchor_id: "p:3-3:abc",
      anchor_kind: "p",
      anchor_label: "Ship it.",
      anchor_excerpt: "Ship it.",
      line_start: 3,
      line_end: 3,
    };
    const gone: TeamComment = { ...row, filename: "02-gone.md", created_at: "2026-11-21T19:00:01.000+00:00" };
    expect(saveTeamComments(repo, [row, gone])).toBe(1);
    expect(saveTeamComments(repo, [row])).toBe(0);
    expect(readCommentCursor(repo)).toBe(gone.created_at);
    expect(loadComments(repo, "alpha", "01-plan.md")).toEqual([
      expect.objectContaining({ author: "bo@example.com", anchor_id: "p:3-3:abc", line_start: 3, body: "tighten this", created_at_ms: Date.parse(row.created_at) }),
    ]);
    expect(readFileSync(join(artifacts, "01-plan.comments.md"), "utf8")).toContain("- Author: bo@example.com\n");
  });
});
