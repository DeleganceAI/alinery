import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { resetGraphs } from "./graph.ts";
import { completeSessionMeta, completionPermission, getTaskExecution } from "./tasks.ts";

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

type ExecutionReply = {
  state: {
    executions: Record<string, { id: string; owner_session_id: string; candidate: { inputs: Record<string, string[]> }; outputs: { selector: string; relative_path: string; required?: boolean }[] }>;
    occurrences: Record<string, { id: string; producer_execution_id: string | null; relative_path: string }>;
  };
};

function taskDir(repo: string, slug: string) {
  const dir = join(repo, ".alinery", "tasks", slug);
  mkdirSync(join(dir, "artifacts"), { recursive: true });
  writeFileSync(
    join(dir, "playbook.md"),
    `+++\nversion = 2\nkey = "fixture"\ntitle = "Fixture"\ndescription = ""\ndefault_model = ""\ndefault_harness = "omp"\n\n[[step]]\nkey = "clarify"\ntitle = "Clarify"\nshort = ""\ninputs = [{ path = "ticket.md", mode = "single" }]\noutputs = [{ path = "assessment.md", required = true }]\nmodel = ""\nharness = ""\nis_coding_step = false\nauto_advance_default = true\n\n[[step]]\nkey = "investigate"\ntitle = "Investigate"\nshort = ""\ninputs = [{ path = "assessment.md", mode = "single" }]\noutputs = [{ path = "notes.md" }]\nmodel = ""\nharness = ""\nis_coding_step = false\nauto_advance_default = true\n+++\n<!-- alinery:step clarify -->\nClarify.\n\n<!-- alinery:step investigate -->\nInvestigate.\n`,
  );
  return dir;
}

describe("task execution reply", () => {
  test("a log projects occurrence ids the graph can join, and does not write the file", () => {
    resetGraphs();
    const repo = mkdtempSync(join(tmpdir(), "vinculum-lineage-"));
    const slug = "lineage";
    const dir = taskDir(repo, slug);
    const artifacts = join(dir, "artifacts");
    const onDisk = {
      creation: "ready",
      executions: { placeholder: { id: "placeholder", candidate: { inputs: {} } } },
      occurrences: { "rust-seed": { id: "rust-seed", producer_execution_id: null, relative_path: "nope.md" } },
    };
    const file = join(dir, "execution.json");
    writeFileSync(file, JSON.stringify(onDisk));
    const before = readFileSync(file, "utf8");
    const lines = [
      { t: "seeded", occurrences: [{ id: "seed/ticket.md", role: "ticket.md", path: join(artifacts, "00-ticket.md"), producer: null }] },
      {
        t: "reserved",
        execution: { id: "e1", step: "clarify", depth: 1, inputs: { "ticket.md": ["seed/ticket.md"] }, outDir: join(artifacts, "1-clarify-1"), origin: null, automatic: true },
      },
      { t: "started", execId: "e1", sessionId: "sess-clarify" },
      {
        t: "accepted",
        execId: "e1",
        published: [{ id: "e1/assessment.md", role: "assessment.md", path: join(artifacts, "1-clarify-1", "assessment.md"), producer: "e1" }],
      },
      { t: "exited", execId: "e1" },
      {
        t: "reserved",
        execution: {
          id: "e2",
          step: "investigate",
          depth: 2,
          inputs: { "assessment.md": ["e1/assessment.md"] },
          outDir: join(artifacts, "2-investigate-1"),
          origin: null,
          automatic: true,
        },
      },
      { t: "started", execId: "e2", sessionId: "sess-investigate" },
    ];
    writeFileSync(join(dir, "engine.jsonl"), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

    const reply = getTaskExecution(repo, slug, "lane", "app") as ExecutionReply;
    const consumer = reply.state.executions.e2;
    const bound = consumer.candidate.inputs["assessment.md"];
    expect(bound).toEqual(["e1/assessment.md"]);
    expect(reply.state.occurrences[bound[0]]?.producer_execution_id).toBe("e1");
    expect(reply.state.executions.e1.owner_session_id).toBe("sess-clarify");
    expect(reply.state.occurrences["seed/ticket.md"]).toMatchObject({ producer_execution_id: null, relative_path: "00-ticket.md" });
    expect(reply.state.executions.e1.outputs).toEqual([{ selector: "assessment.md", relative_path: "1-clarify-1/assessment.md", discriminator: 0, required: true }]);
    expect(reply.state.executions.placeholder).toBeUndefined();
    expect(reply.state.occurrences["rust-seed"]).toBeUndefined();
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("no log leaves the on-disk executions and occurrences alone", () => {
    resetGraphs();
    const repo = mkdtempSync(join(tmpdir(), "vinculum-lineage-"));
    const slug = "plain";
    const dir = taskDir(repo, slug);
    const onDisk = {
      creation: "ready",
      executions: { placeholder: { id: "placeholder", owner_session_id: "kept", candidate: { inputs: {} }, outputs: [] } },
      occurrences: { "rust-seed": { id: "rust-seed", producer_execution_id: null, relative_path: "00-ticket.md" } },
    };
    writeFileSync(join(dir, "execution.json"), JSON.stringify(onDisk));

    const reply = getTaskExecution(repo, slug, "lane", "app") as ExecutionReply;
    expect(reply.state.executions.placeholder).toMatchObject({ id: "placeholder", owner_session_id: "kept" });
    expect(reply.state.occurrences["rust-seed"]).toMatchObject({ producer_execution_id: null, relative_path: "00-ticket.md" });
  });
});
