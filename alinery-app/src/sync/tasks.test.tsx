import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createRouterTransport, type Transport } from "@connectrpc/connect";
import { renderHook, waitFor } from "@testing-library/react";
import { type BeginUploadRequest, BlobService, type CommitUploadRequest, type UploadChunkRequest } from "alinery-proto/alinery/v1/blobs_pb";
import { AppliedSchema } from "alinery-proto/alinery/v1/common_pb";
import { SyncService } from "alinery-proto/alinery/v1/sync_pb";
import { TaskService } from "alinery-proto/alinery/v1/tasks_pb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { archiveBoardTask } from "../archiveTask";
import { daemonTransport } from "../daemon/transport";
import { cursor, put, scriptedSync, snapshot, untilAborted } from "../test/daemonHarness";
import { taskEntity } from "../test/sessionDaemon";
import { useRepoTasks } from "./board";
import { addTaskAttachment, archiveTaskForRepo, createTaskForRepo, prepareTaskAttachments } from "./tasks";

const ipc = vi.hoisted(() => ({ preArchiveBackup: vi.fn(), readLocalFile: vi.fn() }));
vi.mock("../ipc", async () => (await import("../test/mockIpc")).mockIpc(ipc));
vi.mock("../toast", () => ({ toast: vi.fn() }));
vi.mock("../daemon/transport", () => ({ daemonTransport: vi.fn() }));

type Calls = { archive: number; begun: { target: unknown; size: bigint; sha256: string }[]; chunks: { offset: bigint; length: number }[]; committed: number };
let calls: Calls;
let onCreate: () => ReturnType<typeof created>;
let syncScript: Parameters<typeof scriptedSync>[0];

const created = (slug: string, seq: number) => ({
  applied: create(AppliedSchema, { cursor: cursor(seq) }),
  created: { task: taskEntity(slug, { name: slug, created: 10n }).value.value as never, creation: "ready", start: "not_requested", errors: [], sessions: [], executions: [] },
});

function serve() {
  const h = scriptedSync((req, call, signal) => syncScript(req, call, signal));
  const transport = createRouterTransport((router) => {
    router.service(SyncService, h.sync);
    router.service(TaskService, {
      archiveTask: () => (calls.archive++, {}),
      createTask: () => onCreate() as never,
    } as never);
    router.service(BlobService, {
      beginUpload: (req: BeginUploadRequest) => {
        calls.begun.push({ target: req.target?.target.case, size: req.size, sha256: req.sha256 });
        return { uploadId: `u${calls.begun.length}`, chunkSize: 256 * 1024 };
      },
      uploadChunk: (req: UploadChunkRequest) => (calls.chunks.push({ offset: req.offset, length: req.data.length }), {}),
      commitUpload: (req: CommitUploadRequest) => {
        calls.committed++;
        const target = calls.begun[calls.begun.length - 1]?.target;
        return {
          ref: {
            target: target === "staged" ? { case: "staged", value: { name: "f.bin", uploadId: req.uploadId } } : { case: "attachment", value: { taskSlug: "t", name: "f.bin" } },
          },
        } as never;
      },
    } as never);
  });
  vi.mocked(daemonTransport).mockReturnValue(transport as Transport);
}

beforeEach(() => {
  calls = { archive: 0, begun: [], chunks: [], committed: 0 };
  syncScript = async function* (_req, _call, signal) {
    yield snapshot([], 1);
    await untilAborted(signal);
  };
  onCreate = () => created("new-task", 5);
  serve();
});
afterEach(() => vi.resetAllMocks());

