// Runs the TypeScript parser over the conformance cases Rust's readers also run
// (alinery-core/tests/conformance.rs): same inputs, same expected.json. Two domains: `task` (the file
// itself) and `board` (the fields the daemon derives, checked in domain/board.test.ts).
import { toJson } from "@bufbuild/protobuf";
import { EntitySchema } from "alinery-proto/alinery/v1/entities_pb";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Feed } from "../feed.ts";
import { Store } from "../store.ts";
import { normalize } from "../testkit.ts";
import { parseTask } from "./task.ts";

const ROOT = resolve(import.meta.dir, "../../../../conformance/task");

describe("task conformance", () => {
  for (const name of readdirSync(ROOT)) {
    test(name, async () => {
      const store = new Store();
      const feed = new Feed(store, join(ROOT, name, "input", ".alinery"));
      await feed.scan();
      const actual: Record<string, unknown> = {};
      for (const { key } of feed.tracked.values()) {
        const entity = store.get(key);
        if (!entity) continue; // a file the parser refused
        const json = toJson(EntitySchema, entity, { useProtoFieldName: true }) as { task: Record<string, unknown> };
        // The derived fields are not in task.md.
        const { board: _board, activity: _activity, ...file } = json.task;
        actual[key] = file;
      }
      const expected = JSON.parse(readFileSync(join(ROOT, name, "expected.json"), "utf8"));
      expect(normalize(actual)).toEqual(normalize(expected));
    });
  }
});

describe("task parser", () => {
  const base = 'name = "n"\nslug = "s"\nbranch = "b"\nworktree = "/w"\ncreated = 1\n';
  const task = (text: string) => {
    const e = parseTask(text, "s");
    return e?.value.case === "task" ? e.value.value : undefined;
  };
  test("defaults match serde's", () => {
    const t = task(base);
    expect(t?.hasWorktree).toBe(true);
    expect(t?.maxLiveSessions).toBe(10);
    expect(t?.playbookRef).toBeUndefined();
    expect(t?.draftBaseRef).toBeUndefined();
  });
  test("the key is the directory, the slug is the file's", () => {
    expect(parseTask(base, "dir")?.key).toBe("task/dir/dir");
    expect(task(base)?.slug).toBe("s");
  });
  test("what serde refuses is refused", () => {
    for (const bad of ["", 'name = "x', base.replace("created = 1", "created = -1"), base.replace('branch = "b"\n', ""), `${base}draft = 1\n`, `${base}[playbook_ref]\nscope = "x"\nkey = "k"\n`, `${base}auto_advance = [1]\n`]) {
      expect(parseTask(bad, "s")).toBeUndefined();
    }
  });
});
