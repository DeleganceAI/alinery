import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type Transport } from "@connectrpc/connect";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { InstallReviewHandoffRequest, RecordOutboundHandoffRequest } from "alinery-proto/alinery/v1/artifacts_pb";
import { type Entity, EntitySchema } from "alinery-proto/alinery/v1/entities_pb";
import { afterEach, expect, it, vi } from "vitest";
import { daemonTransport } from "../daemon/transport";
import { cursor, daemonHarness, put, scriptedSync, snapshot, untilAborted } from "../test/daemonHarness";
import {
  ArtifactConflict,
  addComment,
  FileNotShown,
  readArtifactText,
  readWorktreeText,
  saveCommentDraft,
  sendReviewHandoff,
  useTaskArtifacts,
  WORKTREE_FILE_MAX_BYTES,
} from "./artifacts";

vi.mock("../daemon/transport", () => ({ daemonTransport: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const row = (key: string, value: Entity["value"], revision = 1n): Entity => create(EntitySchema, { key, revision, value });
const artifact = (name: string, position: number) => row(`artifact/task/${name}`, { case: "artifact", value: { slug: "task", name, position, handoffs: [] } as never });
const attachment = (name: string, position: number) => row(`attachment/task/${name}`, { case: "attachment", value: { slug: "task", name, position } as never });
const comment = (id: string, artifactName: string, body: string, lineStart = 1) =>
  row(`comment/task/${artifactName}/${id}`, {
    case: "comment",
    value: {
      id,
      artifact: artifactName,
      anchorId: "a",
      anchorKind: "line",
      anchorLabel: "Line",
      anchorExcerpt: "x",
      lineStart,
      lineEnd: lineStart,
      body,
      createdAtMs: 5n,
    } as never,
  });

function serve(rows: Entity[], later?: Entity, artifacts?: Parameters<typeof daemonHarness>[0]["artifacts"], blobs?: Parameters<typeof daemonHarness>[0]["blobs"]) {
  const h = scriptedSync(async function* (_req, _call, signal) {
    yield snapshot(rows, 1);
    if (later) {
      await new Promise((r) => setTimeout(r, 120));
      yield put(later, 2);
    }
    await untilAborted(signal);
  });
  return daemonHarness({ sync: h.sync, artifacts, blobs }).transport as Transport;
}

it("lists the task's artifacts in playbook order and its attachments after them", async () => {
  vi.mocked(daemonTransport).mockReturnValue(serve([attachment("shot.png", 0), artifact("02-plan.md", 1), artifact("00-ticket.md", 0)]));
  const { result } = renderHook(() => useTaskArtifacts("/a", "task"));
  await waitFor(() => expect(result.current.ready).toBe(true));
  expect(result.current.items.map((i) => [i.name, i.attachment])).toEqual([
    ["00-ticket.md", false],
    ["02-plan.md", false],
    ["shot.png", true],
  ]);
});

it("a comment another client added arrives on the stream with no poll", async () => {
  vi.mocked(daemonTransport).mockReturnValue(serve([artifact("00-ticket.md", 0), comment("c1", "00-ticket.md", "first")], comment("c2", "00-ticket.md", "second", 4)));
  const { result } = renderHook(() => useTaskArtifacts("/b", "task"));
  await waitFor(() => expect(result.current.comments.map((c) => c.body)).toEqual(["first"]));
  await waitFor(() => expect(result.current.comments.map((c) => c.body)).toEqual(["first", "second"]));
});

it("a comment write carries the task, the artifact and the anchor, and resolves once the replica has the row", async () => {
  const calls: { slug: string; artifact: string; body: string; anchor: string; mutation: string }[] = [];
  vi.mocked(daemonTransport).mockReturnValue(
    serve([artifact("00-ticket.md", 0)], comment("c9", "00-ticket.md", "typed"), {
      addComment: async (req) => {
        calls.push({ slug: req.taskSlug, artifact: req.artifact, body: req.comment?.body ?? "", anchor: req.comment?.anchorId ?? "", mutation: req.meta?.mutationId ?? "" });
        return { commentId: "c9", applied: { cursor: cursor(2) } } as never;
      },
    }),
  );
  const { result } = renderHook(() => useTaskArtifacts("/c", "task"));
  await waitFor(() => expect(result.current.ready).toBe(true));
  const id = await addComment({
    repoPath: "/c",
    taskSlug: "task",
    artifact: "00-ticket.md",
    anchorId: "a",
    anchorKind: "line",
    anchorLabel: "Line",
    anchorExcerpt: "x",
    lineStart: 1,
    lineEnd: 1,
    body: "typed",
  });
  expect(id).toBe("c9");
  expect(calls).toEqual([{ slug: "task", artifact: "00-ticket.md", body: "typed", anchor: "a", mutation: expect.any(String) }]);
  expect(calls[0].mutation).not.toBe("");
  expect(result.current.comments.map((c) => c.body)).toEqual(["typed"]);
});

it("a draft that moved on is a conflict; any other refusal keeps its message", async () => {
  let refuse: ConnectError = new ConnectError("the draft changed since revision 2 (now 4)", Code.Aborted);
  vi.mocked(daemonTransport).mockReturnValue(
    serve([artifact("00-ticket.md", 0)], undefined, {
      saveCommentDraft: async () => {
        throw refuse;
      },
    }),
  );
  const draft = {
    repoPath: "/d",
    taskSlug: "task",
    artifact: "00-ticket.md",
    anchorId: "a",
    anchorKind: "line",
    anchorLabel: "L",
    anchorExcerpt: "x",
    lineStart: 1,
    lineEnd: 1,
    body: "b",
  };
  await expect(saveCommentDraft(draft, 2n)).rejects.toBeInstanceOf(ArtifactConflict);
  refuse = new ConnectError("no such artifact", Code.NotFound);
  const error = await saveCommentDraft(draft).catch((e) => e);
  expect(error).not.toBeInstanceOf(ArtifactConflict);
  expect(String(error.message)).toContain("no such artifact");
});

it("reads an artifact's text through the blob stream", async () => {
  vi.mocked(daemonTransport).mockReturnValue(
    serve([], undefined, undefined, {
      readBlob: async function* (req) {
        const target = req.ref?.target;
        expect(target?.case).toBe("artifact");
        yield { data: new TextEncoder().encode("# Ti") } as never;
        yield { data: new TextEncoder().encode("cket") } as never;
      },
    }),
  );
  expect(await readArtifactText("/e", "task", "00-ticket.md")).toBe("# Ticket");
});

it("reads a worktree file, and declines a large or binary one naming its size", async () => {
  const reply = (data: Uint8Array, total: number) =>
    serve([], undefined, undefined, {
      readBlob: async function* (req) {
        expect(req.ref?.target?.case).toBe("worktreeFile");
        expect(req.length).toBe(BigInt(WORKTREE_FILE_MAX_BYTES + 1));
        yield { data, total: BigInt(total) } as never;
      },
    });
  vi.mocked(daemonTransport).mockReturnValue(reply(new TextEncoder().encode("ok"), 2));
  expect(await readWorktreeText("/e", "task", "a.ts")).toBe("ok");
  vi.mocked(daemonTransport).mockReturnValue(reply(new Uint8Array(4), 3 * 1024 * 1024));
  const big = await readWorktreeText("/e", "task", "big.log").catch((e) => e);
  expect(big).toBeInstanceOf(FileNotShown);
  expect(big.message).toBe("Too large to show (3.0 MB).");
  vi.mocked(daemonTransport).mockReturnValue(reply(new Uint8Array([1, 0, 2]), 2048));
  expect((await readWorktreeText("/e", "task", "x.png").catch((e) => e)).message).toBe("Binary file, not shown (2.0 KB).");
});

const handoffArgs = {
  sourceRepoPath: "/src",
  targetRepoPath: "/dst",
  sourceSlug: "s-task",
  sourceSession: "sess",
  sourceArtifact: "03-review.md",
  targetSlug: "t-task",
  targetPhase: "build",
  harness: "vinculum",
  model: "",
  promptExtra: "go",
};

it("a review handoff reads the source's text, installs it on the target's daemon and records the outbound half on the source's", async () => {
  const installed: InstallReviewHandoffRequest[] = [];
  const outbound: RecordOutboundHandoffRequest[] = [];
  const record = {
    version: 1,
    direction: "inbound",
    sourceRepoPath: "/src",
    targetRepoPath: "/dst",
    sourceTask: "s-task",
    sourceSession: "sess",
    sourceArtifact: "03-review.md",
    targetTask: "t-task",
    targetArtifact: "review-handoff-001.md",
    targetSession: "new",
    targetPhase: "build",
    createdAtMs: 9n,
  };
  vi.mocked(daemonTransport).mockImplementation((repo) =>
    repo === "/src"
      ? serve(
          [],
          undefined,
          {
            recordOutboundHandoff: async (req) => {
              outbound.push(req);
              return { applied: { cursor: cursor(2) } } as never;
            },
          },
          {
            readBlob: async function* () {
              yield { data: new TextEncoder().encode("findings") } as never;
            },
          },
        )
      : serve([], undefined, {
          installReviewHandoff: async (req) => {
            installed.push(req);
            return {
              applied: { cursor: cursor(2) },
              targetArtifact: "review-handoff-001.md",
              started: { session: { id: "new" }, start: "started", errors: [] },
              record,
              errors: [],
            } as never;
          },
        }),
  );
  const result = await sendReviewHandoff(handoffArgs);
  expect(installed).toHaveLength(1);
  expect(installed[0]).toMatchObject({
    sourceRepoPath: "/src",
    sourceSlug: "s-task",
    sourceArtifact: "03-review.md",
    sourceText: "findings",
    targetRepoPath: "/dst",
    targetSlug: "t-task",
    targetPhase: "build",
    start: true,
  });
  expect(outbound).toHaveLength(1);
  expect(outbound[0].sourceSlug).toBe("s-task");
  expect(outbound[0].record?.direction).toBe("outbound");
  expect(result).toMatchObject({ target_repo_path: "/dst", start: "started", target_artifact: "review-handoff-001.md", errors: [] });
  expect(result.source_record.direction).toBe("outbound");
  expect(result.target_record.direction).toBe("inbound");
  expect(result.target_session).toMatchObject({ id: "new" });
});

it("a failed outbound record is listed beside the other errors, and the target keeps its session", async () => {
  const record = {
    version: 1,
    direction: "inbound",
    sourceRepoPath: "/src",
    targetRepoPath: "/dst",
    sourceTask: "s-task",
    sourceSession: "sess",
    sourceArtifact: "03-review.md",
    targetTask: "t-task",
    targetArtifact: "r.md",
    targetSession: "new",
    targetPhase: "build",
    createdAtMs: 9n,
  };
  vi.mocked(daemonTransport).mockImplementation((repo) =>
    repo === "/src"
      ? serve(
          [],
          undefined,
          {
            recordOutboundHandoff: async () => {
              throw new ConnectError("disk full", Code.Internal);
            },
          },
          {
            readBlob: async function* () {
              yield { data: new TextEncoder().encode("x") } as never;
            },
          },
        )
      : serve([], undefined, {
          installReviewHandoff: async () =>
            ({ applied: { cursor: cursor(2) }, targetArtifact: "r.md", started: { session: { id: "new" }, start: "started", errors: [] }, record, errors: [] }) as never,
        }),
  );
  const result = await sendReviewHandoff(handoffArgs);
  expect(result.errors.map((e) => e.stage)).toEqual(["outbound_handoff_record"]);
  expect(result.target_session).toMatchObject({ id: "new" });
});

it("refuses a handoff between two machines before it asks either daemon", async () => {
  await expect(sendReviewHandoff({ ...handoffArgs, targetRepoPath: "alinery+ssh://host1/home/me/repo" })).rejects.toThrow("same machine");
  expect(daemonTransport).not.toHaveBeenCalled();
});
