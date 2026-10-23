import { expect, test } from "bun:test";
import { completeSessionMeta, completionPermission } from "./tasks.ts";

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

test("a gated execution stays locked until it is permitted, and auto-approve-all opens it", () => {
  const execution = { id: "e", sessionId: "s", permitted: false, automatic: false };
  expect(completionPermission(execution, false)).toEqual({ kind: "locked" });
  expect(completionPermission(execution, true)).toEqual({ kind: "automatic" });
  expect(completionPermission({ ...execution, permitted: true }, false)).toEqual({ kind: "human_granted", execution_id: "e", session_id: "s" });
  expect(completionPermission({ ...execution, automatic: true }, false)).toEqual({ kind: "automatic" });
});

test("reopening a stopped session removes the exit stamp", () => {
  const next = completeSessionMeta({ id: "s", worktree: "/wt", created: 3, ended_at: 9, exit_code: 0 }, { ended_at: null, exit_code: null }, "s", "/wt", 10);
  expect(next.ended_at).toBeUndefined();
  expect(next.exit_code).toBeUndefined();
  expect(next.created).toBe(3);
});
