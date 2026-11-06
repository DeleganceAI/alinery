import { create } from "@bufbuild/protobuf";
import { createRouterTransport, type Transport } from "@connectrpc/connect";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { type BeginUploadRequest, BlobService, type UploadChunkRequest } from "alinery-proto/alinery/v1/blobs_pb";
import { type ArchiveChatThreadRequest, ChatService, type CreateChatThreadRequest } from "alinery-proto/alinery/v1/chat_pb";
import { AppliedSchema } from "alinery-proto/alinery/v1/common_pb";
import { type Entity, EntitySchema, SessionSchema } from "alinery-proto/alinery/v1/entities_pb";
import { type Change, ChangeSchema, SyncService } from "alinery-proto/alinery/v1/sync_pb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { daemonTransport } from "../daemon/transport";
import { cursor, frame, put, scriptedSync, snapshot, untilAborted } from "../test/daemonHarness";
import { CHAT_SCOPE, copyChatThreadAttachments, readChatThreadImage, useChatThreads, writeChatThreadAttachmentBytes } from "./chat";
import { acquireScope } from "./hooks";

const ipc = vi.hoisted(() => ({ readLocalFile: vi.fn(), listChatRepos: vi.fn(), prepareHostedInference: vi.fn(async () => {}) }));
vi.mock("../ipc", async () => (await import("../test/mockIpc")).mockIpc(ipc));
vi.mock("../daemon/transport", () => ({ daemonTransport: vi.fn() }));

/** The two rows a chat thread is: its root session, and the rail row beside it. */
const threadRows = (id: string, created: number, over: { name?: string; archived?: boolean; pinned?: boolean; superseded?: boolean } = {}): Entity[] => [
  create(EntitySchema, {
    key: `session/_/${id}`,
    value: {
      case: "session",
      value: create(SessionSchema, {
        id,
        generic: true,
        harness: "vinculum",
        created: BigInt(created),
        name: over.name,
        archived: over.archived ?? false,
        pinned: over.pinned ?? false,
      }),
    },
  }),
  create(EntitySchema, { key: `chat/_/${id}`, value: { case: "chatThread", value: { id, branchLabel: "main", checkout: true, superseded: over.superseded ?? false } } }),
];
const deleted = (key: string, seq: number) =>
  frame({ case: "delta", value: { changes: [create(ChangeSchema, { op: { case: "delete", value: key } }) as Change], cursor: cursor(seq) } as never });

type Calls = { subscribes: number; begun: { target: unknown; size: bigint }[]; chunks: number; archived: ArchiveChatThreadRequest[]; created: CreateChatThreadRequest[] };
let calls: Calls;
let script: Parameters<typeof scriptedSync>[0];

function serve() {
  const h = scriptedSync((req, call, signal) => {
    calls.subscribes += 1;
    return script(req, call, signal);
  });
  const transport = createRouterTransport((router) => {
    router.service(SyncService, h.sync);
    router.service(ChatService, {
      createChatThread: (req: CreateChatThreadRequest) => (
        calls.created.push(req), { applied: create(AppliedSchema, { cursor: cursor(9) }), started: { session: { id: "s-new" }, start: "started", errors: [] } }
      ),
      archiveChatThread: (req: ArchiveChatThreadRequest) => (calls.archived.push(req), { applied: create(AppliedSchema, { cursor: cursor(9) }) }),
    } as never);
    router.service(BlobService, {
      beginUpload: (req: BeginUploadRequest) => {
        calls.begun.push({ target: req.target?.target, size: req.size });
        return { uploadId: "u1", chunkSize: 256 * 1024 };
      },
      uploadChunk: (_req: UploadChunkRequest) => {
        calls.chunks += 1;
        return {};
      },
      commitUpload: () => ({ ref: { target: { case: "chatAttachment", value: { threadId: "s-a", name: "notes.pdf" } } } }) as never,
    } as never);
  });
  vi.mocked(daemonTransport).mockReturnValue(transport as Transport);
}

