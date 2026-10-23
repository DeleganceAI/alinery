import { expect, test } from "bun:test";
import { completeSessionMeta } from "./tasks.ts";

test("a session born without a meta file still has the fields SessionMeta requires", () => {
  const born = completeSessionMeta({ id: "s" }, { started_at: 10, harness: "omp", harness_resume_token: "", model: "alinery/x" }, "s", "/wt", 10);
  expect(born).toEqual({
    id: "s",
    started_at: 10,
    harness: "vinculum",
    harness_resume_token: "",
    model: "alinery/x",
    worktree: "/wt",
    created: 10,
  });
});

test("a later patch keeps worktree and created already on the file", () => {
  const next = completeSessionMeta({ id: "s", worktree: "/wt", created: 3, model: "a" }, { model: "b" }, "s", "/other", 99);
  expect(next.worktree).toBe("/wt");
  expect(next.created).toBe(3);
  expect(next.model).toBe("b");
});
