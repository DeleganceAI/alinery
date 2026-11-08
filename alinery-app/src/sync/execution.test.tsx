import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type Transport } from "@connectrpc/connect";
import { renderHook, waitFor } from "@testing-library/react";
import { type Entity, EntitySchema } from "alinery-proto/alinery/v1/entities_pb";
import type { AllowCompletionRequest } from "alinery-proto/alinery/v1/executions_pb";
import { afterEach, expect, it, vi } from "vitest";
import { daemonTransport } from "../daemon/transport";
import { cursor, daemonHarness, put, scriptedSync, snapshot, untilAborted } from "../test/daemonHarness";
import { allowExecutionCompletion, ExecutionConflict, executionKey, readTaskExecution, readTaskExecutions, replyOf, useTaskExecution } from "./execution";

vi.mock("../daemon/transport", () => ({ daemonTransport: vi.fn() }));
afterEach(() => vi.resetAllMocks());

const state = (permission: { kind: string }, lifecycle = "running") => ({
  version: 2,
  revision: 3,
  creation: "ready",
  creation_error: null,
  owning_lane: "",
  definition_identity: "id",
  reference: { scope: "bundled", key: "fork-join" },
  max_live_sessions: 4,
  enabled_steps: [],
  launch_defaults: { harness: "omp", model: "" },
  executions: { e1: { id: "e1", owner_session_id: "s1", previous_session_ids: [], lifecycle, permission, candidate: { step_key: "seed" } } },
  occurrences: {},
  contexts: {},
  collections: {},
});
const definition = { version: 2, key: "fork-join", title: "Fork join", step: [{ key: "seed", title: "Seed" }] };

const row = (permission: { kind: string }, revision: bigint, slug = "task"): Entity =>
  create(EntitySchema, {
    key: executionKey(slug),
    revision,
    value: { case: "execution", value: { slug, state: state(permission), definition } as never },
  });

function serve(rows: Entity[], execution?: { allowCompletion: (req: AllowCompletionRequest) => Promise<{ applied: { cursor: ReturnType<typeof cursor> } }> }, later?: Entity) {
  const h = scriptedSync(async function* (_req, _call, signal) {
    yield snapshot(rows, 1);
    if (later) {
      await new Promise((r) => setTimeout(r, 120));
      yield put(later, 2);
    }
    await untilAborted(signal);
  });
  vi.mocked(daemonTransport).mockReturnValue(daemonHarness({ sync: h.sync, execution: execution as never }).transport as Transport);
}

it("reads the row as the reply the views already use, with the revision it was read at", async () => {
  serve([row({ kind: "locked" }, 5n)]);
  const reply = await readTaskExecution("/a", "task");
  expect(reply.revision).toBe(5n);
  expect(reply.live).toEqual({ status: "available" });
  expect(reply.definition.title).toBe("Fork join");
  expect(reply.state.executions.e1).toMatchObject({ owner_session_id: "s1", lifecycle: "running", permission: { kind: "locked" } });
});

it("a task with no row, and a daemon that does not answer, are errors with a reason", async () => {
  serve([row({ kind: "locked" }, 5n, "other")]);
  await expect(readTaskExecution("/b", "task")).rejects.toBe("task execution state unavailable");
  const batch = await readTaskExecutions([
    { repoPath: "/b", taskSlug: "task" },
    { repoPath: "/b", taskSlug: "other" },
  ]);
  expect(batch.map((e) => [e.ref.taskSlug, e.execution?.revision ?? null, e.error])).toEqual([
    ["task", null, "task execution state unavailable"],
    ["other", 5n, ""],
  ]);
  vi.mocked(daemonTransport).mockReturnValue(
    daemonHarness({
      sync: scriptedSync(async function* () {
        await new Promise(() => {});
      }).sync,
    }).transport as Transport,
  );
  await expect(readTaskExecution("/c", "task", 40)).rejects.toMatch("did not answer");
});