beforeEach(() => {
  calls = { subscribes: 0, begun: [], chunks: 0, archived: [], created: [] };
  script = async function* (_req, _call, signal) {
    yield snapshot(threadRows("s-old", 1), 1);
    await untilAborted(signal);
  };
  serve();
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("the chat rail", () => {
  it("a thread another window made, a rename and an archive reach the rail with no read in between", async () => {
    let gate!: () => void;
    const step = () => new Promise<void>((r) => (gate = r));
    script = async function* (_req, _call, signal) {
      yield snapshot(threadRows("s-old", 1), 1);
      await step();
      for (const e of threadRows("s-new", 5)) yield put(e, 2);
      await step();
      yield put(threadRows("s-new", 5, { name: "Fix the build" })[0], 3);
      await step();
      for (const e of threadRows("s-old", 1, { archived: true })) yield put(e, 4);
      await step();
      yield deleted("session/_/s-new", 5);
      await untilAborted(signal);
    };
    serve();
    const { result, rerender } = renderHook(({ archived }) => useChatThreads(["/r"], archived), { initialProps: { archived: false } });
    await waitFor(() => expect(result.current.map((t) => t.session.id)).toEqual(["s-old"]));

    gate();
    await waitFor(() => expect(result.current.map((t) => t.session.id)).toEqual(["s-new", "s-old"]));
    expect(result.current[0]).toMatchObject({ repo_path: "/r", name: null, branch_label: "main", checkout: true });

    gate();
    await waitFor(() => expect(result.current[0].name).toBe("Fix the build"));

    gate();
    await waitFor(() => expect(result.current.map((t) => t.session.id)).toEqual(["s-new"]));
    rerender({ archived: true });
    expect(result.current.map((t) => t.session.id)).toEqual(["s-new", "s-old"]);

    gate();
    await waitFor(() => expect(result.current.map((t) => t.session.id)).toEqual(["s-old"]));
    // One stream, opened once: nothing asked again for any of it.
    expect(calls.subscribes).toBe(1);
  });

  it("a thread another continues is left out, and pinned ones come first", async () => {
    script = async function* (_req, _call, signal) {
      yield snapshot([...threadRows("s-1", 1, { superseded: true }), ...threadRows("s-2", 2), ...threadRows("s-3", 3, { pinned: true }), ...threadRows("s-4", 4)], 1);
      await untilAborted(signal);
    };
    serve();
    const { result } = renderHook(() => useChatThreads(["/r"], false));
    await waitFor(() => expect(result.current).toHaveLength(3));
    expect(result.current.map((t) => t.session.id)).toEqual(["s-3", "s-4", "s-2"]);
  });

  it("no repo, no thread, and no stream", () => {
    const { result } = renderHook(() => useChatThreads(undefined, false));
    expect(result.current).toEqual([]);
    expect(calls.subscribes).toBe(0);
  });
});

describe("chat writes", () => {
  it("a write returns once the rail stream has the change it made", async () => {
    const { archiveChatThread, createChatThread } = await import("./chat");
    script = async function* (_req, _call, signal) {
      yield snapshot(threadRows("s-old", 1), 1);
      while (calls.created.length === 0) await new Promise((r) => setTimeout(r, 5));
      await new Promise((r) => setTimeout(r, 30));
      yield put(threadRows("s-new", 5)[0], 9);
      await untilAborted(signal);
    };
    serve();
    const { result } = renderHook(() => useChatThreads(["/r"], false));
    await waitFor(() => expect(result.current).toHaveLength(1));
    const started = await createChatThread({ repoPath: "/r", createWorktree: false });
    expect(started.session.id).toBe("s-new");
    expect(calls.created[0]).toMatchObject({ model: "", createWorktree: false });
    // The hosted-model credentials the daemon reads at spawn are refreshed in the shell first.
    expect(ipc.prepareHostedInference).toHaveBeenCalledWith("");
    // The reply came back after cursor 9 reached the replica, so the new row is already there.
    const { replica, release } = acquireScope("/r", CHAT_SCOPE);
    expect(replica.get("session/_/s-new")).toBeDefined();
    release();
    await archiveChatThread("/r", "s-old", true);
    expect(calls.archived[0]).toMatchObject({ threadId: "s-old", removeWorktree: true });
  });
});

describe("chat attachments", () => {
  it("bytes dropped in the composer are uploaded to the thread by BeginUpload", async () => {
    const name = await writeChatThreadAttachmentBytes("/r", "s-a", "notes.pdf", new Uint8Array([1, 2, 3]));
    expect(name).toBe("notes.pdf");
    expect(calls.begun).toEqual([{ target: { case: "chatAttachment", value: expect.objectContaining({ threadId: "s-a", name: "notes.pdf" }) }, size: 3n }]);
    expect(calls.chunks).toBe(1);
  });

  it("a picked path is read in the shell and uploaded as bytes, never handed to the daemon as a path", async () => {
    ipc.readLocalFile.mockImplementation(async (p: string) => {
      if (p === "/nope") throw new Error("permission denied");
      return new Uint8Array([9, 9]).buffer;
    });
    const out = await copyChatThreadAttachments("/r", "s-a", ["/home/me/notes.pdf", "  ", "/nope"]);
    expect(out).toEqual({ copied: ["notes.pdf"], failures: ["/nope - permission denied"] });
    expect(calls.begun).toHaveLength(1);
    expect(JSON.stringify(calls.begun[0].target)).not.toContain("/home/me");
  });

  it("a file over 25 MB is refused before anything is sent", async () => {
    await expect(writeChatThreadAttachmentBytes("/r", "s-a", "big.bin", new Uint8Array(26 * 1024 * 1024))).rejects.toThrow("larger than 25 MB");
    expect(calls.begun).toHaveLength(0);
  });

  it("an image is refused by its name before any bytes are fetched", async () => {
    await expect(readChatThreadImage("/r", "s-a", "notes.pdf")).rejects.toThrow("not a chat image");
  });
});
