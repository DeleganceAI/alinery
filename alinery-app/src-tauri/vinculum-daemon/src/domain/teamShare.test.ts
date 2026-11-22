import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addComment, loadComments } from "./artifactComments.ts";
import { changedKeys, commentKey, isShareRel, pullTeamComments, readCommentCursor, revisionOf, saveTeamComments, shareArtifactName, snapshotShare, type TeamComment, writeShareFile } from "./teamShare.ts";

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

  test("a pull on request answers not shared without a share, and fetches now with one", async () => {
    const repo = mkdtempSync(join(tmpdir(), "team-pull-"));
    expect(await pullTeamComments(repo)).toEqual({ shared: false, saved: 0 });

    const artifacts = join(repo, ".alinery", "tasks", "alpha", "artifacts");
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, "01-plan.md"), "# Plan\n\nShip it.\n");
    const comment = { task_slug: "alpha", filename: "01-plan.md", body: "now", created_at: "2026-11-21T19:05:00.000+00:00", author_email: "bo@example.com" };
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ comments: [comment], more: false }) });
    try {
      writeShareFile(repo, { team_id: "t", name: "r", token: "sync_x", accounts_url: `http://127.0.0.1:${server.port}` });
      expect(await pullTeamComments(repo)).toEqual({ shared: true, saved: 1 });
      expect(await pullTeamComments(repo)).toEqual({ shared: true, saved: 0 });
      expect(loadComments(repo, "alpha", "01-plan.md")).toEqual([expect.objectContaining({ author: "bo@example.com", body: "now" })]);
    } finally {
      server.stop(true);
    }
  });

  test("the owner's own comments are shared, a teammate's are not, and comments.md is no artifact", () => {
    const repo = mkdtempSync(join(tmpdir(), "team-own-comments-"));
    const artifacts = join(repo, ".alinery", "tasks", "alpha", "artifacts");
    mkdirSync(join(artifacts, "1-roll-1"), { recursive: true });
    writeFileSync(join(artifacts, "1-roll-1", "roll.md"), "# Roll\n\nA 3.\n");
    const anchor = { anchor_id: "p:3-3:abc", anchor_kind: "p", anchor_label: "A 3.", anchor_excerpt: "A 3.", line_start: 3, line_end: 3 };
    addComment(repo, "alpha", "1-roll-1/roll.md", { ...anchor, body: "mine" });
    addComment(repo, "alpha", "1-roll-1/roll.md", { ...anchor, body: "theirs" }, { author: "bo@example.com", created_at_ms: 1_700_000_000_000 });
    expect(snapshotShare(repo).artifacts.has("alpha/1-roll-1/roll.comments.md")).toBe(false);
    expect(shareArtifactName("1-roll-1/roll.comments.md")).toBe(false);
    const own = [...snapshotShare(repo).comments.values()].map((row) => row.comment);
    expect(own).toEqual([expect.objectContaining({ task_slug: "alpha", filename: "1-roll-1/roll.md", body: "mine", anchor_id: "p:3-3:abc", line_start: 3 })]);
    expect(snapshotShare(repo).comments.has(commentKey(own[0]))).toBe(true);
    expect(isShareRel("tasks/alpha/artifacts/1-roll-1/roll.comments.json")).toBe(true);
    expect(isShareRel("tasks/alpha/artifacts/1-roll-1/roll.comments.md")).toBe(false);
    expect(isShareRel("tasks/alpha/artifacts/attachments/x.comments.json")).toBe(false);
  });
});