it("an approval carries the task, the execution, the revision seen and a mutation id; the card moves once the delta arrives", async () => {
  const calls: { slug: string; execution: string; expected: bigint; client: string; mutation: string }[] = [];
  serve(
    [row({ kind: "locked" }, 5n)],
    {
      allowCompletion: async (req) => {
        calls.push({ slug: req.taskSlug, execution: req.executionId, expected: req.expectedRevision, client: req.meta?.clientId ?? "", mutation: req.meta?.mutationId ?? "" });
        return { applied: { cursor: cursor(2) } };
      },
    },
    row({ kind: "human_granted" }, 6n),
  );
  const { result } = renderHook(() => useTaskExecution("/d", "task"));
  await waitFor(() => expect(result.current.reply?.state.executions.e1.permission.kind).toBe("locked"));
  const seen = result.current.reply?.revision;
  expect(seen).toBe(5n);

  await allowExecutionCompletion("/d", "task", "e1", seen);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ slug: "task", execution: "e1", expected: 5n });
  expect(calls[0].client).not.toBe("");
  expect(calls[0].mutation).not.toBe("");
  // The promise waited for the replica to pass the write's cursor, so the row is already the new one.
  expect(result.current.reply?.state.executions.e1.permission.kind).toBe("human_granted");
  expect(result.current.reply?.revision).toBe(6n);
});

it("a row that moved on is refused as a conflict and the card stays as the daemon has it", async () => {
  serve([row({ kind: "locked" }, 7n)], {
    allowCompletion: async () => {
      throw new ConnectError("the execution changed since revision 5 (now 7)", Code.Aborted);
    },
  });
  await expect(allowExecutionCompletion("/e", "task", "e1", 5n)).rejects.toBeInstanceOf(ExecutionConflict);
  await expect(allowExecutionCompletion("/e", "task", "e1", 5n)).rejects.toThrow("changed since revision 5");
  const reply = await readTaskExecution("/e", "task");
  expect(reply.state.executions.e1.permission.kind).toBe("locked");
});

it("any other refusal keeps its message and is not a conflict", async () => {
  serve([row({ kind: "locked" }, 7n)], {
    allowCompletion: async () => {
      throw new ConnectError("execution e1 is done; only a live execution can be permitted", Code.FailedPrecondition);
    },
  });
  const error = await allowExecutionCompletion("/f", "task", "e1").catch((e) => e);
  expect(error).not.toBeInstanceOf(ExecutionConflict);
  expect(String(error.message)).toContain("only a live execution can be permitted");
});

// `state` and `definition` are `google.protobuf.Struct` fields, so proto3 lets either arrive unset.
// `replyOf` used to substitute `{}` and cast that through `as unknown as` — an empty object that
// satisfied the cast and then threw in a view (`definition.step.find` on `{}`). A row missing a
// half is not a reply; the caller's "no row yet" path already covers it.
it("treats a row without a definition as no row, instead of casting an empty object", () => {
  const half = create(EntitySchema, {
    key: executionKey("task"),
    revision: 1n,
    value: { case: "execution", value: { slug: "task", state: state({ kind: "locked" }) } as never },
  });
  expect(replyOf(half)).toBeUndefined();

  const otherHalf = create(EntitySchema, {
    key: executionKey("task"),
    revision: 1n,
    value: { case: "execution", value: { slug: "task", definition } as never },
  });
  expect(replyOf(otherHalf)).toBeUndefined();
});

// `definition` is a free-form Struct, so a row can carry it and still lack `step` (an older build's
// row, or one still being written). Views read `definition.step.find`, which threw and blanked the
// window. The boundary normalizes, exactly as `definitionOf` does for the typed path.
it("normalizes a definition whose step was never filled", () => {
  const hollow = create(EntitySchema, {
    key: executionKey("task"),
    revision: 1n,
    value: { case: "execution", value: { slug: "task", state: state({ kind: "locked" }), definition: {} } as never },
  });
  const reply = replyOf(hollow);
  expect(reply?.definition.step).toEqual([]);
  expect(reply?.definition.section_order).toEqual([]);
  // What the views do with it.
  expect(reply?.definition.step.find((step) => step.key === "seed")).toBeUndefined();
});
