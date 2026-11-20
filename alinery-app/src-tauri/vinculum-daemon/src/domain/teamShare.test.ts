import { describe, expect, test } from "bun:test";
import { changedKeys, isShareRel, revisionOf } from "./teamShare.ts";

describe("team share", () => {
  test("a numbered artifact and task.md are share paths; attachments are not", () => {
    expect(isShareRel("tasks/alpha/task.md")).toBe(true);
    expect(isShareRel("tasks/alpha/artifacts/01-notes.md")).toBe(true);
    expect(isShareRel("tasks/alpha/artifacts/attachments/pic.png")).toBe(false);
    expect(isShareRel("tasks/alpha/artifacts/notes.txt")).toBe(false);
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
});