describe("archive", () => {
  it("a failing pre-archive backup leaves the task unarchived and the error reaches the caller", async () => {
    ipc.preArchiveBackup.mockRejectedValue(new Error("backup destination is full"));
    await expect(archiveTaskForRepo("/r", "t")).rejects.toThrow("backup destination is full");
    expect(calls.archive).toBe(0);
    const failure = await archiveBoardTask({ repo_path: "/r", slug: "t" }, false, () => {});
    expect(failure?.detail).toContain("backup destination is full");
    expect(calls.archive).toBe(0);
  });

  it("archives after the backup succeeded", async () => {
    ipc.preArchiveBackup.mockResolvedValue(undefined);
    await archiveTaskForRepo("/r", "t");
    expect(ipc.preArchiveBackup).toHaveBeenCalledWith("/r", "t");
    expect(calls.archive).toBe(1);
  });

  it("a daemon refusal after the backup is an Error with the daemon's words", async () => {
    ipc.preArchiveBackup.mockResolvedValue(undefined);
    vi.mocked(daemonTransport).mockReturnValue(
      createRouterTransport((router) => {
        router.service(TaskService, {
          archiveTask: () => {
            throw new ConnectError("task is busy", Code.FailedPrecondition);
          },
        } as never);
      }) as Transport,
    );
    await expect(archiveTaskForRepo("/r", "t")).rejects.toThrow("task is busy");
  });
});

describe("uploads", () => {
  it("a picked file is read here and uploaded in chunks by BeginUpload, never named by a path", async () => {
    const bytes = new Uint8Array(600 * 1024).fill(7);
    ipc.readLocalFile.mockResolvedValue(bytes.buffer);
    const out = await prepareTaskAttachments("/r", ["/home/me/f.bin", "https://example.test/x.png", "  "]);
    expect(out.attachment_urls).toEqual(["https://example.test/x.png"]);
    expect(out.attachments).toEqual([{ name: "f.bin", upload_id: "u1" }]);
    expect(calls.begun).toHaveLength(1);
    expect(calls.begun[0]).toMatchObject({ target: "staged", size: BigInt(bytes.length) });
    expect(calls.begun[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(calls.chunks.map((c) => c.length)).toEqual([256 * 1024, 256 * 1024, 88 * 1024]);
    expect(calls.chunks.map((c) => Number(c.offset))).toEqual([0, 256 * 1024, 512 * 1024]);
    expect(calls.committed).toBe(1);
  });

  it("a file over 25 MB is reported and nothing is uploaded; the rest still go", async () => {
    ipc.readLocalFile.mockImplementation(async (p: string) => (p === "/big" ? new ArrayBuffer(26 * 1024 * 1024) : new ArrayBuffer(4)));
    const out = await prepareTaskAttachments("/r", ["/big", "/small"]);
    expect(out.attachment_errors).toEqual(["/big - larger than 25 MB"]);
    expect(out.attachments).toHaveLength(1);
    expect(calls.begun).toHaveLength(1);
  });

  it("an unreadable file is reported as <entry> - <why>", async () => {
    ipc.readLocalFile.mockRejectedValue(new Error("permission denied"));
    const out = await prepareTaskAttachments("/r", ["/nope"]);
    expect(out.attachment_errors).toEqual(["/nope - permission denied"]);
    expect(calls.begun).toHaveLength(0);
  });

  it("a chat attachment dropped in the composer goes to the task's attachments through an upload", async () => {
    const name = await addTaskAttachment("/r", "t", "f.bin", new Uint8Array([1, 2, 3]));
    expect(name).toBe("f.bin");
    expect(calls.begun[0]).toMatchObject({ target: "attachment", size: 3n });
    expect(calls.chunks).toEqual([{ offset: 0n, length: 3 }]);
  });
});

describe("create shows the card at once", () => {
  it("the created task is on the board before the delta, and exactly once after it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    syncScript = async function* (_req, _call, signal) {
      yield snapshot([], 1);
      await gate;
      yield put(taskEntity("new-task", { name: "new-task", created: 10n }), 5);
      await untilAborted(signal);
    };
    serve();
    const { result } = renderHook(() => useRepoTasks("/pending-repo"));
    await waitFor(() => expect(result.current).toEqual([]));

    await createTaskForRepo({ repoPath: "/pending-repo", request: { name: "new-task", playbook: { reference: { scope: "bundled", key: "superdevelop" }, source: "" } } as never });
    expect(result.current?.map((t) => t.slug)).toEqual(["new-task"]);

    release();
    await waitFor(() => expect(result.current?.map((t) => t.slug)).toEqual(["new-task"]));
    await new Promise((r) => setTimeout(r, 30));
    expect(result.current?.filter((t) => t.slug === "new-task")).toHaveLength(1);
  });
});
